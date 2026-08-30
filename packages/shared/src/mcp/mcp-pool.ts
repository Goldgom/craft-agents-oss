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

import { CraftMcpClient, getProcessRssBytes, type McpClientConfig, type PoolClient } from './client.ts';
import { mcpRuntimeLimiter } from './runtime-limiter.ts';
import { ApiSourcePoolClient } from './api-source-pool-client.ts';
import { proxyToolName } from './proxy-tool-name.ts';
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
      transport: 'http',
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

/**
 * Check if an MCP source's config has changed in a way that requires reconnection.
 * Compares auth headers (token refresh) and URL changes.
 * Ignores stdio sources since they don't use OAuth tokens.
 */
function mcpConfigChanged(oldConfig: SdkMcpServerConfig, newConfig: SdkMcpServerConfig): boolean {
  if (oldConfig.type !== newConfig.type) return true;

  if (
    (oldConfig.type === 'http' || oldConfig.type === 'sse') &&
    (newConfig.type === 'http' || newConfig.type === 'sse')
  ) {
    if (oldConfig.url !== newConfig.url) return true;
    const oldAuth = oldConfig.headers?.['Authorization'];
    const newAuth = newConfig.headers?.['Authorization'];
    if (oldAuth !== newAuth) return true;
  }

  return false;
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

  /** Deduplicates reconnects when several queued calls wake for one source. */
  private connecting = new Map<string, Promise<void>>();

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

  private runtimeKey(sourceSlug: string): string {
    return `${this.poolId}:${sourceSlug}`;
  }

  private async evictRuntime(sourceSlug: string): Promise<void> {
    const client = this.clients.get(sourceSlug);
    if (!(client instanceof CraftMcpClient)) return;
    // Remove it before awaiting close(). A concurrent tool call must not grab
    // a client whose limiter slot has already been released; it will then
    // follow the normal queued reconnect path instead.
    if (this.clients.get(sourceSlug) === client) this.clients.delete(sourceSlug);
    await client.close().catch(() => {});
    this.debug(`Soft-evicted idle MCP runtime ${sourceSlug}`);
  }

  private async ensureConnected(sourceSlug: string): Promise<PoolClient | undefined> {
    const existing = this.clients.get(sourceSlug);
    if (existing) return existing;
    const config = this.activeConfigs.get(sourceSlug);
    if (!config) return undefined;

    const pending = this.connecting.get(sourceSlug);
    if (pending) {
      await pending;
      return this.clients.get(sourceSlug);
    }
    const connection = this.connect(sourceSlug, config);
    this.connecting.set(sourceSlug, connection);
    try {
      await connection;
    } finally {
      if (this.connecting.get(sourceSlug) === connection) this.connecting.delete(sourceSlug);
    }
    return this.clients.get(sourceSlug);
  }

  getDiagnostics(): Array<{ sourceSlug: string; transport: 'stdio' | 'http' | 'api'; connected: boolean; toolCount: number }> {
    return Array.from(this.clients.entries()).map(([sourceSlug, client]) => ({
      sourceSlug,
      transport: client instanceof CraftMcpClient ? client.transportType : 'api',
      connected: client instanceof CraftMcpClient ? client.isConnected() : true,
      toolCount: this.toolCache.get(sourceSlug)?.length ?? 0,
    }))
  }

  async getDiagnosticsWithMemory(): Promise<Array<{ sourceSlug: string; transport: 'stdio' | 'http' | 'api'; connected: boolean; toolCount: number; pid?: number; rssBytes?: number }>> {
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
   * Connect to an MCP source server (remote HTTP/SSE/stdio).
   * If already connected, this is a no-op.
   */
  async connect(slug: string, config: SdkMcpServerConfig): Promise<void> {
    if (this.clients.has(slug)) return;
    const clientConfig = sdkConfigToClientConfig(config);
    if (!clientConfig) {
      this.debug(`Unknown MCP server type for ${slug}: ${(config as { type: string }).type}`);
      return;
    }
    // Keep the desired config visible while a connection is waiting for a
    // hard-limit slot. This also lets disconnect() invalidate queued work.
    this.activeConfigs.set(slug, config);
    const key = this.runtimeKey(slug);
    const lease = await mcpRuntimeLimiter.acquire(
      key,
      () => this.evictRuntime(slug),
      async () => {
        const current = this.clients.get(slug);
        return current instanceof CraftMcpClient ? getProcessRssBytes(current.getPid()) : undefined;
      },
    );
    if (this.clients.has(slug) || this.activeConfigs.get(slug) !== config) {
      // The source was connected or removed while this request was queued.
      lease.release();
      return;
    }
    const client = new CraftMcpClient(clientConfig);
    try {
      await this.registerClient(slug, client);
      if (this.activeConfigs.get(slug) !== config) {
        // disconnect() also removes the proxy/tool cache entries registered
        // above, so a cancelled handshake cannot leave a stale client behind.
        await this.disconnect(slug);
        return;
      }
    } catch (error) {
      await client.close().catch(() => {});
      mcpRuntimeLimiter.unregister(key);
      throw error;
    } finally {
      lease.release();
    }
  }

  /**
   * Connect to an in-process MCP server (API source) via in-memory transport.
   */
  async connectInProcess(slug: string, mcpServer: McpServer): Promise<void> {
    if (this.clients.has(slug)) return;
    await this.registerClient(slug, new ApiSourcePoolClient(mcpServer));
  }

  /**
   * Disconnect a source and remove its tools from the pool.
   */
  async disconnect(slug: string): Promise<void> {
    const key = this.runtimeKey(slug);
    mcpRuntimeLimiter.cancelQueued(key);
    const client = this.clients.get(slug);
    if (client) {
      await client.close().catch(() => {});
      this.clients.delete(slug);
    }
    if (client instanceof CraftMcpClient) mcpRuntimeLimiter.unregister(key);

    // Remove proxy tool entries for this slug
    for (const [proxyName, info] of this.proxyTools) {
      if (info.slug === slug) this.proxyTools.delete(proxyName);
    }
    this.toolCache.delete(slug);
    this.activeConfigs.delete(slug);
    this.debug(`Disconnected source: ${slug}`);
  }

  /**
   * Disconnect all sources and clear all state.
   */
  async disconnectAll(): Promise<void> {
    const slugs = new Set([...this.clients.keys(), ...this.activeConfigs.keys()]);
    const closePromises = Array.from(slugs).map(async slug => {
      const key = this.runtimeKey(slug);
      mcpRuntimeLimiter.cancelQueued(key);
      const client = this.clients.get(slug);
      if (client instanceof CraftMcpClient) mcpRuntimeLimiter.unregister(key);
      await client?.close().catch(() => {});
    });
    await Promise.all(closePromises);
    this.clients.clear();
    this.toolCache.clear();
    this.proxyTools.clear();
    this.activeConfigs.clear();
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
    for (const slug of new Set([...this.clients.keys(), ...this.activeConfigs.keys()])) {
      if (!desiredSlugs.has(slug)) {
        await this.disconnect(slug);
      }
    }

    // Connect MCP sources through the process-wide limiter. If the hard limit
    // is full, connect() waits in FIFO order. The tool cache survives soft
    // eviction, so the backend can keep advertising tools while runtimes are
    // swapped in only when a call actually needs them.
    for (const [slug, config] of Object.entries(filteredMcp)) {
      const oldConfig = this.activeConfigs.get(slug);
      if (oldConfig && mcpConfigChanged(oldConfig, config)) {
        this.debug(`Config changed for ${slug}, reconnecting with fresh credentials`);
        await this.disconnect(slug);
      }
      this.activeConfigs.set(slug, config);
      if (!this.clients.has(slug)) {
        try {
          await this.connect(slug, config);
        } catch (err) {
          this.debug(`Failed to connect MCP source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
          failures.push(slug);
        }
      }
    }

    // Connect new API sources
    for (const [slug, server] of apiSlugs) {
      if (!this.clients.has(slug)) {
        try {
          await this.connectInProcess(slug, server);
        } catch (err) {
          this.debug(`Failed to connect API source ${slug}: ${err instanceof Error ? err.message : String(err)}`);
          failures.push(slug);
        }
      }
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
  async callTool(proxyName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const info = this.proxyTools.get(proxyName);
    if (!info) {
      return {
        content: `Unknown MCP proxy tool: ${proxyName}`,
        isError: true,
      };
    }

    const { slug, originalName } = info;

    let client: PoolClient | undefined;
    try {
      client = await this.ensureConnected(slug);
    } catch (err) {
      return {
        content: `MCP client for source "${slug}" could not be connected: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        sourceSlug: slug,
      };
    }
    if (!client) {
      return {
        content: `MCP client for source "${slug}" is not configured or could not be connected.`,
        isError: true,
        sourceSlug: slug,
      };
    }

    try {
      const call = () => client.callTool(originalName, args)
      const result = await (client instanceof CraftMcpClient
        ? mcpRuntimeLimiter.run(this.runtimeKey(slug), call)
        : call()) as {
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
        content: `MCP tool "${originalName}" (source: ${slug}) failed: ${err instanceof Error ? err.message : String(err)}`,
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
