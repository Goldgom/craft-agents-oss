/**
 * Centralized MCP Client Pool
 *
 * Owns all MCP source connections in the main Electron process.
 * All backends (Claude, Pi) receive proxy tool definitions
 * and route tool calls through this pool instead of managing MCP connections
 * themselves.
 *
 * Benefits:
 * - One MCP code path for all backends
 * - One client set per live session runtime, shared by that session's backends
 * - No credential cache files — main process has direct access
 * - Runtime source switching without session restart
 *
 * A pool carries session-specific state (large-response output path and
 * summarization callback), so it must not be shared between sessions. The
 * workspace-level discovered-tools cache below is the only cross-session cache.
 */

import { CraftMcpClient, getProcessRssBytes, type McpClientConfig, type PoolCallToolOptions, type PoolClient } from './client.ts';
import { mcpRuntimeLimiter, type McpRuntimeLease } from './runtime-limiter.ts';
import { ApiSourcePoolClient } from './api-source-pool-client.ts';
import { proxyToolName } from './proxy-tool-name.ts';
import { sanitizeMcpConnectionError } from './connection-error.ts';
import type { SdkMcpServerConfig } from '../agent/backend/types.ts';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isLocalMcpEnabled } from '../workspaces/storage.ts';
import { guardLargeResult } from '../utils/large-response.ts';
import {
  saveBinaryResponse,
  detectExtensionFromMagic,
  sanitizeFilename,
} from '../utils/binary-detection.ts';

export interface CachedMcpSourceTool {
  name: string;
  description?: string;
}

/**
 * Tools already discovered by live session pools, keyed by workspace and source.
 * Catalog/settings callers may inspect this cache without creating new MCP
 * clients (which is especially important for stdio sources).
 */
const discoveredToolsByWorkspace = new Map<string, Map<string, CachedMcpSourceTool[]>>();
let nextPoolId = 1;

export function getCachedMcpSourceTools(
  workspaceRootPath: string,
  sourceSlug: string,
): CachedMcpSourceTool[] | undefined {
  const tools = discoveredToolsByWorkspace.get(workspaceRootPath)?.get(sourceSlug);
  return tools?.map(tool => ({ ...tool }));
}

/**
 * Configuration for an in-process API source server.
 * Used by sync() to connect API sources alongside MCP sources.
 */
export interface ApiServerConfig {
  type: 'sdk';
  instance: McpServer;
}

/**
 * Proxy tool definition — the format passed to backends for registration.
 * Uses mcp__{slug}__{toolName} naming convention.
 */
export interface ProxyToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Result of an MCP tool call, matching the subprocess protocol format.
 */
export interface McpToolResult {
  content: string;
  isError: boolean;
  /** Source slug for error attribution (set on failure) */
  sourceSlug?: string;
}

/**
 * Convert SdkMcpServerConfig (used by backend types) to CraftMcpClient config.
 */
function sdkConfigToClientConfig(config: SdkMcpServerConfig): McpClientConfig | null {
  if (config.type === 'http' || config.type === 'sse') {
    return {
      transport: config.type,
      url: config.url,
      headers: config.headers,
    };
  }
  if (config.type === 'stdio') {
    return {
      transport: 'stdio',
      command: config.command,
      args: config.args,
      env: config.env,
    };
  }
  return null;
}

/** Compare maps without depending on insertion order or logging their secret values. */
function equalConfigMap(a: Record<string, string> = {}, b: Record<string, string> = {}, caseInsensitiveKeys = false): boolean {
  const normalize = (value: Record<string, string>) => Object.entries(value)
    .map(([key, entry]) => [caseInsensitiveKeys ? key.toLowerCase() : key, entry] as const)
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB));
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/** Reconnect whenever effective transport settings or credentials change. */
function mcpConfigChanged(oldConfig: SdkMcpServerConfig, newConfig: SdkMcpServerConfig): boolean {
  if (oldConfig.type !== newConfig.type) return true;

  if (
    (oldConfig.type === 'http' || oldConfig.type === 'sse') &&
    (newConfig.type === 'http' || newConfig.type === 'sse')
  ) {
    // API keys and custom auth headers matter just as much as Authorization.
    return oldConfig.url !== newConfig.url
      || !equalConfigMap(oldConfig.headers, newConfig.headers, true)
      || oldConfig.bearerTokenEnvVar !== newConfig.bearerTokenEnvVar;
  }

  if (oldConfig.type === 'stdio' && newConfig.type === 'stdio') {
    return oldConfig.command !== newConfig.command
      || JSON.stringify(oldConfig.args ?? []) !== JSON.stringify(newConfig.args ?? [])
      || !equalConfigMap(oldConfig.env, newConfig.env)
      || oldConfig.cwd !== newConfig.cwd
      || JSON.stringify([...(oldConfig.envVars ?? [])].sort()) !== JSON.stringify([...(newConfig.envVars ?? [])].sort());
  }
  return false;
}

/** Errors whose public text was constructed locally, without provider details. */
class McpPoolError extends Error {}

/** One immutable ownership token for a queued, connecting, or live source. */
interface SourceConnection {
  slug: string;
  runtimeKey?: string;
  config?: SdkMcpServerConfig;
  server?: McpServer;
  client?: PoolClient;
  promise: Promise<void>;
  previousClose: Promise<void>;
  closePromise?: Promise<void>;
  transportClosed?: boolean;
  waitingCalls: number;
  handshakeLease?: McpRuntimeLease;
}

/** Retain transport values, not a caller-owned object that may later be mutated. */
function snapshotConfig(config: SdkMcpServerConfig): SdkMcpServerConfig {
  if (config.type === 'http' || config.type === 'sse') {
    return { ...config, headers: config.headers ? { ...config.headers } : undefined };
  }
  if (config.type === 'stdio') {
    return { ...config, args: config.args?.slice(), env: config.env ? { ...config.env } : undefined, envVars: config.envVars?.slice() };
  }
  return { ...config };
}

export class McpClientPool {
  /** Unique namespace so two sessions using the same source slug do not share a slot. */
  private readonly poolId = nextPoolId++;

  /** Active MCP clients keyed by source slug */
  private clients = new Map<string, PoolClient>();

  /** Configs used for active MCP connections (for change detection during sync) */
  protected activeConfigs = new Map<string, SdkMcpServerConfig>();

  /** Cached tool lists keyed by source slug */
  private toolCache = new Map<string, Tool[]>();

  /** Owners are installed synchronously, before waiting for slots or handshakes. */
  private connections = new Map<string, SourceConnection>();
  private clientConnections = new WeakMap<PoolClient, SourceConnection>();
  private clientCloses = new WeakMap<PoolClient, Promise<void>>();
  private closing = new Set<Promise<void>>();
  private closingBySlug = new Map<string, Promise<void>>();
  private nextGeneration = 1;
  private syncGeneration = 0;

  /** Proxy tool name → { slug, originalName } (e.g., "mcp__linear__createIssue" → { slug: "linear", originalName: "createIssue" }) */
  private proxyTools = new Map<string, { slug: string; originalName: string }>();

  /** Optional debug logger */
  private debugFn: ((msg: string) => void) | undefined;

  /** Workspace root path for local MCP filtering */
  private workspaceRootPath?: string;

  /** Session storage path for saving large responses */
  private sessionPath?: string;

  /** Summarize callback for large response handling */
  private summarizeCallback?: (prompt: string) => Promise<string | null>;

  /** Called after sync() connects/disconnects sources, so clients can be notified */
  onToolsChanged?: () => void;

  constructor(options?: { debug?: (msg: string) => void; workspaceRootPath?: string; sessionPath?: string }) {
    this.debugFn = options?.debug;
    this.workspaceRootPath = options?.workspaceRootPath;
    this.sessionPath = options?.sessionPath;
  }

  private closeClient(client: PoolClient): Promise<void> {
    let closing = this.clientCloses.get(client);
    if (!closing) {
      closing = Promise.resolve().then(() => client.close()).catch(() => {});
      this.clientCloses.set(client, closing);
    }
    return closing;
  }

  private closeConnection(connection: SourceConnection): Promise<void> {
    if (connection.closePromise) return connection.closePromise;
    if (connection.runtimeKey) mcpRuntimeLimiter.cancelQueued(connection.runtimeKey, new McpPoolError('MCP source connection was cancelled'));
    // Hold the old slot until its resource has closed. A replacement waits for
    // this close, but never for an obsolete handshake to finish.
    const closed = Promise.all([
      connection.previousClose,
      connection.client ? this.closeClient(connection.client) : Promise.resolve(),
    ]).then(() => {
      if (connection.runtimeKey) mcpRuntimeLimiter.unregister(connection.runtimeKey);
    });
    connection.closePromise = closed;
    this.closing.add(closed);
    this.closingBySlug.set(connection.slug, closed);
    void closed.then(() => {
      this.closing.delete(closed);
      if (this.closingBySlug.get(connection.slug) === closed) this.closingBySlug.delete(connection.slug);
    });
    return closed;
  }

  private async evictRuntime(connection: SourceConnection): Promise<void> {
    if (this.connections.get(connection.slug) === connection) {
      this.connections.delete(connection.slug);
      this.clients.delete(connection.slug);
    }
    // Keep the desired config and discovered tools for lazy reconnects.
    await this.closeConnection(connection);
    this.debug(`Soft-evicted idle MCP runtime ${connection.slug}`);
  }

  private onClientClosed(connection: SourceConnection): void {
    // An old close notification must never retire a successor or recreate a
    // source deliberately removed by disconnect()/disconnectAll().
    if (this.connections.get(connection.slug) !== connection) return;
    connection.transportClosed = true;
    this.connections.delete(connection.slug);
    if (this.clients.get(connection.slug) === connection.client) this.clients.delete(connection.slug);
    // Keep desired config and catalog for a later new call/connect/sync. There
    // is no automatic reconnect or replay of the call that observed the exit.
    void this.closeConnection(connection);
  }

  private async runWithClient<T>(sourceSlug: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const run = (client: PoolClient) => {
      const connection = this.clientConnections.get(client);
      return connection?.runtimeKey
        ? mcpRuntimeLimiter.run(connection.runtimeKey, () => operation(client))
        : operation(client);
    };
    const existing = this.clients.get(sourceSlug);
    // Claim the live slot synchronously, without a gap where soft eviction can
    // close it between fetching a client and entering limiter.run().
    if (existing) return run(existing);
    let connection = this.connections.get(sourceSlug);
    let ready = connection?.promise;
    if (!connection) {
      const config = this.activeConfigs.get(sourceSlug);
      if (!config) throw new McpPoolError(`MCP source "${sourceSlug}" is not configured`);
      ready = this.connect(sourceSlug, config);
      connection = this.connections.get(sourceSlug);
    }
    if (!connection) throw new McpPoolError(`MCP source "${sourceSlug}" could not be connected`);
    // Transfer the handshake reservation to waiting calls. In particular,
    // softLimit=0 must not evict a freshly reconnected client before its caller
    // has had a chance to enter run(). All callers share the same handshake.
    connection.waitingCalls++;
    try {
      await ready;
      const client = this.clients.get(sourceSlug);
      if (!client || this.connections.get(sourceSlug) !== connection) {
        throw new McpPoolError(`MCP source "${sourceSlug}" was disconnected during connection`);
      }
      return await run(client);
    } finally {
      connection.waitingCalls--;
      if (connection.waitingCalls === 0) {
        connection.handshakeLease?.release();
        connection.handshakeLease = undefined;
      }
    }
  }

  getDiagnostics(): Array<{ sourceSlug: string; transport: 'stdio' | 'http' | 'sse' | 'api'; connected: boolean; toolCount: number }> {
    return Array.from(this.clients.entries()).map(([sourceSlug, client]) => ({
      sourceSlug,
      transport: client instanceof CraftMcpClient ? client.transportType : 'api',
      connected: client instanceof CraftMcpClient ? client.isConnected() : true,
      toolCount: this.toolCache.get(sourceSlug)?.length ?? 0,
    }))
  }

  async getDiagnosticsWithMemory(): Promise<Array<{ sourceSlug: string; transport: 'stdio' | 'http' | 'sse' | 'api'; connected: boolean; toolCount: number; pid?: number; rssBytes?: number }>> {
    const diagnostics = this.getDiagnostics();
    return Promise.all(diagnostics.map(async diagnostic => {
      const client = this.clients.get(diagnostic.sourceSlug);
      const pid = client instanceof CraftMcpClient ? client.getPid() : undefined;
      return { ...diagnostic, pid, rssBytes: await getProcessRssBytes(pid) };
    }));
  }

  /**
   * Set the summarize callback for large response handling.
   * Typically called after agent creation: pool.setSummarizeCallback(agent.getSummarizeCallback())
   */
  setSummarizeCallback(fn: (prompt: string) => Promise<string | null>): void {
    this.summarizeCallback = fn;
  }

  private debug(msg: string): void {
    this.debugFn?.(`[McpClientPool] ${msg}`);
  }

  // ============================================================
  // Connection Lifecycle
  // ============================================================

  /**
   * Register a client: connect, cache tools, build proxy mappings.
   * Shared logic for both remote MCP and in-process API sources.
   */
  protected async registerClient(slug: string, client: PoolClient): Promise<void> {
    // listTools() triggers connect() internally for both CraftMcpClient and ApiSourcePoolClient
    const tools = await client.listTools();
    const connection = this.clientConnections.get(client);
    // Never publish an obsolete handshake, including to the workspace cache.
    if (connection && this.connections.get(slug) !== connection) return;
    for (const [proxyName, info] of this.proxyTools) {
      if (info.slug === slug) this.proxyTools.delete(proxyName);
    }
    this.clients.set(slug, client);
    this.toolCache.set(slug, tools);
    if (this.workspaceRootPath) {
      let workspaceCache = discoveredToolsByWorkspace.get(this.workspaceRootPath);
      if (!workspaceCache) {
        workspaceCache = new Map();
        discoveredToolsByWorkspace.set(this.workspaceRootPath, workspaceCache);
      }
      workspaceCache.set(slug, tools.map(tool => ({
        name: tool.name,
        description: tool.description,
      })));
    }

    for (const tool of tools) {
      const proxyName = proxyToolName(slug, tool.name);
      const existing = this.proxyTools.get(proxyName);
      if (existing && existing.originalName !== tool.name) {
        // Two distinct MCP tool names sanitized to the same proxy name (e.g.
        // `pat.batch` and `pat_batch`). Keep the first; a silent overwrite would
        // route later calls to the wrong original tool (#864). Known limitation:
        // the skipped tool is not callable this session — deterministic
        // disambiguation (suffixing) is a possible follow-up if this ever hits
        // a real server. Warn loudly so a "missing" tool is diagnosable.
        console.warn(`[McpClientPool] Proxy name collision on ${proxyName} (source ${slug}): keeping ${existing.originalName}, skipping ${tool.name} — the skipped tool will not be callable`);
        this.debug(`Proxy name collision on ${proxyName}: keeping ${existing.originalName}, skipping ${tool.name}`);
        continue;
      }
      this.proxyTools.set(proxyName, { slug, originalName: tool.name });
    }

    this.debug(`Connected source ${slug}: ${tools.length} tools`);
  }

  /**
   * Connect one MCP source, sharing equivalent pending/live connections and
   * replacing changed transport settings with a new ownership generation.
   */
  async connect(slug: string, config: SdkMcpServerConfig): Promise<void> {
    const current = this.connections.get(slug);
    if (current?.config && !mcpConfigChanged(current.config, config)) return current.promise;
    const savedConfig = snapshotConfig(config);
    const clientConfig = sdkConfigToClientConfig(savedConfig);
    if (!clientConfig) {
      this.debug(`Unknown MCP server type for ${slug}: ${(config as { type: string }).type}`);
      return;
    }
    // disconnect() invalidates synchronously. Install the successor before any
    // await so concurrent callers cannot create a second equivalent handshake.
    const oldConfig = this.activeConfigs.get(slug);
    const lazyReconnect = !current && !this.clients.has(slug) && oldConfig && !mcpConfigChanged(oldConfig, savedConfig);
    // Soft eviction deliberately retained the catalog. Keep it visible while
    // reconnecting so another queued call can still resolve its proxy name.
    const previousClose = lazyReconnect ? (this.closingBySlug.get(slug) ?? Promise.resolve()) : this.disconnect(slug);
    const connection: SourceConnection = {
      slug, config: savedConfig, previousClose, promise: Promise.resolve(), waitingCalls: 0,
      runtimeKey: `${this.poolId}:${slug}:${this.nextGeneration++}`,
    };
    this.connections.set(slug, connection);
    this.activeConfigs.set(slug, savedConfig);
    connection.promise = this.openConnection(connection, () => new CraftMcpClient(clientConfig));
    return connection.promise;
  }

  private async openConnection(connection: SourceConnection, createClient: () => PoolClient): Promise<void> {
    let lease: Awaited<ReturnType<typeof mcpRuntimeLimiter.acquire>> | undefined;
    try {
      await connection.previousClose;
      if (this.connections.get(connection.slug) !== connection) return;
      if (connection.runtimeKey) {
        lease = await mcpRuntimeLimiter.acquire(
          connection.runtimeKey,
          () => this.evictRuntime(connection),
          async () => connection.client instanceof CraftMcpClient
            ? getProcessRssBytes(connection.client.getPid()) : undefined,
        );
      }
      if (this.connections.get(connection.slug) !== connection) {
        // Cancellation may have raced with the limiter granting this lease.
        if (connection.runtimeKey) mcpRuntimeLimiter.unregister(connection.runtimeKey);
        return;
      }
      try {
        const client = createClient();
        connection.client = client;
        this.clientConnections.set(client, connection);
        if (client instanceof CraftMcpClient) client.onclose = () => this.onClientClosed(connection);
        await this.registerClient(connection.slug, client);
        // A successful discovery response can race with transport closure
        // before its continuation publishes readiness. Do not report success
        // for this dead generation, even if no request remains to reject.
        if (connection.transportClosed) throw new Error('MCP source closed during connection');
      } catch (error) {
        // SDK/provider errors can echo URLs, headers, or response-body secrets.
        // Do not retain their cause, message, or stack outside this boundary.
        // The SDK also emits close when initialization fails. Preserve that
        // failure's diagnosis rather than mistaking its retirement for a
        // caller superseding or disconnecting this generation.
        throw new McpPoolError(this.connections.get(connection.slug) === connection || connection.transportClosed
          ? sanitizeMcpConnectionError(error).message
          : 'MCP source connection was superseded or disconnected');
      }
      if (this.connections.get(connection.slug) !== connection) await this.closeConnection(connection);
    } catch (error) {
      if (this.connections.get(connection.slug) === connection) this.connections.delete(connection.slug);
      await this.closeConnection(connection);
      throw error;
    } finally {
      if (connection.waitingCalls > 0) connection.handshakeLease = lease;
      else lease?.release();
    }
  }

  /** Connect an in-process API source using the same ownership rules. */
  async connectInProcess(slug: string, mcpServer: McpServer): Promise<void> {
    const current = this.connections.get(slug);
    if (current?.server === mcpServer) return current.promise;
    // Existing API servers are retained across syncs, which rebuild wrappers.
    if (current?.server && this.clients.has(slug)) return;
    const previousClose = this.disconnect(slug);
    const connection: SourceConnection = {
      slug, server: mcpServer, previousClose, promise: Promise.resolve(), waitingCalls: 0,
    };
    this.connections.set(slug, connection);
    connection.promise = this.openConnection(connection, () => new ApiSourcePoolClient(mcpServer));
    return connection.promise;
  }

  /**
   * Ensure one source without touching other members; enforce the same local
   * MCP gate as sync() before sharing or creating a connection.
   */
  async ensureConnected(slug: string, config: SdkMcpServerConfig): Promise<void> {
    if (config.type === 'stdio' && this.workspaceRootPath && !isLocalMcpEnabled(this.workspaceRootPath)) {
      throw new Error(`Local MCP is disabled for this workspace — cannot connect stdio source "${slug}"`);
    }
    await this.connect(slug, config);
  }

  /** Invalidate a source before awaiting any transport cleanup. */
  async disconnect(slug: string): Promise<void> {
    const connection = this.connections.get(slug);
    const client = this.clients.get(slug);
    this.connections.delete(slug);
    this.clients.delete(slug);
    for (const [proxyName, info] of this.proxyTools) {
      if (info.slug === slug) this.proxyTools.delete(proxyName);
    }
    this.toolCache.delete(slug);
    this.activeConfigs.delete(slug);
    if (connection) await this.closeConnection(connection);
    else if (client) await this.closeClient(client);
    else await this.closingBySlug.get(slug);
    this.debug(`Disconnected source: ${slug}`);
  }

  /** Close the current snapshot, including pending handshakes and older closes. */
  async disconnectAll(): Promise<void> {
    ++this.syncGeneration;
    const slugs = new Set([...this.connections.keys(), ...this.clients.keys(), ...this.activeConfigs.keys()]);
    const closePromises = Array.from(slugs, slug => this.disconnect(slug));
    await Promise.all([...closePromises, ...this.closing]);
    // No post-await clear: a new connection may have been requested meanwhile.
    await mcpRuntimeLimiter.enforceLimits();
    this.debug('Disconnected all MCP clients');
  }

  // ============================================================
  // Sync: Reconcile active sources
  // ============================================================

  /**
   * Sync the pool to match a desired set of MCP + API sources.
   * Connects new sources, disconnects removed ones, keeps existing ones.
   *
   * @param mcpServers - Map of slug → config for desired MCP sources
   * @param apiServers - Map of slug → config for desired API sources
   * @returns List of slugs that failed to connect
   */
  async sync(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, ApiServerConfig> = {}
  ): Promise<string[]> {
    const generation = ++this.syncGeneration;
    // Filter out stdio sources when local MCP is disabled for this workspace.
    const localEnabled = !this.workspaceRootPath || isLocalMcpEnabled(this.workspaceRootPath);
    const filteredMcp: Record<string, SdkMcpServerConfig> = {};
    for (const [slug, config] of Object.entries(mcpServers)) {
      if (config.type === 'stdio' && !localEnabled) {
        this.debug(`Filtering out stdio source "${slug}" (local MCP disabled)`);
        continue;
      }
      filteredMcp[slug] = config;
    }

    // Extract McpServer instances from API configs
    const apiSlugs = new Map<string, McpServer>();
    for (const [slug, config] of Object.entries(apiServers)) {
      if (config?.type === 'sdk' && config.instance) {
        apiSlugs.set(slug, config.instance);
      }
    }

    const desiredSlugs = new Set([...Object.keys(filteredMcp), ...apiSlugs.keys()]);
    const failures: string[] = [];

    // Disconnect sources no longer desired
    for (const slug of new Set([...this.connections.keys(), ...this.clients.keys(), ...this.activeConfigs.keys()])) {
      if (!desiredSlugs.has(slug)) {
        await this.disconnect(slug);
        if (generation !== this.syncGeneration) return failures;
      }
    }

    // Connect MCP sources through the process-wide limiter. If the hard limit
    // is full, connect() waits in FIFO order. The tool cache survives soft
    // eviction, so the backend can keep advertising tools while runtimes are
    // swapped in only when a call actually needs them.
    for (const [slug, config] of Object.entries(filteredMcp)) {
      try {
        await this.ensureConnected(slug, config);
      } catch (err) {
        this.debug(`Failed to connect MCP source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
        failures.push(slug);
      }
      if (generation !== this.syncGeneration) return failures;
    }

    for (const [slug, server] of apiSlugs) {
      try {
        await this.connectInProcess(slug, server);
      } catch (err) {
        this.debug(`Failed to connect API source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
        failures.push(slug);
      }
      if (generation !== this.syncGeneration) return failures;
    }

    await mcpRuntimeLimiter.enforceLimits();
    this.onToolsChanged?.();
    return failures;
  }

  // ============================================================
  // Tool Discovery
  // ============================================================

  /**
   * Get cached tools for a source. Returns empty array if not connected.
   */
  getTools(slug: string): Tool[] {
    return this.toolCache.get(slug) || [];
  }

  /**
   * Get all connected source slugs.
   */
  getConnectedSlugs(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Check if a source is connected.
   */
  isConnected(slug: string): boolean {
    return this.clients.has(slug);
  }

  /**
   * Generate proxy tool definitions for all connected sources (or a subset).
   * These are passed to backends for tool registration.
   */
  getProxyToolDefs(slugs?: string[]): ProxyToolDef[] {
    const targetSlugs = slugs || Array.from(this.toolCache.keys());
    const defs: ProxyToolDef[] = [];
    const seen = new Set<string>();

    for (const slug of targetSlugs) {
      const tools = this.toolCache.get(slug) || [];
      for (const tool of tools) {
        const name = proxyToolName(slug, tool.name);
        // Skip a name that collided after sanitization — keep the first, matching
        // registerClient so the emitted defs and the dispatch map stay in sync (#864).
        if (seen.has(name)) continue;
        seen.add(name);
        // Strip $schema — AJV (Pi agent) fails on unregistered meta-schema URIs.
        // Same pattern as getToolDefsAsJsonSchema() in tool-defs.ts.
        const { $schema, ...cleanSchema } = (tool.inputSchema as Record<string, unknown>) || {};
        defs.push({
          name,
          description: tool.description || `Tool from ${slug}`,
          inputSchema: Object.keys(cleanSchema).length > 0 ? cleanSchema : { type: 'object', properties: {} },
        });
      }
    }

    return defs;
  }

  // ============================================================
  // Tool Execution
  // ============================================================

  /**
   * Execute an MCP tool by its proxy name (mcp__{slug}__{toolName}).
   * Returns a result matching the subprocess protocol format.
   */
  async callTool(proxyName: string, args: Record<string, unknown>, options?: PoolCallToolOptions): Promise<McpToolResult> {
    const info = this.proxyTools.get(proxyName);
    if (!info) {
      return {
        content: `Unknown MCP proxy tool: ${proxyName}`,
        isError: true,
      };
    }

    const { slug, originalName } = info;

    try {
      const result = await this.runWithClient(slug, client => {
        if (options?.signal?.aborted) throw new McpPoolError('MCP tool request was cancelled before it was sent');
        return client.callTool(originalName, args, options);
      }) as {
        content?: Array<{ type: string; text?: unknown; data?: string; mimeType?: string }>;
        isError?: boolean;
      };

      const contentBlocks = result.content || [];
      const parts: string[] = [];

      // 1. Process each content block — handle text, image, audio
      for (const block of contentBlocks) {
        if (block.type === 'text') {
          // Handle non-string text fields (e.g., objects from non-conforming servers)
          if (typeof block.text === 'string') {
            parts.push(block.text);
          } else if (block.text !== undefined && block.text !== null) {
            parts.push(JSON.stringify(block.text, null, 2));
          }
        } else if ((block.type === 'image' || block.type === 'audio') && block.data && this.sessionPath) {
          // Decode base64 binary content and save to downloads/
          try {
            const buffer = Buffer.from(block.data, 'base64');
            const ext = detectExtensionFromMagic(buffer) || '.bin';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const safeName = sanitizeFilename(proxyName);
            const filename = `${safeName}_${timestamp}${ext}`;
            const saved = saveBinaryResponse(this.sessionPath, filename, buffer, block.mimeType ?? null);
            if (saved.type === 'file_download') {
              parts.push(`[${block.type.charAt(0).toUpperCase() + block.type.slice(1)} saved: ${saved.path} (${saved.sizeHuman})]`);
            }
          } catch {
            // Base64 decode failed — skip this block
          }
        }
      }

      // 2. Combine parts (fallback to JSON.stringify if no content extracted)
      const text = parts.join('\n') || JSON.stringify(result);

      // 3. Centralized binary + large response handling
      if (!result.isError && this.sessionPath) {
        const guarded = await guardLargeResult(text, {
          sessionPath: this.sessionPath,
          toolName: proxyName,
          input: args,
          summarize: this.summarizeCallback,
        });
        if (guarded) {
          return { content: guarded, isError: false };
        }
      }

      return {
        content: text,
        isError: !!result.isError,
      };
    } catch (err) {
      return {
        content: err instanceof McpPoolError
          ? err.message
          : 'MCP tool request failed. The outcome may be unknown; check the remote state before retrying.',
        isError: true,
        sourceSlug: slug,
      };
    }
  }

  /**
   * Check if a tool name is an MCP proxy tool managed by this pool.
   */
  isProxyTool(toolName: string): boolean {
    return this.proxyTools.has(toolName);
  }
}
