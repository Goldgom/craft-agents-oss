import type { AgentEvent, AgentEventUsage } from '@craft-agent/core/types';
import {
  SESSION_TOOL_REGISTRY,
  type ToolResult as SessionToolResult,
} from '@craft-agent/session-tools-core';
import type { FileAttachment } from '../utils/files.ts';
import type { Workspace } from '../config/storage.ts';
import { getBrowserToolEnabled } from '../config/storage.ts';
import { getCoAuthorPreference } from '../config/preferences.ts';
import { getCredentialManager } from '../credentials/index.ts';
import { refreshChatGptTokens } from '../auth/chatgpt-oauth.ts';
import { getModelById } from '../config/models.ts';
import { getSessionDataPath, getSessionPath, getSessionPlansPath } from '../sessions/storage.ts';
import { extractWorkspaceSlug } from '../utils/workspace.ts';
import { saveBinaryResponse } from '../utils/binary-detection.ts';
import { mkdir } from 'node:fs/promises';
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
import { getSessionToolProxyDefs, SESSION_TOOL_NAMES } from './backend/pi/session-tool-defs.ts';
import { createClaudeContext, type SessionToolContext } from './claude-context.ts';
import { attachSessionSelfManagementBindings } from './session-self-management-bindings.ts';
import { getSessionScopedToolCallbacks, setLastPlanFilePath } from './session-scoped-tools.ts';
import { executeBrowserToolCommand } from './browser-tool-runtime.ts';
import { runPreToolUseChecks } from './core/pre-tool-use.ts';
import { LLM_QUERY_TIMEOUT_MS, withTimeout, type LLMQueryRequest, type LLMQueryResult } from './llm-tool.ts';
import { parseError } from './errors.ts';
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
  private sessionToolContext: SessionToolContext | null = null;
  private toolSignature = '';
  private toolsChanged = false;
  private authenticated = false;
  private nativeToolAliases = new Map<string, string>();
  private ignoredTurnIds = new Set<string>();
  private lastUsage?: AgentEventUsage;

  constructor(config: BackendConfig, private readonly binary: NativeCodexBinary) {
    const model = config.model || DEFAULT_NATIVE_CODEX_MODEL;
    super(config, model, getModelById(model)?.contextWindow);
    this._supportsBranching = false;
    this.codexThreadId = config.session?.sdkSessionId ?? null;
    if (!config.isHeadless) this.startConfigWatcher();
  }

  protected override debug(message: string): void {
    this.onDebug?.(`[Codex native] ${message}`);
  }

  getProcessId(): number | undefined { return this.client?.processId; }
  override getSessionId(): string | null { return this.codexThreadId; }
  override setSessionId(sessionId: string | null): void { this.codexThreadId = sessionId; }
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
    if (this.client?.isConnected) return this.client;
    if (this.connecting) return this.connecting;
    const generation = ++this.clientGeneration;
    this.connecting = (async () => {
      const env = await this.buildCodexEnvironment();
      const client = new NativeCodexAppServerClient({
        codexPath: this.binary.path,
        workDir: this.workingDirectory,
        requestTimeoutMs: 30_000,
        onDebug: message => this.debug(message),
        env,
      });
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
          void client.respondError(request.id, 'Craft Agents could not process this request').catch(() => undefined);
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
    // Keep connection-owned credentials out of the user's global Codex home.
    // authType=none deliberately keeps the global home so an existing `codex login`
    // can be used by an explicitly unmanaged connection.
    if (!['api_key', 'api_key_with_endpoint', 'oauth'].includes(this.config.authType ?? '')) return undefined;
    // Managed credentials and Codex configuration are connection-owned and
    // persistent, but fully isolated from the user's native ~/.codex profile.
    // A stable connection home also avoids creating a fresh auth/config copy
    // for every TokenBird session.
    const connectionKey = (this.config.connectionSlug ?? 'managed')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'managed';
    const codexHome = join(getConfigDir(), 'codex', 'connections', connectionKey);
    await mkdir(codexHome, { recursive: true });
    return { CODEX_HOME: codexHome };
  }

  private async authenticateClient(client: NativeCodexAppServerClient): Promise<boolean> {
    const slug = this.config.connectionSlug ?? this.config.session?.llmConnection;
    const credentials = getCredentialManager();
    if (slug && (this.config.authType === 'api_key' || this.config.authType === 'api_key_with_endpoint')) {
      const apiKey = await credentials.getLlmApiKey(slug);
      if (!apiKey) return false;
      await client.request('account/login/start', { type: 'apiKey', apiKey });
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
      return true;
    }
    const result = await client.request<{ account: unknown | null; requiresOpenaiAuth: boolean }>('account/read', {});
    return !!result.account || !result.requiresOpenaiAuth;
  }

  private buildDynamicTools(): DynamicToolSpec[] {
    let defs = getSessionToolProxyDefs();
    if (!getBrowserToolEnabled()) defs = defs.filter(def => def.name !== 'mcp__session__browser_tool');
    const sourceDefs = this.config.mcpPool?.getProxyToolDefs() ?? [];
    this.nativeToolAliases.clear();
    return [...defs, ...sourceDefs].map(def => {
      // app-server reserves the mcp__ prefix for its own configured MCP servers.
      const nativeName = def.name.startsWith('mcp__') ? `craft__${def.name.slice('mcp__'.length)}` : `craft__${def.name}`;
      this.nativeToolAliases.set(nativeName, def.name);
      return {
        type: 'function' as const,
        name: nativeName,
        description: def.description || `Craft tool ${def.name}`,
        inputSchema: def.inputSchema as JsonValue,
      };
    });
  }

  private threadPolicy(): { approvalPolicy: AskForApproval; sandbox: SandboxMode } {
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
    return [system, ...this.promptBuilder.buildStableContextParts()].filter(Boolean).join('\n\n');
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
    const tools = this.buildDynamicTools();
    const signature = JSON.stringify(tools);
    if (this.toolsChanged && this.codexThreadId) {
      this.debug('Dynamic tool set changed; starting a fresh Codex thread with recovery context');
      this.codexThreadId = null;
      this.config.onSdkSessionIdCleared?.();
    }

    const policy = this.threadPolicy();
    if (this.codexThreadId) {
      try {
        const response = await client.request<ThreadResponse>('thread/resume', {
          threadId: this.codexThreadId,
          model: bareModelId(this._model),
          cwd: this.workingDirectory,
          runtimeWorkspaceRoots: [this.config.workspace.rootPath],
          approvalPolicy: policy.approvalPolicy,
          sandbox: policy.sandbox,
          excludeTurns: true,
        });
        return response.thread.id;
      } catch (error) {
        this.debug(`Thread resume failed, starting a recovered thread: ${error instanceof Error ? error.message : String(error)}`);
        this.codexThreadId = null;
        this.config.onSdkSessionIdCleared?.();
      }
    }

    const response = await client.request<ThreadResponse>('thread/start', {
      model: bareModelId(this._model),
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
      const response = await client.request<TurnStartResponse>('turn/start', {
        threadId,
        input: this.buildUserInput(effectiveMessage, attachments),
        cwd: this.workingDirectory,
        runtimeWorkspaceRoots: [this.config.workspace.rootPath],
        approvalPolicy: policy.approvalPolicy,
        model: bareModelId(this._model),
        effort: this.reasoningEffort(options?.thinkingOverride),
      });
      this.currentTurnId = response.turn.id;
      if (this.abortReason) {
        this.rememberIgnoredTurn(response.turn.id);
        void client.request('turn/interrupt', { threadId, turnId: response.turn.id }).catch(() => undefined);
        return;
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
        if (completed.turn.status === 'failed' && completed.turn.error) {
          this.queue.enqueue({ type: 'error', message: completed.turn.error.message });
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
        this.queue.enqueue({ type: 'text_complete', text: item.text, turnId: item.id });
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
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    pending.resolve(allowed, alwaysAllow);
  }

  private async handleDynamicToolCall(client: NativeCodexAppServerClient, request: NativeCodexServerRequest, params: DynamicToolCallParams): Promise<void> {
    const originalToolName = this.nativeToolAliases.get(params.tool) ?? params.tool;
    const args = asRecord(params.arguments);
    await this.emitAutomationEvent('PreToolUse', { hook_event_name: 'PreToolUse', tool_name: originalToolName, tool_input: args });
    const checked = await this.authorizeDynamicTool(originalToolName, args);
    if (checked.error) {
      await client.respond(request.id, { contentItems: [{ type: 'inputText', text: checked.error }], success: false });
      return;
    }
    const result = await this.routeToolCall(originalToolName, checked.input ?? args);
    await client.respond(request.id, {
      contentItems: [{ type: 'inputText', text: result.content.slice(0, MAX_TOOL_OUTPUT_CHARS) }],
      success: !result.isError,
    });
    const hookEvent = result.isError ? 'PostToolUseFailure' : 'PostToolUse';
    void this.emitAutomationEvent(hookEvent, {
      hook_event_name: hookEvent,
      tool_name: originalToolName,
      tool_input: checked.input ?? args,
      ...(result.isError ? { error: result.content } : { tool_response: result.content }),
    });
  }

  private async authorizeDynamicTool(toolName: string, input: Record<string, unknown>): Promise<{ input?: Record<string, unknown>; error?: string }> {
    const root = this.config.workspace.rootPath || this.workingDirectory;
    const run = () => runPreToolUseChecks({
      toolName,
      input,
      sessionId: this._sessionId,
      permissionMode: this.getPermissionMode(),
      workspaceRootPath: root,
      workspaceId: extractWorkspaceSlug(root, this.config.workspace.id),
      plansFolderPath: getSessionPlansPath(root, this._sessionId),
      dataFolderPath: getSessionDataPath(root, this._sessionId),
      workingDirectory: this.workingDirectory,
      activeSourceSlugs: [...this.sourceManager.getActiveSlugs()],
      allSourceSlugs: this.sourceManager.getAllSources().map(source => source.config.slug),
      hasSourceActivation: !!this.onSourceActivationRequest,
      permissionManager: this.permissionManager,
      prerequisiteManager: this.prerequisiteManager,
      onDebug: message => this.debug(message),
    });
    let checked = run();
    if (checked.type === 'source_activation_needed') {
      const activated = await this.onSourceActivationRequest?.(checked.sourceSlug);
      if (!activated) return { error: `Source "${checked.sourceSlug}" is not active.` };
      checked = run();
    }
    if (checked.type === 'block') return { error: checked.reason };
    if (checked.type === 'prompt') {
      if (!this.onPermissionRequest) return { input: checked.modifiedInput ?? input };
      const id = `codex-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const allowed = await new Promise<boolean>(resolve => {
        this.pendingPermissions.set(id, { resolve: value => resolve(value), deny: () => resolve(false) });
        this.onPermissionRequest!({
          requestId: id,
          toolName,
          command: checked.type === 'prompt' ? checked.command : undefined,
          description: checked.type === 'prompt' ? checked.description : `Use ${toolName}`,
          type: checked.type === 'prompt' ? checked.promptType : undefined,
        });
      });
      this.pendingPermissions.delete(id);
      return allowed ? { input: checked.modifiedInput ?? input } : { error: 'Permission denied by user.' };
    }
    if (checked.type === 'modify') return { input: checked.input };
    if (checked.type === 'call_llm_intercept' || checked.type === 'spawn_session_intercept') return { input: checked.input };
    return { input };
  }

  private getSessionToolContext(): SessionToolContext {
    if (this.sessionToolContext) return this.sessionToolContext;
    this.sessionToolContext = createClaudeContext({
      sessionId: this._sessionId,
      workspacePath: this.config.workspace.rootPath,
      workspaceId: this.config.workspace.id,
      onPlanSubmitted: planPath => {
        setLastPlanFilePath(this._sessionId, planPath);
        this.onPlanSubmitted?.(planPath);
      },
      onAuthRequest: request => this.onAuthRequest?.(request as never),
    });
    attachSessionSelfManagementBindings(this.sessionToolContext, this._sessionId);
    return this.sessionToolContext;
  }

  private async routeToolCall(toolName: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    const stripped = toolName.startsWith('mcp__session__') ? toolName.slice('mcp__session__'.length) : toolName;
    if (SESSION_TOOL_NAMES.has(stripped)) {
      if (stripped === 'call_llm') {
        try { return { content: (await this.preExecuteCallLlm(args)).text || '(Model returned empty response)', isError: false }; }
        catch (error) { return { content: `call_llm failed: ${error instanceof Error ? error.message : String(error)}`, isError: true }; }
      }
      if (stripped === 'spawn_session') {
        try { return { content: JSON.stringify(await this.preExecuteSpawnSession(args), null, 2), isError: false }; }
        catch (error) { return { content: `spawn_session failed: ${error instanceof Error ? error.message : String(error)}`, isError: true }; }
      }
      if (stripped === 'browser_tool') return this.executeBrowserTool(args);
      const def = SESSION_TOOL_REGISTRY.get(stripped);
      if (!def?.handler) return { content: `Unsupported session tool: ${stripped}`, isError: true };
      const result: SessionToolResult = await def.handler(this.getSessionToolContext(), args);
      return { content: result.content.map(block => block.text).join('\n'), isError: !!result.isError };
    }
    if (this.config.mcpPool?.isProxyTool(toolName)) return this.config.mcpPool.callTool(toolName, args);
    return { content: `Unknown dynamic tool: ${toolName}`, isError: true };
  }

  private async executeBrowserTool(args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    const fns = getSessionScopedToolCallbacks(this._sessionId)?.browserPaneFns;
    if (!fns) return { content: 'Browser controls require the desktop app.', isError: true };
    try {
      const result = await executeBrowserToolCommand({ command: (args.command as string | string[]) ?? '', fns, sessionId: this._sessionId });
      let content = result.output;
      if (result.image) {
        const saved = saveBinaryResponse(
          getSessionPath(this.config.workspace.rootPath, this._sessionId),
          `browser-screenshot.${result.image.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`,
          Buffer.from(result.image.data, 'base64'),
          result.image.mimeType,
        );
        if (saved.type === 'file_download') content += `\n\nSaved screenshot: ${saved.path}`;
      }
      return { content, isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  private async handleTokenRefresh(client: NativeCodexAppServerClient, request: NativeCodexServerRequest): Promise<void> {
    const slug = this.config.connectionSlug ?? this.config.session?.llmConnection;
    if (!slug) return client.respondError(request.id, 'Missing connection for token refresh');
    const manager = getCredentialManager();
    const oauth = await manager.getLlmOAuth(slug);
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
        await manager.setLlmOAuth(slug, refreshed);
        return { accessToken: refreshed.accessToken, chatgptAccountId };
      })();
      NativeCodexAgent.tokenRefreshByConnection.set(slug, refresh);
    }
    try {
      const refreshed = await refresh;
      await client.respond(request.id, { ...refreshed, chatgptPlanType: null });
    } catch (error) {
      await client.respondError(request.id, error instanceof Error ? error.message : String(error));
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

  forceAbort(reason: AbortReason): void {
    this.abortReason = reason;
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
    this.sessionToolContext = null;
    void this.disconnectClient();
  }

  override clearHistory(): void {
    this.codexThreadId = null;
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
    this.sessionToolContext = null;
    this.queue.complete();
    void this.disconnectClient();
    super.destroy();
  }

  async disposeForRestart(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pendingPermissions.values()) pending.deny();
    this.pendingPermissions.clear();
    this.consumePendingSourceActivationRestart();
    this.sessionToolContext = null;
    this.queue.complete();
    await this.disconnectClient();
    super.destroy();
  }

  async runMiniCompletion(prompt: string): Promise<string | null> {
    try { return (await this.queryLlm({ prompt, model: this.config.miniModel ?? this._model })).text || null; }
    catch (error) { this.debug(`Mini completion failed: ${error instanceof Error ? error.message : String(error)}`); return null; }
  }

  async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
    const workDir = this.workingDirectory;
    const client = new NativeCodexAppServerClient({ codexPath: this.binary.path, workDir, env: await this.buildCodexEnvironment(), requestTimeoutMs: 30_000, onDebug: message => this.debug(`[utility] ${message}`) });
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
          if (item.type === 'agentMessage') text += item.text;
        } else if (method === 'thread/tokenUsage/updated') {
          usage = (raw as ThreadTokenUsageUpdatedNotification).tokenUsage.last;
        } else if (method === 'turn/completed') {
          const turn = (raw as TurnCompletedNotification).turn;
          turn.status === 'failed' ? fail(new Error(turn.error?.message ?? 'Codex utility turn failed')) : finish();
        }
      };
      client.on('error', onError);
      client.on('notification', onNotification);
      try {
        const thread = await client.request<ThreadResponse>('thread/start', {
          model: bareModelId(request.model ?? this.config.miniModel ?? this._model),
          cwd: workDir,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          developerInstructions: request.systemPrompt ?? null,
          ephemeral: true,
          dynamicTools: [],
        });
        utilityThreadId = thread.thread.id;
        await client.request<TurnStartResponse>('turn/start', {
          threadId: utilityThreadId,
          input: [{ type: 'text', text: request.prompt, text_elements: [] }],
          model: bareModelId(request.model ?? this.config.miniModel ?? this._model),
          effort: 'low',
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
