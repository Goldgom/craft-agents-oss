import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentEvent } from '@craft-agent/core/types';
import type { FileAttachment } from '../utils/files.ts';
import { BaseAgent } from '../agent/base-agent.ts';
import { AbortReason, type AgentBackend, type BackendConfig, type ChatOptions, type PostInitResult } from '../agent/backend/types.ts';
import { EventQueue } from '../agent/backend/event-queue.ts';
import { getSessionToolProxyDefs } from '../agent/backend/session-tool-defs.ts';
import { getBackendRuntime } from '../agent/backend/internal/driver-types.ts';
import { hasSessionExecutionPolicy } from '../agent/core/session-execution-policy.ts';
import type { LLMQueryRequest, LLMQueryResult } from '../agent/llm-tool.ts';
import { getCredentialManager } from '../credentials/index.ts';
import { getCoAuthorPreference } from '../config/preferences.ts';
import { getConfigDir } from '../config/paths.ts';
import { getSystemPrompt } from '../prompts/system.ts';
import { isAgentPluginCompatible } from './catalog.ts';
import { AgentPluginStdioClient } from './stdio-client.ts';
import { AGENT_PLUGIN_PROTOCOL_VERSION, pluginEventSchema } from './protocol.ts';
import { AgentPluginHostTools } from './host-tools.ts';
import type { AgentPluginManifest } from './types.ts';
import { LOCAL_AGENT_HOST_TOOLS } from './local-tools.ts';
import { getBrowserToolEnabled } from '../config/storage.ts';
import { frameworkToolBlockReason } from './framework-tool-policy.ts';
import { loadBackendFrameworkConfiguration } from './framework-storage.ts';
import { defaultFrameworkConfiguration, defaultNativeOptions } from './frameworks.ts';

const toolRequestSchema = z.object({ turnId: z.string(), toolName: z.string().min(1), input: z.record(z.string(), z.unknown()) });
const initializedSchema = z.object({ protocolVersion: z.literal(1), capabilities: z.array(z.string()), sessionId: z.string().min(1).optional() });
const queryResultSchema = z.object({ text: z.string(), model: z.string().optional(), inputTokens: z.number().nonnegative().optional(), outputTokens: z.number().nonnegative().optional() });

/** A native agent bridge; this class never runs Pi's inference loop. */
export class PluginAgent extends BaseAgent {
  protected backendName: string;
  private client: AgentPluginStdioClient | null = null;
  private initializing: Promise<void> | null = null;
  private disposed = false;
  private processing = false;
  private turnId: string | null = null;
  private nativeSessionId: string | null;
  private queue = new EventQueue();
  private queuedBytes = 0;
  private hostTools: AgentPluginHostTools;
  private utilityBackend?: AgentBackend;
  private stoppingClients = new Set<AgentPluginStdioClient>();

  constructor(config: BackendConfig, readonly manifest: AgentPluginManifest) {
    super(config, config.model ?? 'default');
    this.backendName = manifest.name;
    this._supportsBranching = false;
    this.nativeSessionId = manifest.capabilities.includes('resume') ? config.session?.sdkSessionId ?? null : null;
    const runtime = getBackendRuntime(config);
    if (!isAgentPluginCompatible({ ...manifest, builtin: false }, {
      providerType: config.providerType ?? (config.provider === 'anthropic' ? 'anthropic' : 'pi'),
      piAuthProvider: runtime.piAuthProvider, authType: config.authType,
    })) throw new Error(`Agent plugin ${manifest.id} is incompatible with this connection`);
    if (hasSessionExecutionPolicy(this._sessionId)
      && (!manifest.capabilities.includes('hostTools') || !manifest.capabilities.includes('toolApproval'))) {
      throw new Error(`Agent plugin ${manifest.id} cannot enforce this node's execution policy`);
    }
    this.hostTools = new AgentPluginHostTools(this, config, this._sessionId, async (name, input) => {
      if (name === 'call_llm') return { content: (await this.preExecuteCallLlm(input)).text, isError: false };
      if (name === 'spawn_session') return { content: JSON.stringify(await this.preExecuteSpawnSession(input)), isError: false };
      return undefined;
    });
  }

  getProcessId(): number | undefined { return this.client?.processId; }
  override getSessionId(): string | null { return this.nativeSessionId; }
  override setSessionId(id: string | null): void { this.nativeSessionId = id; }
  isProcessing(): boolean { return this.processing; }
  respondToPermission(id: string, allowed: boolean, alwaysAllow = false): void { this.hostTools.respondToPermission(id, allowed, alwaysAllow); }

  override async postInit(): Promise<PostInitResult> {
    try { await this.ensureClient(); return { authInjected: true }; }
    catch (error) { return { authInjected: false, authWarning: String(error), authWarningLevel: 'error' }; }
  }

  private async ensureClient(): Promise<AgentPluginStdioClient> {
    if (this.disposed) throw new Error('Agent plugin has been disposed');
    if (this.initializing) { await this.initializing; return this.client!; }
    if (this.client && !this.client.isClosed) return this.client;
    const client = new AgentPluginStdioClient(this.manifest, {
      cwd: this.workingDirectory,
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, params) => this.handleHostRequest(method, params),
      onFailure: error => { this.hostTools.cancel(); this.failTurn(error); },
    });
    this.client = client;
    this.initializing = (async () => {
      const runtime = getBackendRuntime(this.config);
      const connectionDirectory = join(getConfigDir(), 'agent-plugins', this.manifest.id.slice('plugin:'.length),
        'connections', (this.config.connectionSlug ?? 'local').replace(/[^A-Za-z0-9_-]/g, '_'),
      );
      const runtimeDataDirectory = join(connectionDirectory, 'sessions', this._sessionId.replace(/[^A-Za-z0-9_-]/g, '_'));
      await mkdir(runtimeDataDirectory, { recursive: true });
      let credentials: { apiKey?: string; accessToken?: string; expiresAt?: number } | undefined;
      if (this.manifest.useConnectionCredentials) {
        const slug = this.config.connectionSlug;
        if (!slug) throw new Error('Plugin credential access requires a configured connection');
        const manager = getCredentialManager();
        if (this.config.authType === 'oauth') {
          const oauth = await manager.getLlmOAuth(slug);
          if (!oauth) throw new Error('Connection OAuth credentials are unavailable');
          if (oauth.expiresAt && oauth.expiresAt <= Date.now()) throw new Error('Connection OAuth credentials have expired; reconnect the connection');
          credentials = { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt };
        } else if (['api_key', 'api_key_with_endpoint', 'bearer_token'].includes(this.config.authType ?? '')) {
          const apiKey = await manager.getLlmApiKey(slug);
          if (!apiKey) throw new Error('Connection API credentials are unavailable');
          credentials = { apiKey };
        } else if (!['none', 'environment'].includes(this.config.authType ?? '')) {
          throw new Error('This connection credential mechanism is not supported by the plugin protocol');
        }
      }
      const result = initializedSchema.parse(await client.request('initialize', {
        protocolVersion: AGENT_PLUGIN_PROTOCOL_VERSION, pluginId: this.manifest.id, runtimeDataDirectory,
        nativeHomeDirectory: join(connectionDirectory, 'native-home'),
        session: { id: this._sessionId, nativeSessionId: this.nativeSessionId,
          workingDirectory: this.workingDirectory, workspaceRootPath: this.config.workspace.rootPath },
        connection: { slug: this.config.connectionSlug, providerType: this.config.providerType, authType: this.config.authType,
          model: this._model, baseUrl: runtime.baseUrl, piAuthProvider: runtime.piAuthProvider, customEndpoint: runtime.customEndpoint },
        credentials,
        framework: loadBackendFrameworkConfiguration(this.manifest.id) ?? defaultFrameworkConfiguration({ ...this.manifest, builtin: false }),
        history: this.nativeSessionId ? undefined : this.config.getRecoveryMessages?.(),
        hostCapabilities: ['preferences', 'workspaceInstructions', 'sessionTools', 'mcpTools', 'toolApproval'],
      }));
      if (this.manifest.capabilities.some(capability => !result.capabilities.includes(capability))) {
        throw new Error('Agent plugin did not negotiate its declared capabilities');
      }
      this.captureSessionId(result.sessionId);
    })();
    try { await this.initializing; return client; }
    catch (error) { this.stopClient(client); if (this.client === client) this.client = null; throw error; }
    finally { this.initializing = null; }
  }

  private captureSessionId(id?: string): void {
    if (!id || !this.manifest.capabilities.includes('resume')) return;
    this.nativeSessionId = id; this.config.onSdkSessionIdUpdate?.(id);
  }

  private handleNotification(method: string, params: unknown): void {
    const value = z.object({ turnId: z.string(), event: pluginEventSchema }).safeParse(params);
    if (method !== 'agent/event' || !value.success) throw new Error('Invalid agent plugin event');
    if (!this.processing || this.queue.isComplete || value.data.turnId !== this.turnId) return;
    const event = value.data.event as AgentEvent;
    if (event.type === 'tool_start' && event.toolName === 'Read') this.prerequisiteManager.trackReadTool(event.input);
    this.enqueue(event);
    if (event.type === 'complete') this.queue.complete();
  }

  private enqueue(event: AgentEvent): void {
    this.queuedBytes += Buffer.byteLength(JSON.stringify(event));
    if (this.queuedBytes > 8 * 1024 * 1024) throw new Error('Agent plugin output backlog is too large');
    this.queue.enqueue(event);
  }

  private failTurn(error: Error): void {
    if (!this.processing || this.queue.isComplete) return;
    this.queue.enqueue({ type: 'error', message: error.message });
    this.queue.enqueue({ type: 'complete' }); this.queue.complete();
  }

  private async handleHostRequest(method: string, raw: unknown): Promise<unknown> {
    const params = toolRequestSchema.parse(raw);
    if (!this.processing || this.queue.isComplete || params.turnId !== this.turnId) throw new Error('No active plugin turn');
    if (method === 'host/authorize' && this.manifest.capabilities.includes('toolApproval')) {
      return this.hostTools.authorize(params.toolName, params.input);
    }
    if (method !== 'host/tool' || !this.manifest.capabilities.includes('hostTools')) throw new Error('Unsupported host method');
    const id = `plugin-tool-${randomUUID()}`;
    this.enqueue({ type: 'tool_start', toolUseId: id, toolName: params.toolName, input: params.input });
    let result;
    try { result = await this.hostTools.execute(params.toolName, params.input); }
    catch (error) { result = { content: error instanceof Error ? error.message : String(error), isError: true }; }
    if (this.turnId === params.turnId && !this.queue.isComplete) {
      this.enqueue({ type: 'tool_result', toolUseId: id, toolName: params.toolName, result: result.content, isError: result.isError });
    }
    return result;
  }

  protected async *chatImpl(message: string, attachments?: FileAttachment[], options?: ChatOptions): AsyncGenerator<AgentEvent> {
    if (this.processing) throw new Error('Agent plugin is already processing a turn');
    this.processing = true; this.turnId = randomUUID(); this.queue.reset(); this.queuedBytes = 0;
    const currentTurnId = this.turnId;
    let request: Promise<void> | undefined;
    try {
      const client = await this.ensureClient();
      const systemPrompt = [getSystemPrompt(undefined, this.config.debugMode, this.config.workspace.rootPath,
        this.workingDirectory, this.config.systemPromptPreset, this.backendName, getCoAuthorPreference(), undefined,
        this.config.agentPrompt, this.config.modelPromptSettings, this.manifest.id), ...this.promptBuilder.buildStableContextParts()].join('\n\n');
      const framework = loadBackendFrameworkConfiguration(this.manifest.id) ?? defaultFrameworkConfiguration({ ...this.manifest, builtin: false });
      const tools = this.manifest.capabilities.includes('hostTools')
        ? [...(framework.features.files === 'native' ? [] : LOCAL_AGENT_HOST_TOOLS),
          ...getSessionToolProxyDefs().filter(tool => getBrowserToolEnabled() || !tool.name.endsWith('browser_tool')),
          ...(this.config.mcpPool?.getProxyToolDefs(this.getActiveSourceSlugs()) ?? [])]
          .filter(tool => !frameworkToolBlockReason(this._sessionId, tool.name)) : [];
      const context = this.promptBuilder.buildVolatileContextParts({ permissionMode: this.getPermissionMode() }, this.sourceManager.formatSourceState());
      request = client.request('agent/chat', { turnId: currentTurnId, message, attachments, systemPrompt,
        context, tools, model: this._model, thinkingLevel: options?.thinkingOverride ?? this._thinkingLevel,
        framework: { ...framework, nativeOptions: framework.nativeOptions ?? defaultNativeOptions() },
        permissionMode: this.getPermissionMode() }, this.manifest.transport.turnTimeoutMs ?? 30 * 60_000)
        .then(result => {
          if (this.turnId !== currentTurnId) return;
          const response = z.object({ sessionId: z.string().min(1).optional() }).parse(result ?? {});
          this.captureSessionId(response.sessionId);
          if (!this.queue.isComplete) { this.enqueue({ type: 'complete' }); this.queue.complete(); }
        }).catch(error => { if (this.turnId === currentTurnId) { this.failTurn(error); this.stopClient(client); } });
      for await (const event of this.queue.drain()) {
        this.queuedBytes = Math.max(0, this.queuedBytes - Buffer.byteLength(JSON.stringify(event)));
        yield event;
      }
      // The RPC response is the turn boundary, including after the complete event.
      await request;
    } catch (error) {
      if (!this.queue.isComplete) { yield { type: 'error', message: error instanceof Error ? error.message : String(error) }; yield { type: 'complete' }; }
    } finally {
      this.hostTools.cancel(); this.processing = false; this.turnId = null;
      // Closing a consumer early also tears down its still-running native turn.
      if (request && !this.queue.isComplete && this.client) this.stopClient(this.client);
    }
  }

  redirect(message: string): boolean {
    if (!this.manifest.capabilities.includes('steering') || !this.client || !this.turnId) { this.forceAbort(AbortReason.Redirect); return false; }
    this.client.notify('agent/steer', { turnId: this.turnId, message }); return true;
  }

  async abort(): Promise<void> { this.forceAbort(AbortReason.UserStop); }
  forceAbort(_reason: AbortReason): void {
    this.hostTools.cancel(); this.turnId = null; this.queue.complete(); if (this.client) this.stopClient(this.client); this.client = null;
  }

  async runMiniCompletion(prompt: string): Promise<string | null> {
    return (await this.queryLlm({ prompt })).text;
  }

  async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
    if (!this.manifest.capabilities.includes('utilityCompletion')) {
      if (!this.config.connectionSlug) throw new Error('Host utility inference requires a model connection');
      if (!this.utilityBackend) {
        const { createModelUtilityBackend } = await import('../agent/backend/factory.ts');
        this.utilityBackend = createModelUtilityBackend(this.config);
      }
      if (!this.utilityBackend.queryLlm) throw new Error('Model transport does not support host utility inference');
      return this.utilityBackend.queryLlm(request);
    }
    const client = await this.ensureClient();
    return queryResultSchema.parse(await client.request('agent/query', { ...request, tools: [] }, 120_000));
  }

  override destroy(): void {
    this.disposed = true; this.forceAbort(AbortReason.UserStop); this.utilityBackend?.destroy(); this.utilityBackend = undefined; super.destroy();
  }

  async disposeForRestart(): Promise<void> {
    this.destroy();
    await Promise.all([...this.stoppingClients].map(client => client.exited));
  }

  private stopClient(client: AgentPluginStdioClient): void {
    this.stoppingClients.add(client); client.destroy();
    void client.exited.then(() => this.stoppingClients.delete(client));
  }
}
