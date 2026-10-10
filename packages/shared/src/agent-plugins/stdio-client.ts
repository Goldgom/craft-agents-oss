import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { getBundledAssetsDir } from '../utils/paths.ts';
import { killProcessTree } from '../utils/process-tree.ts';
import type { AgentPluginManifest } from './types.ts';
import type { PluginMessage } from './protocol.ts';

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 64;

export function resolveAgentPluginArguments(args: string[]): string[] {
  return args.map(arg => {
    if (!arg.startsWith('tokenbird:bridge:')) return arg;
    const backend = arg.slice('tokenbird:bridge:'.length);
    if (!['hermes', 'dsh'].includes(backend)) throw new Error('Unknown bundled agent bridge');
    const scripts = getBundledAssetsDir('scripts');
    const path = scripts && join(scripts, 'agent-plugins', `${backend}_bridge.py`);
    if (!path || !existsSync(path)) throw new Error(`Bundled ${backend} bridge is unavailable`);
    return path;
  });
}

/** Small bounded JSON-RPC transport. Stdout belongs exclusively to the protocol. */
export class AgentPluginStdioClient {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private closed = false;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private hostRequests = new Set<string | number>();
  readonly exited: Promise<void>;

  constructor(private manifest: AgentPluginManifest, options: {
    cwd: string;
    onNotification: (method: string, params: unknown) => void;
    onRequest: (method: string, params: unknown) => Promise<unknown>;
    onFailure: (error: Error) => void;
  }) {
    // Ambient provider keys and host configuration do not leak into another agent.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
      'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL']) {
      if (process.env[key] != null) env[key] = process.env[key];
    }
    if (process.platform === 'win32') {
      const scripts = getBundledAssetsDir('scripts');
      const gitRoot = scripts && join(scripts, '..', '..', 'vendor', 'git-bash');
      if (gitRoot && existsSync(join(gitRoot, 'bin', 'bash.exe'))) {
        env.HERMES_GIT_BASH_PATH = join(gitRoot, 'bin', 'bash.exe');
        env.PATH = [join(gitRoot, 'bin'), join(gitRoot, 'usr', 'bin'), join(gitRoot, 'cmd'), env.PATH ?? env.Path ?? ''].join(delimiter);
        delete env.Path;
      }
    }
    this.child = spawn(manifest.transport.command, resolveAgentPluginArguments(manifest.transport.args), {
      cwd: manifest.transport.cwd ?? options.cwd,
      env: { ...env, ...manifest.transport.env }, shell: false, windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
    const fail = (error: Error) => { if (!this.closed) { this.destroy(error); options.onFailure(error); } };
    this.child.on('error', fail);
    this.child.stdin.on('error', fail);
    this.child.on('close', code => fail(new Error(`Agent plugin ${manifest.id} exited (${code ?? 'signal'})`)));
    // Drain stderr without copying possibly sensitive native diagnostics into UI/logs.
    this.child.stderr.on('data', () => {});
    this.child.stdout.on('data', chunk => {
      if (this.closed) return;
      try {
        this.buffer += this.decoder.write(chunk);
        let newline: number;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
          if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error('Agent plugin frame is too large');
          if (!line.trim()) continue;
          const message = JSON.parse(line) as PluginMessage;
          if (!message || message.jsonrpc !== '2.0') throw new Error('Invalid agent plugin protocol message');
          if (message.method) {
            if (typeof message.method !== 'string') throw new Error('Invalid plugin method');
            if (message.id == null) options.onNotification(message.method, message.params);
            else {
              if ((typeof message.id !== 'string' && typeof message.id !== 'number') || this.hostRequests.has(message.id)
                || this.hostRequests.size >= MAX_PENDING_REQUESTS) throw new Error('Invalid or excessive plugin requests');
              this.hostRequests.add(message.id);
              const reply = (response: PluginMessage) => {
                if (this.closed) return;
                try { this.write(response); } catch (error) { fail(error instanceof Error ? error : new Error('Plugin response failed')); }
              };
              void options.onRequest(message.method, message.params)
                .then(result => reply({ jsonrpc: '2.0', id: message.id, result }))
                .catch(() => reply({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Host request failed' } }))
                .finally(() => this.hostRequests.delete(message.id!));
            }
          } else if (message.id != null) {
            const pending = this.pending.get(String(message.id));
            if (!pending) continue;
            this.pending.delete(String(message.id)); clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(`Agent plugin ${manifest.id}: ${message.error.message}`));
            else pending.resolve(message.result);
          } else throw new Error('Invalid agent plugin response');
        }
        if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) throw new Error('Agent plugin frame is too large');
      } catch (error) { fail(error instanceof Error ? error : new Error('Invalid plugin output')); }
    });
  }

  get processId(): number | undefined { return this.child.pid; }
  get isClosed(): boolean { return this.closed; }

  request(method: string, params: unknown, timeoutMs = this.manifest.transport.requestTimeoutMs ?? 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Agent plugin process is closed'));
    if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error('Too many pending agent plugin requests'));
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Agent plugin request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method: string, params: unknown): void { this.write({ jsonrpc: '2.0', method, params }); }

  private write(message: PluginMessage): void {
    if (this.closed) throw new Error('Agent plugin process is closed');
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error('Agent plugin request is too large');
    if (this.child.stdin.writableLength > MAX_FRAME_BYTES) throw new Error('Agent plugin input backlog is too large');
    this.child.stdin.write(`${line}\n`);
  }

  destroy(error = new Error('Agent plugin process stopped')): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.hostRequests.clear(); this.buffer = '';
    this.child.stdin.destroy();
    const kill = () => {
      if (!this.child.pid) return;
      killProcessTree(this.child.pid, () => {
        if (this.child.exitCode === null) this.child.kill('SIGKILL');
        this.child.stdout.destroy(); this.child.stderr.destroy();
      });
    };
    if (this.child.exitCode === null && this.child.signalCode === null) {
      if (this.child.pid) kill(); else this.child.once('spawn', kill);
    }
  }
}
