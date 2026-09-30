/**
 * MCP client using official @modelcontextprotocol/sdk
 * Supports both HTTP and stdio transports for remote and local MCP servers
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { withMcpRequestLifetime } from './request-lifetime.ts';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Read a child process RSS without exposing command lines or credentials. */
export async function getProcessRssBytes(pid: number | undefined): Promise<number | undefined> {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === 'linux') {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      return match ? Number(match[1]) * 1024 : undefined;
    }
    if (process.platform === 'win32') {
      try {
        // PowerShell returns the native byte count and is not affected by the
        // user's tasklist locale or thousands separator.
        const { stdout } = await execFileAsync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          `$p = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::WriteLine($p.WorkingSet64)`,
        ], { windowsHide: true });
        const bytes = Number(stdout.trim());
        if (Number.isSafeInteger(bytes) && bytes > 0) return bytes;
      } catch {
        // Fall through to tasklist on minimal Windows installations.
      }
      try {
        const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
        const row = stdout.trim();
        if (row && !row.startsWith('INFO:')) {
          const fields = row.split('","').map(field => field.replace(/^"|"$/g, ''));
          const memory = fields[4];
          const match = memory?.match(/^\s*([\d.,\s]+)\s*K(?:B)?\s*$/i);
          if (match) {
            const raw = (match[1] ?? '').trim();
            const normalized = raw.includes(',') && raw.includes('.')
              ? (raw.lastIndexOf('.') > raw.lastIndexOf(',')
                ? raw.replace(/,/g, '')
                : raw.replace(/\./g, '').replace(',', '.'))
              : raw.replace(/[,\s]/g, '');
            const kilobytes = Number(normalized);
            if (Number.isFinite(kilobytes) && kilobytes > 0) return Math.round(kilobytes * 1024);
          }
        }
      } catch {
        // Fall through to the PowerShell implementation below.
      }
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::WriteLine($p.WorkingSet64)`,
      ], { windowsHide: true });
      const bytes = Number(stdout.trim());
      return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)]);
    const kb = Number(stdout.trim());
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * HTTP transport config for remote MCP servers
 */
export interface HttpMcpClientConfig {
  transport: 'http' | 'sse';
  /** Bound transport startup plus MCP initialization (default 30 seconds). */
  connectTimeoutMs?: number;
  url: string;
  headers?: Record<string, string>;
}

/**
 * Stdio transport config for local MCP servers (spawns subprocess)
 */
export interface StdioMcpClientConfig {
  transport: 'stdio';
  /** Bound transport startup plus MCP initialization (default 30 seconds). */
  connectTimeoutMs?: number;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Unified config supporting both transport types
 */
export type McpClientConfig = HttpMcpClientConfig | StdioMcpClientConfig;

/**
 * Sensitive environment variables that should NOT be passed to MCP subprocesses.
 * These could contain API keys, tokens, or credentials that MCP servers don't need
 * and shouldn't have access to.
 * NOTE: This list is duplicated in packages/session-tools-core/src/handlers/transform-data.ts (BLOCKED_ENV_VARS).
 * If you add a new entry here, update it there too.
 */
const BLOCKED_ENV_VARS = [
  // TokenBird auth (set by the app itself)
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CRAFT_SERVER_TOKEN',
  'CRAFT_RPC_TOKEN',
  'TOKENBIRD_SERVER_TOKEN',

  // AWS credentials
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',

  // Common API keys/tokens
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'STRIPE_SECRET_KEY',
  'NPM_TOKEN',
];

/**
 * Per-call options for PoolClient.callTool.
 * Forwarded to the MCP SDK's RequestOptions so aborts become protocol-level
 * cancellation notifications instead of orphaned in-flight requests.
 */
export interface PoolCallToolOptions {
  /** Cancels the in-flight request when aborted */
  signal?: AbortSignal;
  /** Request timeout in ms (SDK default applies when omitted) */
  timeoutMs?: number;
}

/**
 * Interface for clients managed by McpClientPool.
 * Both CraftMcpClient (remote MCP sources) and ApiSourcePoolClient (API sources) implement this.
 */
export interface PoolClient {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>, options?: PoolCallToolOptions): Promise<unknown>;
  close(): Promise<void>;
}

export class CraftMcpClient {
  private client: Client;
  private transport: Transport;
  private connected = false;
  private closed = false;
  private connectPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly connectTimeoutMs: number;
  readonly transportType: 'stdio' | 'http' | 'sse';
  /** Unexpected definitive SDK closure, never a request failure or cancellation. */
  onclose?: () => void;

  constructor(config: McpClientConfig) {
    this.connectTimeoutMs = config.connectTimeoutMs ?? 30_000;
    if (!Number.isFinite(this.connectTimeoutMs) || this.connectTimeoutMs <= 0) throw new Error('Invalid MCP connection timeout');
    this.client = new Client({
      name: 'craft-agent',
      version: '1.0.0',
    });
    this.client.onclose = () => {
      // This wrapper owns one transport lifetime. Recovery requires a new
      // client; retrying an already attempted request could repeat a mutation.
      const alreadyClosed = this.closed;
      this.closed = true;
      this.connected = false;
      // Explicit cleanup already belongs to its caller. In particular, an
      // initialize failure must retain its original sanitized failure reason.
      if (!alreadyClosed) this.onclose?.();
    };

    // Create transport based on config type
    if (config.transport === 'stdio') {
      this.transportType = 'stdio';
      // Stdio transport for local MCP servers - merge with process env,
      // but filter out sensitive credentials to prevent leaking secrets to subprocesses
      const processEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !BLOCKED_ENV_VARS.includes(key)) {
          processEnv[key] = value;
        }
      }
      this.transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...processEnv, ...config.env },
      });
    } else {
      this.transportType = config.transport;
      // HTTP transport for remote MCP servers
      const url = new URL(config.url);
      this.transport = config.transport === 'sse'
        ? new SSEClientTransport(url, {
          requestInit: { headers: config.headers },
          // The SDK forwards requestInit headers to EventSource and sets its
          // required Accept: text/event-stream header after merging them.
        })
        : new StreamableHTTPClientTransport(url, { requestInit: { headers: config.headers } });
    }
  }

  isConnected(): boolean { return this.connected }

  getPid(): number | undefined {
    return this.transport instanceof StdioClientTransport ? (this.transport.pid ?? undefined) : undefined;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error('MCP client is closed');
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const initialization = (async () => {
        await this.client.connect(this.transport);
        await this.client.listTools();
        if (this.closed) throw new Error('MCP client closed during connection');
        this.connected = true;
      })();
      try {
        // SDK request timers begin after transport.start. A silent SSE stream
        // can otherwise wait forever before even sending initialize.
        await Promise.race([
          initialization,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('MCP connection timed out')), this.connectTimeoutMs);
          }),
        ]);
      } catch (error) {
        // Initialization failure can leave SSE reconnection loops or a stdio
        // process alive even though connected was never set. Always close.
        await this.close().catch(() => {});
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    try { await this.connectPromise; } finally { this.connectPromise = null; }
  }

  async listTools(): Promise<Tool[]> {
    if (!this.connected) {
      await this.connect();
    }

    const result = await this.client.listTools();
    return result.tools;
  }

  /**
   * Returns server name/version reported during the MCP handshake.
   * Available after `connect()` resolves; undefined otherwise.
   */
  getServerInfo(): { name: string; version: string } | undefined {
    const info = this.client.getServerVersion();
    if (!info) return undefined;
    return { name: info.name, version: info.version };
  }

  async callTool(name: string, args: Record<string, unknown>, options?: PoolCallToolOptions): Promise<unknown> {
    if (!this.connected) {
      await this.connect();
    }

    return withMcpRequestLifetime(signal => this.client.callTool({ name, arguments: args }, undefined, {
      signal,
      ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    }), options?.signal);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.connected = false;
    this.closePromise = (async () => {
      try { await this.client.close(); }
      finally { await this.transport.close(); }
    })();
    return this.closePromise;
  }
}
