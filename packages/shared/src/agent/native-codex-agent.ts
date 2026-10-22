import { createHash } from 'node:crypto';
import type { AgentEvent, AgentEventUsage } from '@tokenbird/core/types';
import type { FileAttachment } from '../utils/files.ts';
import type { Workspace } from '../config/storage.ts';
import { getBrowserToolEnabled, getLlmConnection } from '../config/storage.ts';
import { getModelPromptSettings, resolveAutoCompactionTokenLimit } from '../config/llm-connections.ts';
import { getCoAuthorPreference } from '../config/preferences.ts';
import { getCredentialManager, CredentialChangedError } from '../credentials/index.ts';
import { refreshChatGptTokens } from '../auth/chatgpt-oauth.ts';
import { getValidTokenNestCredentials } from '../auth/tokennest-oauth.ts';
import { getBackendRuntime } from './backend/internal/driver-types.ts';
import { CODEX_CUSTOM_API_KEY_ENV, CODEX_CUSTOM_PROVIDER, customCodexTransport } from '../codex/custom-transport.ts';
import { getModelById } from '../config/models.ts';
import { COMPACT_AGENT } from '../agents/types.ts';
import { getSessionPlansPath } from '../sessions/storage.ts';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getConfigDir } from '../config/paths.ts';
import { getSystemPrompt } from '../prompts/system.ts';
import { NativeCodexAppServerClient, type NativeCodexServerRequest } from '../codex/native-app-server-client.ts';
import type {
  AskForApproval,
  CommandApprovalParams,
  DynamicToolCallParams,
  DynamicToolSpec,
  FileChangeApprovalParams,
  ItemNotification,
  JsonValue,
  PermissionsApprovalParams,
  ReasoningEffort,
  SandboxMode,
  TextDeltaNotification,
  ThreadItem,
  ThreadResponse,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnStartResponse,
  UserInput,
} from '../codex/native-protocol.ts';
import type { NativeCodexBinary } from '../codex/binary-resolver.ts';
import type { BackendConfig, ChatOptions, PostInitResult, SdkMcpServerConfig } from './backend/types.ts';
import { AbortReason } from './backend/types.ts';
import { BaseAgent } from './base-agent.ts';
import { EventQueue } from './backend/event-queue.ts';
import { getSessionToolProxyDefs } from './backend/session-tool-defs.ts';
import { getSessionExecutionPolicy, hasSessionExecutionPolicy } from './core/session-execution-policy.ts';
import { AgentPluginHostTools, type HostToolResult } from '../agent-plugins/host-tools.ts';
import { LOCAL_AGENT_HOST_TOOLS } from '../agent-plugins/local-tools.ts';
import { loadBackendFrameworkConfiguration } from '../agent-plugins/framework-storage.ts';
import { frameworkToolBlockReason } from '../agent-plugins/framework-tool-policy.ts';
import { assertSuperAgentTools, filterSuperAgentTools } from './core/browser-tool-policy.ts';
import { CODEX_HOST_EXECUTION_CONFIG, codexHostExecutionArgs, createCodexHostHome } from '../codex/host-execution.ts';
import { LLM_QUERY_TIMEOUT_MS, withTimeout, type LLMQueryRequest, type LLMQueryResult } from './llm-tool.ts';
import { createAgentError, parseError } from './errors.ts';
import { SourceActivationDrainController } from './source-activation-drain.ts';

const DEFAULT_NATIVE_CODEX_MODEL = 'gpt-5.2-codex';
const MAX_TOOL_OUTPUT_CHARS = 100_000;
const TOKEN_REFRESH_TIMEOUT_MS = 30_000;

interface PendingPermission {
  resolve: (allowed: boolean, alwaysAllow: boolean) => void;
  deny: () => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function bareModelId(model: string | undefined): string | null {
  if (!model) return null;
  return model.startsWith('pi/') ? model.slice(3) : model.startsWith('openai/') ? model.slice(7) : model;
}

function base64UrlDecode(segment: string): string {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='), 'base64').toString('utf8');
}

/** Extract the workspace id required by app-server external ChatGPT auth. */
export function extractChatGptAccountId(accessToken: string): string | null {
  try {
    const payload = JSON.parse(base64UrlDecode(accessToken.split('.')[1] ?? '')) as Record<string, unknown>;
    const auth = asRecord(payload['https://api.openai.com/auth']);
    const candidates = [
      auth.chatgpt_account_id,
      auth.account_id,
      payload.chatgpt_account_id,
      payload.account_id,
    ];
    for (const value of candidates) if (typeof value === 'string' && value.trim()) return value;
  } catch { /* malformed or opaque access token */ }
  return null;
}

/** Native Codex app-server backend. The compatibility fallback remains CodexCompatibilityAgent. */
export class NativeCodexAgent extends BaseAgent {
  private static tokenRefreshByConnection = new Map<string, Promise<{ accessToken: string; chatgptAccountId: string }>>();
  protected backendName = 'Codex app-server (native, experimental)';
  private client: NativeCodexAppServerClient | null = null;
  private pendingClient: NativeCodexAppServerClient | null = null;
  private connecting: Promise<NativeCodexAppServerClient> | null = null;
  private clientGeneration = 0;
  private disposed = false;
  private codexThreadId: string | null;
  private currentTurnId: string | null = null;
  private processing = false;
  private abortReason?: AbortReason;
  private queue = new EventQueue();
  private commandOutput = new Map<string, string>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private readonly hostTools: AgentPluginHostTools;
  private clientHostExecution = false;
  private hostHome: Promise<string> | null = null;
  private toolSignature = '';
  private toolsChanged = false;
  /** Dynamic tools belong to the app-server process that started the thread. */
  private threadClient: NativeCodexAppServerClient | null = null;
  private authenticated = false;
  private authenticatedCredentialFingerprint: string | null = null;
  private clientTransportFingerprint: string | null = null;
  private clientCredentials = new WeakMap<NativeCodexAppServerClient, string | null>();
  private nativeToolAliases = new Map<string, string>();
  private ignoredTurnIds = new Set<string>();
  private lastUsage?: AgentEventUsage;

  constructor(config: BackendConfig, private readonly binary: NativeCodexBinary) {
    const model = config.model || DEFAULT_NATIVE_CODEX_MODEL;
    super(config, model, getModelById(model)?.contextWindow);
    this.hostTools = new AgentPluginHostTools(this, config, this._sessionId, async (name, input) => {
      if (name === 'call_llm') return { content: (await this.preExecuteCallLlm(input)).text, isError: false };
      if (name === 'spawn_session') return { content: JSON.stringify(await this.preExecuteSpawnSession(input)), isError: false };
      return undefined;
    });
    this._supportsBranching = false;
    this.codexThreadId = config.session?.sdkSessionId ?? null;
    if (!config.isHeadless) this.startConfigWatcher();
  }

  protected override debug(message: string): void {
    this.onDebug?.(`[Codex native] ${message}`);
  }

  getProcessId(): number | undefined { return this.client?.processId; }
  override getSessionId(): string | null { return this.codexThreadId; }
  override setSessionId(sessionId: string | null): void {
    if (sessionId !== this.codexThreadId) this.threadClient = null;
    this.codexThreadId = sessionId;
  }
  isProcessing(): boolean { return this.processing; }

  override async postInit(): Promise<PostInitResult> {
    try {
      const client = await this.ensureClient();
      const authInjected = await this.authenticateClient(client);
      this.authenticated = authInjected;
      return {
        authInjected,
        authWarning: authInjected ? undefined : 'Codex app-server has no usable OpenAI authentication. Configure the connection or run codex login.',
        authWarningLevel: authInjected ? undefined : 'error',
      };
    } catch (error) {
      return {
        authInjected: false,
        authWarning: `Native Codex app-server failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
        authWarningLevel: 'error',
      };
    }
  }

  private async ensureClient(): Promise<NativeCodexAppServerClient> {
    if (this.disposed) throw new Error('Native Codex agent has been disposed');
    if (this.usesHostExecution() && !this.binary.testedProtocol) throw new Error('Policy-enforced native Codex requires the tested 0.154.x protocol; install the supported CLI.');
    if (this.connecting) return this.connecting;
    const env = await this.buildCodexEnvironment();
    const configArgs = this.buildCodexConfigArgs(env);
    const transportFingerprint = createHash('sha256').update(JSON.stringify([configArgs,
      env?.[CODEX_CUSTOM_API_KEY_ENV], Object.entries(env ?? {}).filter(([key]) => key.startsWith('TOKENBIRD_CODEX_HEADER_'))])).digest('hex');
    if (this.disposed) throw new Error('Native Codex agent has been disposed');
    if (this.connecting) return this.connecting;
    if (getBackendRuntime(this.config).baseUrl && this.client?.isConnected && this.clientTransportFingerprint !== transportFingerprint) await this.disconnectClient();
    if (this.client?.isConnected && this.clientHostExecution !== this.usesHostExecution()) await this.disconnectClient();
    if (this.client?.isConnected) return this.client;
    if (this.connecting) return this.connecting;
    const generation = ++this.clientGeneration;
    this.connecting = (async () => {
      this.clientHostExecution = this.usesHostExecution();
      const client = new NativeCodexAppServerClient({
        codexPath: this.binary.path,
        workDir: this.clientHostExecution ? env!.CODEX_HOME! : this.workingDirectory,
        requestTimeoutMs: 30_000,
        onDebug: message => this.debug(message),
        env,
        configArgs,
      });
      this.clientCredentials.set(client, env?.[CODEX_CUSTOM_API_KEY_ENV]
        ? createHash('sha256').update(env[CODEX_CUSTOM_API_KEY_ENV]!).digest('hex') : null);
      this.pendingClient = client;
      client.on('notification', (method: string, params: unknown) => {
        if (!this.ownsClient(client)) return;
        this.handleNotification(method, params);
      });
      client.on('serverRequest', (request: NativeCodexServerRequest) => {
        if (!this.ownsClient(client)) {
          void client.respondError(request.id, 'Codex client is no longer active').catch(() => undefined);
          return;
        }
        void this.handleServerRequest(client, request).catch(error => {
          this.debug(`Server request ${request.method} failed: ${error instanceof Error ? error.message : String(error)}`);
          void client.respondError(request.id, 'TokenBird could not process this request').catch(() => undefined);
        });
      });
      client.on('error', (error: Error) => {
        if (!this.ownsClient(client)) return;
        this.debug(error.message);
        if (this.client === client) this.client = null;
        if (this.pendingClient === client) this.pendingClient = null;
        this.authenticated = false;
        for (const pending of this.pendingPermissions.values()) pending.deny();
        this.pendingPermissions.clear();
        if (this.processing) {
          this.queue.enqueue({ type: 'error', message: error.message });
          this.queue.complete();
        }
      });
      try {
        await client.connect();
        if (this.disposed || generation !== this.clientGeneration) {
          await client.disconnect().catch(() => undefined);
          throw new Error('Native Codex connection was cancelled');
        }
        this.pendingClient = null;
        this.client = client;
        this.clientTransportFingerprint = transportFingerprint;
        this.debug(`Connected with codex-cli ${this.binary.version} (${this.binary.source})`);
        return client;
      } catch (error) {
        if (this.pendingClient === client) this.pendingClient = null;
        await client.disconnect().catch(() => undefined);
        throw error;
      }
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private ownsClient(client: NativeCodexAppServerClient): boolean {
    return !this.disposed && (this.client === client || this.pendingClient === client);
  }

  private async buildCodexEnvironment(): Promise<Record<string, string> | undefined> {
    const runtime = getBackendRuntime(this.config);
    let custom: ReturnType<typeof customCodexTransport>;
    if (runtime.baseUrl) {
      const slug = this.config.connectionSlug ?? this.config.session?.llmConnection;
      let credential: string | undefined;
      if (this.config.authType !== 'none') {
        if (!slug) throw new Error('A connection is required for Codex Responses credentials.');
        if (this.config.authType === 'oauth' && runtime.oauthProvider === 'tokennest') {
          credential = (await getValidTokenNestCredentials(slug, getCredentialManager()))?.accessToken;
        } else if (['api_key', 'api_key_with_endpoint'].includes(this.config.authType ?? '')) {
          credential = await getCredentialManager().getLlmApiKey(slug) ?? undefined;
        }
        if (!credential) throw this.missingConnectionCredentials(slug);
      }
      custom = customCodexTransport(runtime, credential);
    }
    if (this.usesHostExecution()) {
      const managed = !!custom || ['api_key', 'api_key_with_endpoint', 'oauth'].includes(this.config.authType ?? '');
      this.hostHome ??= createCodexHostHome(join(getConfigDir(), 'codex', 'controlled'), this.workingDirectory,
        managed ? undefined : process.env.CODEX_HOME || join(homedir(), '.codex'));
      return { CODEX_HOME: await this.hostHome, ...custom?.env };
    }
    // Keep connection-owned credentials out of the user's global Codex home.
    // authType=none deliberately keeps the global home so an existing `codex login`
    // can be used by an explicitly unmanaged connection.
    if (!custom && !['api_key', 'api_key_with_endpoint', 'oauth'].includes(this.config.authType ?? '')) return undefined;
    // Managed credentials and Codex configuration are connection-owned and
    // persistent, but fully isolated from the user's native ~/.codex profile.
    // A stable connection home also avoids creating a fresh auth/config copy
    // for every TokenBird session.
    const connectionKey = (this.config.connectionSlug ?? 'managed')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'managed';
    const codexHome = join(getConfigDir(), 'codex', 'connections', connectionKey);
    await mkdir(codexHome, { recursive: true });
    return { CODEX_HOME: codexHome, ...custom?.env };
  }

  private buildCodexConfigArgs(env?: Record<string, string>): string[] {
    const custom = customCodexTransport(getBackendRuntime(this.config), env?.[CODEX_CUSTOM_API_KEY_ENV]);
    return [...(this.usesHostExecution() ? codexHostExecutionArgs() : []), ...(custom?.configArgs ?? [])];
  }

  private missingConnectionCredentials(slug: string): Error {
    return new Error(this.config.authType === 'oauth'
      ? `OAuth credentials are unavailable for connection "${slug}". Please sign in again.`
      : `Stored credentials are unavailable. Update Credentials in Settings before the next request. Connection: "${slug}".`);
  }

  private async authenticateClient(client: NativeCodexAppServerClient): Promise<boolean> {
    if (getBackendRuntime(this.config).baseUrl) {
      // A custom provider reads its own env_key and must never log into OpenAI.
      this.authenticatedCredentialFingerprint = this.clientCredentials.get(client) ?? null;
      return this.config.authType === 'none' || !!this.authenticatedCredentialFingerprint;
    }
    const slug = this.config.connectionSlug ?? this.config.session?.llmConnection;
    const credentials = getCredentialManager();
    if (slug && (this.config.authType === 'api_key' || this.config.authType === 'api_key_with_endpoint')) {
      const apiKey = await credentials.getLlmApiKey(slug);
      if (!apiKey) return false;
      await client.request('account/login/start', { type: 'apiKey', apiKey });
      this.authenticatedCredentialFingerprint = createHash('sha256').update(apiKey).digest('hex');
      return true;
    }
    if (slug && this.config.authType === 'oauth') {
      const oauth = await credentials.getLlmOAuth(slug);
      if (!oauth?.accessToken) return false;
      const chatgptAccountId = extractChatGptAccountId(oauth.accessToken);
      if (!chatgptAccountId) return false;
      await client.request('account/login/start', {
        type: 'chatgptAuthTokens',
        accessToken: oauth.accessToken,
        chatgptAccountId,
        chatgptPlanType: null,
      });
      this.authenticatedCredentialFingerprint = createHash('sha256').update(oauth.accessToken).digest('hex');
      return true;
    }
    const result = await client.request<{ account: unknown | null; requiresOpenaiAuth: boolean }>('account/read', {});
    return !!result.account || !result.requiresOpenaiAuth;
  }

  private async synchronizeStoredAuthBeforeTurn(client: NativeCodexAppServerClient): Promise<void> {
    const slug = this.config.connectionSlug ?? this.config.session?.llmConnection;
    if (!slug || !['api_key', 'api_key_with_endpoint', 'oauth'].includes(this.config.authType ?? '')) return;
    const id = { type: this.config.authType === 'oauth' ? 'llm_oauth' as const : 'llm_api_key' as const, connectionSlug: slug };
    const snapshot = await getCredentialManager().getSnapshot(id);
    if (!snapshot.credential?.value) {
      this.authenticated = false;
      throw this.missingConnectionCredentials(slug);
    }
    const fingerprint = createHash('sha256').update(snapshot.credential.value).digest('hex');
    if (getBackendRuntime(this.config).baseUrl && fingerprint !== this.clientCredentials.get(client)) throw new CredentialChangedError();
    if (fingerprint !== this.authenticatedCredentialFingerprint) this.authenticated = await this.authenticateClient(client);
    const current = await getCredentialManager().getSnapshot(id);
    if (!current.credential?.value || createHash('sha256').update(current.credential.value).digest('hex') !== this.authenticatedCredentialFingerprint) {
      this.authenticated = false;
      throw new CredentialChangedError();
    }
  }

  private buildDynamicTools(): DynamicToolSpec[] {
    let defs = [...(this.usesHostExecution() ? LOCAL_AGENT_HOST_TOOLS : []), ...getSessionToolProxyDefs()];
    if (!getBrowserToolEnabled()) defs = defs.filter(def => def.name !== 'mcp__session__browser_tool');
    const sourceDefs = this.config.mcpPool?.getProxyToolDefs() ?? [];
    this.nativeToolAliases.clear();
    const role = getSessionExecutionPolicy(this._sessionId)?.role;
    const visibleTools = filterSuperAgentTools([...defs, ...sourceDefs], role).filter(def => !frameworkToolBlockReason(this._sessionId, def.name));
    assertSuperAgentTools(visibleTools, role);
    return visibleTools.map(def => {
      // app-server reserves the mcp__ prefix for its own configured MCP servers.
      const nativeName = def.name.startsWith('mcp__') ? `tokenbird__${def.name.slice('mcp__'.length)}` : `tokenbird__${def.name}`;
      this.nativeToolAliases.set(nativeName, def.name);
      return {
        type: 'function' as const,
        name: nativeName,
        description: def.description || `TokenBird tool ${def.name}`,
        inputSchema: def.inputSchema as JsonValue,
      };
    });
  }

  private usesHostExecution(): boolean {
    const files = loadBackendFrameworkConfiguration('codex')?.features.files;
    return hasSessionExecutionPolicy(this._sessionId) || files === 'host' || files === 'disabled';
  }

  private threadPolicy(): { approvalPolicy: AskForApproval; sandbox: SandboxMode } {
    if (this.usesHostExecution()) return { approvalPolicy: 'never', sandbox: 'read-only' };
    switch (this.getPermissionMode()) {
      case 'safe': return { approvalPolicy: 'never', sandbox: 'read-only' };
      case 'allow-all': return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
      default: return { approvalPolicy: 'on-request', sandbox: 'read-only' };
    }
  }

  private buildSystemPrompt(): string {
    const system = getSystemPrompt(
      undefined,
      this.config.debugMode,
      this.config.workspace.rootPath,
      this.config.session?.workingDirectory,
      this.config.systemPromptPreset,
      this.backendName,
      getCoAuthorPreference(),
      undefined,
      this.config.agentPrompt,
      this.config.modelPromptSettings,
      'codex',
    );
    return [system, ...this.promptBuilder.buildStableContextParts(), this.usesHostExecution()
      ? 'Run the Codex reasoning loop using TokenBird dynamic tools. File reads, edits, shell commands, sources and browser operations must use the provided tokenbird__ tools; the host applies node permissions and the configured execution environment.' : ''].filter(Boolean).join('\n\n');
  }

  private buildUserInput(message: string, attachments?: FileAttachment[]): UserInput[] {
    const plansFolderPath = getSessionPlansPath(this.config.workspace.rootPath, this._sessionId);
    const volatile = this.promptBuilder.buildVolatileContextParts(
      { plansFolderPath },
      this.sourceManager.formatSourceState(),
    );
    const attachmentText: string[] = [];
    const input: UserInput[] = [];
    for (const attachment of attachments ?? []) {
      const path = attachment.storedPath || attachment.path;
      if (attachment.mimeType?.startsWith('image/') && path) {
        input.push({ type: 'localImage', path });
      } else if (attachment.mimeType?.startsWith('image/') && attachment.base64) {
        input.push({ type: 'image', url: `data:${attachment.mimeType};base64,${attachment.base64}` });
      } else if (path) {
        attachmentText.push(`[Attached file: ${attachment.name}]\n[Stored at: ${path}]${attachment.markdownPath ? `\n[Markdown version: ${attachment.markdownPath}]` : ''}`);
      }
    }
    input.unshift({ type: 'text', text: [...volatile, ...attachmentText, message].filter(Boolean).join('\n\n'), text_elements: [] });
    return input;
  }

  private async ensureThread(client: NativeCodexAppServerClient): Promise<string> {
    const connection = this.config.connectionSlug ? getLlmConnection(this.config.connectionSlug) ?? undefined : undefined;
    if (this.config.connectionSlug) this.config.modelPromptSettings = getModelPromptSettings(connection, this._model);
    const tools = this.buildDynamicTools();
    const connectionModel = connection?.models?.find(model => (typeof model === 'string' ? model : model.id) === this._model);
    const contextWindow = (typeof connectionModel === 'object' ? connectionModel.contextWindow : undefined)
      ?? getModelById(this._model)?.contextWindow;
    const compactLimit = resolveAutoCompactionTokenLimit(this.config.modelPromptSettings, contextWindow);
    const hostExecution = this.usesHostExecution();
    // Developer instructions are fixed at thread creation. Refresh the thread
    // (with the existing recovery context) when commit attribution changes.
    const signature = JSON.stringify({ tools, compactLimit, hostExecution, includeCoAuthoredBy: getCoAuthorPreference() });
    if (this.codexThreadId && this.threadClient === client && !this.toolsChanged && signature === this.toolSignature) {
      return this.codexThreadId;
    }
    if (this.codexThreadId) {
      // thread/resume cannot accept dynamicTools. After a process restart its
      // restored thread has no TokenBird tools, even if MCP sources are connected.
      this.debug(`Starting a fresh Codex thread with ${tools.length} dynamic tools (${this.threadClient !== client ? 'app-server changed' : 'tool set changed'})`);
      this.codexThreadId = null;
      this.threadClient = null;
      this.config.onSdkSessionIdCleared?.();
    }

    const policy = this.threadPolicy();
    this.debug(`Registering ${tools.length} Codex dynamic tools, including ${this.config.mcpPool?.getProxyToolDefs().length ?? 0} MCP source tools`);
    const response = await client.request<ThreadResponse>('thread/start', {
      model: bareModelId(this._model),
      ...(getBackendRuntime(this.config).baseUrl ? { modelProvider: CODEX_CUSTOM_PROVIDER } : {}),
      config: {
        ...(hostExecution ? CODEX_HOST_EXECUTION_CONFIG : {}),
        ...(compactLimit !== undefined ? { model_auto_compact_token_limit: compactLimit } : {}),
        compact_prompt: COMPACT_AGENT.prompt,
      },
      ...(hostExecution ? { environments: [] } : {}),
      cwd: this.workingDirectory,
      runtimeWorkspaceRoots: [this.config.workspace.rootPath],
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      developerInstructions: this.buildSystemPrompt(),
      dynamicTools: tools,
      experimentalRawEvents: false,
    });
    this.toolSignature = signature;
    this.toolsChanged = false;
    this.codexThreadId = response.thread.id;
    this.threadClient = client;
    this.config.onSdkSessionIdUpdate?.(response.thread.id);
    return response.thread.id;
  }

  protected async *chatImpl(message: string, attachments?: FileAttachment[], options?: ChatOptions): AsyncGenerator<AgentEvent> {
    if (this.processing) {
      yield { type: 'error', message: 'Codex is already processing a turn' };
      yield { type: 'complete' };
      return;
    }
    this.processing = true;
    this.abortReason = undefined;
    this.queue.reset();
    this.commandOutput.clear();
    this.consumePendingSourceActivationRestart();
    this.lastUsage = undefined;
    try {
      const client = await this.ensureClient();
      await this.synchronizeStoredAuthBeforeTurn(client);
      if (!this.authenticated) this.authenticated = await this.authenticateClient(client);
      if (!this.authenticated) throw new Error('Codex authentication is unavailable');
      const previousThreadId = this.codexThreadId;
      const threadId = await this.ensureThread(client);
      let effectiveMessage = message;
      if ((previousThreadId && previousThreadId !== threadId) || options?.isRetry) {
        const recovery = this.buildRecoveryContext();
        if (recovery) effectiveMessage = `${recovery}\n${message}`;
      }
      const policy = this.threadPolicy();
      // Reject late notifications from the preceding turn while turn/start is
      // in flight. The protocol emits turn/started before item notifications.
      this.currentTurnId = 'pending';
      if (/^\/compact(?:\s|$)/i.test(message.trim()) && !attachments?.length) {
        // Native compaction starts a turn asynchronously; it must not be sent
        // as a regular task, which can cause the model to execute history.
        yield { type: 'info', message: 'Compacting context (target: retain approximately 10% of conversation tokens)' };
        await client.request('thread/compact/start', { threadId });
      } else {
        const response = await client.request<TurnStartResponse>('turn/start', {
          threadId,
          input: this.buildUserInput(effectiveMessage, attachments),
          cwd: this.workingDirectory,
          runtimeWorkspaceRoots: [this.config.workspace.rootPath],
          approvalPolicy: policy.approvalPolicy,
          model: bareModelId(this._model),
          effort: this.reasoningEffort(options?.thinkingOverride),
          ...(this.usesHostExecution() ? { environments: [] } : {}),
        });
        this.currentTurnId = response.turn.id;
        if (this.abortReason) {
          this.rememberIgnoredTurn(response.turn.id);
          void client.request('turn/interrupt', { threadId, turnId: response.turn.id }).catch(() => undefined);
          return;
        }
      }

      // Native dynamic tools can complete in parallel. Keep yielding sibling
      // tool results before restarting for a newly activated source, matching
      // the Pi backend's journal-safe drain behavior.
      const sourceActivationDrain = new SourceActivationDrainController('fire-on-non-tool-result');
      for await (const event of this.queue.drain()) {
        const preFire = sourceActivationDrain.shouldFireBeforeEvent(event);
        if (preFire) {
          yield preFire;
          this.forceAbort(AbortReason.SourceActivated);
          return;
        }
        if (sourceActivationDrain.observe(event, () => this.consumePendingSourceActivationRestart())) {
          yield event;
          continue;
        }
        yield event;
      }
      const sourceActivationFireAtEnd = sourceActivationDrain.shouldFireAtBoundary();
      if (sourceActivationFireAtEnd) {
        yield sourceActivationFireAtEnd;
        this.forceAbort(AbortReason.SourceActivated);
      }
    } catch (error) {
      if (!this.abortReason) {
        const parsed = parseError(error instanceof Error ? error : new Error(String(error)));
        if (parsed.code !== 'unknown_error') yield { type: 'typed_error', error: parsed };
        else yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
        yield { type: 'complete' };
      }
    } finally {
      this.hostTools.cancel();
      this.processing = false;
      this.currentTurnId = null;
    }
  }

  private reasoningEffort(override?: BackendConfig['thinkingLevel']): ReasoningEffort {
    const level = override ?? this._thinkingLevel;
    switch (level) {
      case 'off': return 'minimal';
      case 'low': return 'low';
      case 'high': return 'high';
      case 'xhigh': return 'xhigh';
      case 'max': return 'ultra';
      default: return 'medium';
    }
  }

  private handleNotification(method: string, raw: unknown): void {
    const params = asRecord(raw);
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    if (threadId && this.codexThreadId && threadId !== this.codexThreadId) return;
    const eventTurnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    const turnRecord = asRecord(params.turn);
    const nestedTurnId = typeof turnRecord.id === 'string' ? turnRecord.id : undefined;
    const notificationTurnId = eventTurnId ?? nestedTurnId;

    // Notifications may outlive an interrupted turn. Never let a late
    // turn/started replace the active turn or enqueue data into a later chat.
    if (!this.processing) return;
    if (notificationTurnId && this.ignoredTurnIds.has(notificationTurnId)) return;
    if (method === 'turn/started') {
      if (!nestedTurnId) return;
      if (this.currentTurnId !== 'pending' && this.currentTurnId !== nestedTurnId) return;
    } else if (notificationTurnId && notificationTurnId !== this.currentTurnId) {
      return;
    }
    switch (method) {
      case 'turn/started': {
        this.currentTurnId = nestedTurnId!;
        break;
      }
      case 'item/started':
        this.handleItemStarted(raw as ItemNotification);
        break;
      case 'item/completed':
        this.handleItemCompleted(raw as ItemNotification);
        break;
      case 'item/agentMessage/delta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const delta = raw as TextDeltaNotification;
        if (delta.delta) this.queue.enqueue({ type: 'text_delta', text: delta.delta, turnId: delta.itemId });
        break;
      }
      case 'item/commandExecution/outputDelta': {
        const delta = raw as TextDeltaNotification;
        const previous = this.commandOutput.get(delta.itemId) ?? '';
        if (previous.length < MAX_TOOL_OUTPUT_CHARS) this.commandOutput.set(delta.itemId, (previous + delta.delta).slice(0, MAX_TOOL_OUTPUT_CHARS));
        break;
      }
      case 'thread/tokenUsage/updated':
        this.handleUsage(raw as ThreadTokenUsageUpdatedNotification);
        break;
      case 'turn/plan/updated':
        this.handlePlan(params);
        break;
      case 'thread/compacted':
        this.resetPrerequisiteState();
        this.queue.enqueue({ type: 'info', message: 'Compacted context to fit within limits' });
        break;
      case 'warning':
      case 'configWarning':
        this.queue.enqueue({ type: 'info', message: String(params.message ?? params.summary ?? 'Codex warning') });
        break;
      case 'error': {
        const nested = asRecord(params.error);
        this.queue.enqueue({ type: 'error', message: String(nested.message ?? params.message ?? 'Codex app-server error') });
        break;
      }
      case 'turn/completed': {
        const completed = raw as TurnCompletedNotification;
        if (completed.turn.id !== this.currentTurnId) return;
        if (completed.turn.status === 'failed') {
          const message = completed.turn.error?.message ?? 'Codex turn failed without error details. Please retry.';
          const parsed = parseError(new Error(message));
          this.queue.enqueue({ type: 'typed_error', error: parsed });
        } else if (completed.turn.status === 'interrupted' && !this.abortReason) {
          const error = createAgentError('service_error');
          error.message = 'Codex stopped before completing the response. Please retry to continue.';
          this.queue.enqueue({ type: 'typed_error', error });
        }
        this.usageTracker.recordTurnComplete(this.lastUsage);
        this.queue.enqueue({ type: 'complete', usage: this.lastUsage });
        this.queue.complete();
        this.rememberIgnoredTurn(completed.turn.id);
        break;
      }
    }
  }

  private rememberIgnoredTurn(turnId: string): void {
    this.ignoredTurnIds.add(turnId);
    while (this.ignoredTurnIds.size > 32) {
      const oldest = this.ignoredTurnIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.ignoredTurnIds.delete(oldest);
    }
  }

  private handleItemStarted(notification: ItemNotification): void {
    const item = notification.item;
    switch (item.type) {
      case 'commandExecution':
        this.queue.enqueue({ type: 'tool_start', toolUseId: item.id, toolName: 'Bash', input: { command: item.command, cwd: item.cwd }, turnId: notification.turnId });
        break;
      case 'fileChange':
        this.queue.enqueue({ type: 'tool_start', toolUseId: item.id, toolName: 'Edit', input: { changes: item.changes }, turnId: notification.turnId });
        break;
      case 'mcpToolCall':
        this.queue.enqueue({ type: 'tool_start', toolUseId: item.id, toolName: `mcp__${item.server}__${item.tool}`, input: asRecord(item.arguments), turnId: notification.turnId });
        break;
      case 'dynamicToolCall':
        this.queue.enqueue({ type: 'tool_start', toolUseId: item.id, toolName: this.nativeToolAliases.get(item.tool) ?? item.tool, input: asRecord(item.arguments), turnId: notification.turnId });
        break;
      case 'webSearch':
        this.queue.enqueue({ type: 'tool_start', toolUseId: item.id, toolName: 'WebSearch', input: { query: item.query }, turnId: notification.turnId });
        break;
      case 'imageView':
        this.queue.enqueue({ type: 'tool_start', toolUseId: item.id, toolName: 'ImageView', input: { path: item.path }, turnId: notification.turnId });
        break;
    }
  }

  private handleItemCompleted(notification: ItemNotification): void {
    const item = notification.item;
    switch (item.type) {
      case 'agentMessage':
        // Older models omit phase; preserve their final-answer behavior.
        this.queue.enqueue({ type: 'text_complete', text: item.text,
          ...(item.phase === 'commentary' ? { isIntermediate: true } : {}), turnId: item.id });
        break;
      case 'reasoning': {
        const text = item.summary.join('\n') || item.content.join('\n');
        if (text) this.queue.enqueue({ type: 'text_complete', text, isIntermediate: true, turnId: item.id });
        break;
      }
      case 'commandExecution': {
        const output = this.commandOutput.get(item.id) ?? item.aggregatedOutput ?? (item.exitCode === 0 ? 'Success' : `Exit code: ${item.exitCode ?? 'unknown'}`);
        this.commandOutput.delete(item.id);
        this.queue.enqueue({ type: 'tool_result', toolUseId: item.id, toolName: 'Bash', result: output, isError: item.status === 'failed' || item.status === 'declined' || (item.exitCode != null && item.exitCode !== 0), turnId: notification.turnId });
        break;
      }
      case 'fileChange':
        this.queue.enqueue({ type: 'tool_result', toolUseId: item.id, toolName: 'Edit', result: item.changes.map(change => change.path).join('\n') || item.status, isError: item.status === 'failed' || item.status === 'declined', turnId: notification.turnId });
        break;
      case 'mcpToolCall':
        this.queue.enqueue({ type: 'tool_result', toolUseId: item.id, toolName: `mcp__${item.server}__${item.tool}`, result: item.error?.message ?? JSON.stringify(item.result ?? 'Success'), isError: !!item.error || item.status === 'failed', turnId: notification.turnId });
        break;
      case 'dynamicToolCall':
        this.queue.enqueue({ type: 'tool_result', toolUseId: item.id, toolName: this.nativeToolAliases.get(item.tool) ?? item.tool, result: item.contentItems?.map(content => 'text' in content ? content.text : JSON.stringify(content)).join('\n') ?? '', isError: item.success === false || item.status === 'failed', turnId: notification.turnId });
        break;
      case 'webSearch':
        this.queue.enqueue({ type: 'tool_result', toolUseId: item.id, toolName: 'WebSearch', result: item.results ? JSON.stringify(item.results) : `Search completed: ${item.query}`, isError: false, turnId: notification.turnId });
        break;
      case 'imageView':
        this.queue.enqueue({ type: 'tool_result', toolUseId: item.id, toolName: 'ImageView', result: `Viewed image: ${item.path}`, isError: false, turnId: notification.turnId });
        break;
    }
  }

  private handleUsage(notification: ThreadTokenUsageUpdatedNotification): void {
    const usage = notification.tokenUsage.last;
    const mapped = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cachedInputTokens,
      cacheCreationTokens: usage.cacheWriteInputTokens,
      contextWindow: notification.tokenUsage.modelContextWindow ?? undefined,
    };
    this.lastUsage = mapped;
    if (mapped.contextWindow) this.usageTracker.setContextWindow(mapped.contextWindow);
    this.usageTracker.recordMessageUsage(mapped);
    this.queue.enqueue({
      type: 'usage_update',
      usage: {
        inputTokens: usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteInputTokens,
        contextWindow: mapped.contextWindow,
      },
    });
  }

  private handlePlan(params: Record<string, unknown>): void {
    const steps = Array.isArray(params.plan) ? params.plan.map(raw => {
      const step = asRecord(raw);
      return { content: String(step.step ?? ''), status: step.status === 'inProgress' ? 'in_progress' : step.status };
    }) : [];
    if (!steps.length) return;
    const id = `codex-plan-${String(params.turnId ?? Date.now())}`;
    this.queue.enqueue({ type: 'tool_start', toolUseId: id, toolName: 'TodoWrite', input: { todos: steps } });
    this.queue.enqueue({ type: 'tool_result', toolUseId: id, toolName: 'TodoWrite', result: String(params.explanation ?? 'Plan updated'), isError: false });
  }

  private async handleServerRequest(client: NativeCodexAppServerClient, request: NativeCodexServerRequest): Promise<void> {
    if (!this.ownsClient(client)) return;
    if (request.method === 'currentTime/read') {
      const params = asRecord(request.params);
      if (params.threadId !== this.codexThreadId) {
        await client.respondError(request.id, 'Thread is no longer active');
      } else {
        await client.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      }
      return;
    }
    if (request.method !== 'account/chatgptAuthTokens/refresh' && !this.isActiveTurnRequest(request.params)) {
      await client.respondError(request.id, 'Turn is no longer active');
      return;
    }
    switch (request.method) {
      case 'item/tool/call':
        await this.handleDynamicToolCall(client, request, request.params as DynamicToolCallParams);
        return;
      case 'item/commandExecution/requestApproval':
        await this.handleApproval(client, request, 'Bash', request.params as CommandApprovalParams, { decision: 'decline' }, (allowed, always) => ({ decision: allowed ? (always ? 'acceptForSession' : 'accept') : 'decline' }));
        return;
      case 'item/fileChange/requestApproval':
        await this.handleApproval(client, request, 'Edit', request.params as FileChangeApprovalParams, { decision: 'decline' }, (allowed, always) => ({ decision: allowed ? (always ? 'acceptForSession' : 'accept') : 'decline' }));
        return;
      case 'item/permissions/requestApproval':
        await this.handlePermissionsApproval(client, request, request.params as PermissionsApprovalParams);
        return;
      case 'account/chatgptAuthTokens/refresh':
        await this.handleTokenRefresh(client, request);
        return;
      default:
        await client.respondError(request.id, `Unsupported app-server request: ${request.method}`, -32601);
    }
  }

  private isActiveTurnRequest(raw: unknown): boolean {
    const params = asRecord(raw);
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    const turnId = typeof params.turnId === 'string' ? params.turnId : null;
    return this.processing
      && !!threadId
      && threadId === this.codexThreadId
      && !!turnId
      && turnId === this.currentTurnId
      && !this.ignoredTurnIds.has(turnId);
  }

  private async handleApproval<T>(
    client: NativeCodexAppServerClient,
    request: NativeCodexServerRequest,
    toolName: string,
    params: CommandApprovalParams | FileChangeApprovalParams,
    denied: T,
    result: (allowed: boolean, alwaysAllow: boolean) => T,
  ): Promise<void> {
    if (this.usesHostExecution()) return client.respond(request.id, denied);
    const mode = this.getPermissionMode();
    if (mode === 'allow-all') {
      await client.respond(request.id, result(true, true));
      return;
    }
    if (mode === 'safe' || !this.onPermissionRequest) {
      await client.respond(request.id, denied);
      return;
    }
    const id = String(request.id);
    this.pendingPermissions.set(id, {
      resolve: (allowed, always) => { void client.respond(request.id, result(allowed, always)).catch(error => this.debug(`Approval response failed: ${error}`)); },
      deny: () => { void client.respond(request.id, denied).catch(error => this.debug(`Approval denial failed: ${error}`)); },
    });
    const command = 'command' in params ? params.command ?? undefined : undefined;
    this.onPermissionRequest({
      requestId: id,
      toolName,
      command,
      description: params.reason ?? (command ? `Run command: ${command}` : 'Apply file changes'),
      type: toolName === 'Bash' ? 'bash' : 'file_write',
    });
  }

  private async handlePermissionsApproval(client: NativeCodexAppServerClient, request: NativeCodexServerRequest, params: PermissionsApprovalParams): Promise<void> {
    const requestedPermissions = Object.fromEntries(Object.entries(params.permissions).filter(([, value]) => value != null));
    const grant = (allowed: boolean, always: boolean) => ({ permissions: allowed ? requestedPermissions : {}, scope: always ? 'session' : 'turn' });
    if (this.usesHostExecution()) return client.respond(request.id, grant(false, false));
    if (this.getPermissionMode() === 'allow-all') return client.respond(request.id, grant(true, true));
    if (this.getPermissionMode() === 'safe' || !this.onPermissionRequest) return client.respond(request.id, grant(false, false));
    const id = String(request.id);
    this.pendingPermissions.set(id, {
      resolve: (allowed, always) => { void client.respond(request.id, grant(allowed, always)).catch(error => this.debug(`Permission response failed: ${error}`)); },
      deny: () => { void client.respond(request.id, grant(false, false)).catch(error => this.debug(`Permission denial failed: ${error}`)); },
    });
    this.onPermissionRequest({ requestId: id, toolName: 'CodexPermissions', description: params.reason ?? 'Grant additional Codex permissions', type: 'admin_approval' });
  }

  respondToPermission(requestId: string, allowed: boolean, alwaysAllow = false): void {
    this.hostTools.respondToPermission(requestId, allowed, alwaysAllow);
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    pending.resolve(allowed, alwaysAllow);
  }

  private async handleDynamicToolCall(client: NativeCodexAppServerClient, request: NativeCodexServerRequest, params: DynamicToolCallParams): Promise<void> {
    const originalToolName = this.nativeToolAliases.get(params.tool) ?? params.tool;
    const args = asRecord(params.arguments);
    await this.emitAutomationEvent('PreToolUse', { hook_event_name: 'PreToolUse', tool_name: originalToolName, tool_input: args });
    if (!this.nativeToolAliases.has(params.tool)) {
      await client.respond(request.id, { contentItems: [{ type: 'inputText', text: 'Unknown or disabled TokenBird tool' }], success: false });
      return;
    }
    let result: HostToolResult;
    try { result = await this.hostTools.execute(originalToolName, args, `codex-${params.callId}`); }
    catch (error) { result = { content: error instanceof Error ? error.message : String(error), isError: true }; }
    if (!this.isActiveTurnRequest(params) || !this.ownsClient(client)) return;
    await client.respond(request.id, {
      contentItems: [{ type: 'inputText', text: result.content.slice(0, MAX_TOOL_OUTPUT_CHARS) },
        ...(result.images ?? []).map(image => ({ type: 'inputImage', imageUrl: `data:${image.mimeType};base64,${image.data}` }))],
      success: !result.isError,
    });
    const hookEvent = result.isError ? 'PostToolUseFailure' : 'PostToolUse';
    void this.emitAutomationEvent(hookEvent, {
      hook_event_name: hookEvent,
      tool_name: originalToolName,
      tool_input: args,
      ...(result.isError ? { error: result.content } : { tool_response: result.content }),
    });
  }

  private async handleTokenRefresh(client: NativeCodexAppServerClient, request: NativeCodexServerRequest): Promise<void> {
    const slug = this.config.connectionSlug ?? this.config.session?.llmConnection;
    if (!slug) return client.respondError(request.id, 'Missing connection for token refresh');
    const manager = getCredentialManager();
    const id = { type: 'llm_oauth' as const, connectionSlug: slug };
    const snapshot = await manager.getSnapshot(id);
    const oauth = snapshot.credential;
    if (!oauth?.refreshToken) return client.respondError(request.id, 'ChatGPT refresh token is unavailable');
    let refresh = NativeCodexAgent.tokenRefreshByConnection.get(slug);
    if (!refresh) {
      refresh = (async () => {
        const refreshed = await withTimeout(
          refreshChatGptTokens(oauth.refreshToken!, message => this.debug(message)),
          TOKEN_REFRESH_TIMEOUT_MS,
          'ChatGPT token refresh timed out',
        );
        const chatgptAccountId = extractChatGptAccountId(refreshed.accessToken);
        if (!chatgptAccountId) throw new Error('Refreshed token has no ChatGPT account id');
        if (!await manager.compareAndSetMany([{ id, expectedRevision: snapshot.revision, credential: {
          ...snapshot.credential, value: refreshed.accessToken, refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt, idToken: refreshed.idToken,
        } }])) throw new CredentialChangedError();
        return { accessToken: refreshed.accessToken, chatgptAccountId };
      })();
      NativeCodexAgent.tokenRefreshByConnection.set(slug, refresh);
    }
    try {
      const refreshed = await refresh;
      await client.respond(request.id, { ...refreshed, chatgptPlanType: null });
    } catch (error) {
      const current = await manager.getSnapshot(id);
      const changed = error instanceof CredentialChangedError || current.revision !== snapshot.revision;
      await client.respondError(request.id, changed ? new CredentialChangedError().message : 'ChatGPT token refresh failed. Try again.');
    } finally {
      if (NativeCodexAgent.tokenRefreshByConnection.get(slug) === refresh) {
        NativeCodexAgent.tokenRefreshByConnection.delete(slug);
      }
    }
  }

  async abort(reason?: string): Promise<void> {
    this.debug(`Abort requested${reason ? `: ${reason}` : ''}`);
    this.forceAbort(AbortReason.UserStop);
  }

  async refreshOAuthCredentials(): Promise<void> {
    const slug = this.config.connectionSlug ?? this.config.session?.llmConnection;
    if (slug && this.config.authType === 'oauth' && getBackendRuntime(this.config).oauthProvider === 'tokennest') {
      await getValidTokenNestCredentials(slug, getCredentialManager(), true);
    }
  }

  forceAbort(reason: AbortReason): void {
    this.abortReason = reason;
    this.hostTools.cancel();
    for (const pending of this.pendingPermissions.values()) pending.deny();
    this.pendingPermissions.clear();
    if (this.currentTurnId && this.currentTurnId !== 'pending') this.rememberIgnoredTurn(this.currentTurnId);
    if (this.currentTurnId === 'pending') {
      // No turn id exists yet, so the only deterministic way to cancel a
      // turn/start request is to close its app-server connection.
      void this.disconnectClient();
    } else if (this.client?.isConnected && this.codexThreadId && this.currentTurnId) {
      void this.client.request('turn/interrupt', { threadId: this.codexThreadId, turnId: this.currentTurnId }).catch(error => this.debug(`Interrupt failed: ${error}`));
    }
    this.queue.complete();
  }

  override redirect(message: string): boolean {
    if (!this.processing || !this.client?.isConnected || !this.codexThreadId || !this.currentTurnId) return false;
    const expectedTurnId = this.currentTurnId;
    void this.client.request('turn/steer', {
      threadId: this.codexThreadId,
      expectedTurnId,
      input: [{ type: 'text', text: message, text_elements: [] }],
    }).catch(error => {
      this.debug(`Steer failed: ${error instanceof Error ? error.message : String(error)}`);
      this.queue.enqueue({ type: 'steer_undelivered', message });
    });
    return true;
  }

  override async setSourceServers(mcpServers: Record<string, SdkMcpServerConfig>, apiServers: Record<string, unknown>, intendedSlugs?: string[]): Promise<void> {
    await super.setSourceServers(mcpServers, apiServers, intendedSlugs);
    const signature = JSON.stringify(this.buildDynamicTools());
    if (this.toolSignature && signature !== this.toolSignature) this.toolsChanged = true;
  }

  override setPermissionMode(mode: Parameters<BaseAgent['setPermissionMode']>[0]): void {
    const changed = mode !== this.getPermissionMode();
    super.setPermissionMode(mode);
    if (changed && this.codexThreadId) this.toolsChanged = true;
  }

  override cyclePermissionMode(): ReturnType<BaseAgent['cyclePermissionMode']> {
    const mode = super.cyclePermissionMode();
    if (this.codexThreadId) this.toolsChanged = true;
    return mode;
  }

  override setWorkspace(workspace: Workspace): void {
    super.setWorkspace(workspace);
    this.codexThreadId = null;
    this.threadClient = null;
    this.hostTools.cancel();
    void this.disconnectClient();
  }

  override clearHistory(): void {
    this.codexThreadId = null;
    this.threadClient = null;
    this.config.onSdkSessionIdCleared?.();
    super.clearHistory();
  }

  private async disconnectClient(): Promise<void> {
    this.clientGeneration++;
    const clients = new Set([this.client, this.pendingClient].filter((client): client is NativeCodexAppServerClient => !!client));
    this.client = null;
    this.pendingClient = null;
    this.authenticated = false;
    await Promise.all([...clients].map(client => client.disconnect().catch(error => this.debug(`Disconnect failed: ${error}`))));
  }

  override destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pendingPermissions.values()) pending.deny();
    this.pendingPermissions.clear();
    this.consumePendingSourceActivationRestart();
    this.hostTools.cancel();
    this.queue.complete();
    void this.disconnectClient().then(() => this.removeHostHome());
    super.destroy();
  }

  async disposeForRestart(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pendingPermissions.values()) pending.deny();
    this.pendingPermissions.clear();
    this.consumePendingSourceActivationRestart();
    this.hostTools.cancel();
    this.queue.complete();
    await this.disconnectClient();
    await this.removeHostHome();
    super.destroy();
  }

  private async removeHostHome(): Promise<void> {
    const home = this.hostHome;
    this.hostHome = null;
    if (home) await home.then(path => rm(path, { recursive: true, force: true })).catch(error => this.debug(`Host home cleanup failed: ${error}`));
  }

  async runMiniCompletion(prompt: string): Promise<string | null> {
    try { return (await this.queryLlm({ prompt, model: this.config.miniModel ?? this._model })).text || null; }
    catch (error) { this.debug(`Mini completion failed: ${error instanceof Error ? error.message : String(error)}`); return null; }
  }

  async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
    const workDir = this.workingDirectory;
    const env = await this.buildCodexEnvironment();
    const hostExecution = this.usesHostExecution();
    const client = new NativeCodexAppServerClient({ codexPath: this.binary.path, workDir: hostExecution ? env!.CODEX_HOME! : workDir,
      env, configArgs: this.buildCodexConfigArgs(env),
      requestTimeoutMs: 30_000, onDebug: message => this.debug(`[utility] ${message}`) });
    this.clientCredentials.set(client, env?.[CODEX_CUSTOM_API_KEY_ENV]
      ? createHash('sha256').update(env[CODEX_CUSTOM_API_KEY_ENV]!).digest('hex') : null);
    const completionControl: { cancel?: (error: Error) => void } = {};
    const onServerRequest = (serverRequest: NativeCodexServerRequest) => {
      const task = serverRequest.method === 'account/chatgptAuthTokens/refresh'
        ? this.handleTokenRefresh(client, serverRequest)
        : serverRequest.method === 'currentTime/read'
          ? client.respond(serverRequest.id, { currentTimeAt: Math.floor(Date.now() / 1000) })
        : client.respondError(serverRequest.id, `Unsupported utility app-server request: ${serverRequest.method}`, -32601);
      void task.catch(error => this.debug(`Utility server request failed: ${error instanceof Error ? error.message : String(error)}`));
    };
    client.on('serverRequest', onServerRequest);
    const operation = (async (): Promise<LLMQueryResult> => {
      await client.connect();
      if (!await this.authenticateClient(client)) throw new Error('Codex authentication is unavailable');
      let text = '';
      let usage: ThreadTokenUsageUpdatedNotification['tokenUsage']['last'] | undefined;
      let settled = false;
      let finish!: () => void;
      let fail!: (error: Error) => void;
      const completed = new Promise<void>((resolve, reject) => {
        finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        fail = error => {
          if (settled) return;
          settled = true;
          reject(error);
        };
      });
      completionControl.cancel = fail;
      const onError = (error: Error) => fail(error instanceof Error ? error : new Error(String(error)));
      let utilityThreadId: string | null = null;
      const onNotification = (method: string, raw: unknown) => {
        const params = asRecord(raw);
        if (!utilityThreadId || params.threadId !== utilityThreadId) return;
        if (method === 'item/completed') {
          const item = (raw as ItemNotification).item;
          if (item.type === 'agentMessage' && item.phase !== 'commentary') text += item.text;
        } else if (method === 'thread/tokenUsage/updated') {
          usage = (raw as ThreadTokenUsageUpdatedNotification).tokenUsage.last;
        } else if (method === 'turn/completed') {
          const turn = (raw as TurnCompletedNotification).turn;
          turn.status === 'completed' ? finish()
            : fail(new Error(turn.error?.message ?? `Codex utility turn ${turn.status}`));
        }
      };
      client.on('error', onError);
      client.on('notification', onNotification);
      try {
        const thread = await client.request<ThreadResponse>('thread/start', {
          model: bareModelId(request.model ?? this.config.miniModel ?? this._model),
          ...(getBackendRuntime(this.config).baseUrl ? { modelProvider: CODEX_CUSTOM_PROVIDER } : {}),
          cwd: workDir,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          developerInstructions: request.systemPrompt ?? null,
          ephemeral: true,
          dynamicTools: [],
          ...(hostExecution ? { environments: [], config: CODEX_HOST_EXECUTION_CONFIG } : {}),
        });
        utilityThreadId = thread.thread.id;
        await client.request<TurnStartResponse>('turn/start', {
          threadId: utilityThreadId,
          input: [{ type: 'text', text: request.prompt, text_elements: [] }],
          model: bareModelId(request.model ?? this.config.miniModel ?? this._model),
          effort: 'low',
          ...(hostExecution ? { environments: [] } : {}),
          outputSchema: request.outputSchema as JsonValue | undefined,
        });
        await completed;
        return { text, model: request.model, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens };
      } finally {
        client.off('error', onError);
        client.off('notification', onNotification);
        if (completionControl.cancel === fail) delete completionControl.cancel;
      }
    })();
    try {
      return await withTimeout(operation, LLM_QUERY_TIMEOUT_MS, 'Codex utility query timed out');
    } finally {
      completionControl.cancel?.(new Error('Codex utility query cancelled'));
      client.off('serverRequest', onServerRequest);
      await client.disconnect().catch(() => undefined);
    }
  }
}
