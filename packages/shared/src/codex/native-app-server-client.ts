import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { APP_VERSION } from '../version/index.ts';
import { killProcessTreeAsync } from '../utils/process-tree.ts';
import type {
  InitializeParams,
  InitializeResponse,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  RequestId,
} from './native-protocol.ts';

export interface NativeCodexClientOptions {
  codexPath: string;
  workDir: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  onDebug?: (message: string) => void;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface NativeCodexServerRequest {
  id: RequestId;
  method: string;
  params: unknown;
}

/** JSONL JSON-RPC client for the experimental native Codex app-server. */
export class NativeCodexAppServerClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private reader: ReadlineInterface | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private state: 'disconnected' | 'connecting' | 'connected' | 'disconnecting' = 'disconnected';
  private stderrChunks: string[] = [];
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: NativeCodexClientOptions) {
    super();
    // EventEmitter treats an unhandled "error" event as fatal. Keep the client
    // safe for simple probes while still delivering the event to real listeners.
    this.on('error', () => undefined);
  }

  get processId(): number | undefined { return this.child?.pid; }
  get isConnected(): boolean { return this.state === 'connected' && !!this.child?.stdin?.writable; }
  get recentStderr(): string { return this.stderrChunks.join('\n').slice(-8_192); }

  async connect(): Promise<InitializeResponse> {
    if (this.state !== 'disconnected') throw new Error(`Codex app-server is ${this.state}`);
    this.state = 'connecting';

    try {
      this.child = spawn(this.options.codexPath, ['app-server', '--listen', 'stdio://'], {
        cwd: this.options.workDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, FORCE_COLOR: '0', ...this.options.env },
      });
      this.child.once('error', error => this.handleExit(error));
      this.child.once('exit', (code, signal) => {
        const suffix = this.recentStderr ? `\n${this.recentStderr}` : '';
        this.handleExit(new Error(`Codex app-server exited (code=${code}, signal=${signal})${suffix}`));
      });
      if (!this.child.stdout || !this.child.stdin) throw new Error('Codex app-server stdio is unavailable');

      this.reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
      this.reader.on('line', line => this.handleLine(line));
      this.child.stderr?.on('data', chunk => this.recordStderr(String(chunk)));

      const params: InitializeParams = {
        clientInfo: { name: 'craft-agents', title: 'Craft Agents', version: APP_VERSION },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: null,
          extensions: null,
        },
      };
      const initialized = await this.request<InitializeResponse>('initialize', params);
      await this.notify('initialized', {});
      this.state = 'connected';
      this.emit('connected', initialized);
      return initialized;
    } catch (error) {
      await this.disconnect().catch(() => undefined);
      throw error;
    }
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.child?.stdin?.writable) throw new Error('Codex app-server is not connected');
    const id = String(this.nextId++);
    const timeoutMs = this.options.requestTimeoutMs ?? 30_000;
    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
    });
    try {
      await this.write({ jsonrpc: '2.0', id, method, params } satisfies JsonRpcRequest);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
      }
      throw error;
    }
    return promise;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.write({ jsonrpc: '2.0', method, params } satisfies JsonRpcNotification);
  }

  async respond(id: RequestId, result: unknown): Promise<void> {
    await this.write({ jsonrpc: '2.0', id, result } satisfies JsonRpcResponse);
  }

  async respondError(id: RequestId, message: string, code = -32000): Promise<void> {
    await this.write({ jsonrpc: '2.0', id, error: { code, message } } satisfies JsonRpcResponse);
  }

  async disconnect(): Promise<void> {
    if (this.state === 'disconnected') return;
    this.state = 'disconnecting';
    const child = this.child;
    this.reader?.close();
    this.reader = null;
    this.rejectPending(new Error('Codex app-server disconnected'));
    this.child = null;

    if (child?.stdin?.writable) child.stdin.end();
    if (child?.pid) {
      await killProcessTreeAsync(child.pid).catch(() => {
        try { child.kill(); } catch { /* already exited */ }
      });
    }
    this.state = 'disconnected';
    this.emit('disconnected');
  }

  /** Test seam for protocol routing without spawning a process. */
  routeIncomingForTest(message: JsonRpcMessage): void {
    this.routeMessage(message);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    try {
      this.routeMessage(JSON.parse(line) as JsonRpcMessage);
    } catch {
      this.debug(`Ignored non-JSON app-server output: ${line.slice(0, 300)}`);
    }
  }

  private routeMessage(message: JsonRpcMessage): void {
    if ('id' in message && !('method' in message)) {
      const response = message as JsonRpcResponse;
      const pending = this.pending.get(String(response.id));
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(String(response.id));
      if (response.error) {
        pending.reject(new Error(`${pending.method}: ${response.error.message}`));
      } else {
        pending.resolve(response.result);
      }
      return;
    }
    if ('id' in message && 'method' in message) {
      const request = message as JsonRpcRequest;
      this.emit('serverRequest', {
        id: request.id,
        method: request.method,
        params: request.params,
      } satisfies NativeCodexServerRequest);
      return;
    }
    if ('method' in message) {
      const notification = message as JsonRpcNotification;
      this.emit('notification', notification.method, notification.params);
    }
  }

  private write(message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    this.writeTail = this.writeTail.then(() => new Promise<void>((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin?.writable) {
        reject(new Error('Codex app-server stdin is closed'));
        return;
      }
      stdin.write(line, error => error ? reject(error) : resolve());
    }));
    return this.writeTail;
  }

  private recordStderr(chunk: string): void {
    const text = chunk.trim();
    if (!text) return;
    this.stderrChunks.push(text);
    while (this.stderrChunks.join('\n').length > 8_192 && this.stderrChunks.length > 1) this.stderrChunks.shift();
    this.debug(`stderr: ${text.slice(0, 500)}`);
  }

  private handleExit(error: Error): void {
    if (this.state === 'disconnected') return;
    const expected = this.state === 'disconnecting';
    this.rejectPending(error);
    this.reader?.close();
    this.reader = null;
    this.child = null;
    this.state = 'disconnected';
    if (!expected) this.emit('error', error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private debug(message: string): void {
    this.options.onDebug?.(message);
  }
}
