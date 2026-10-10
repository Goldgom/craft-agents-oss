import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { getGitBashPath } from '../config/storage.ts';
import { getBundledAssetsDir } from '../utils/paths.ts';
import { killProcessTree } from '../utils/process-tree.ts';

/** Shared tool primitives; agent backends retain their own inference loops. */
export const LOCAL_AGENT_HOST_TOOLS = [
  { name: 'Read', description: 'Read a text file, including skill and source instructions, up to 512 KB.',
    inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'Bash', description: 'Run a shell command in the current working directory. The host checks permissions before executing it.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number', minimum: 1, maximum: 1800, description: 'Timeout in seconds.' } }, required: ['command'] } },
  { name: 'Write', description: 'Create or overwrite a text file after host approval.',
    inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
  { name: 'Edit', description: 'Replace one exact occurrence in a text file. Read the file first. The old string must be unique.',
    inputSchema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] } },
];

const fileMutations = new Map<string, Promise<unknown>>();

async function mutateFile<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  const pending = (fileMutations.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
  fileMutations.set(key, pending);
  try { return await pending; }
  finally { if (fileMutations.get(key) === pending) fileMutations.delete(key); }
}

function bashPath(): string {
  const configured = getGitBashPath() ?? process.env.CLAUDE_CODE_GIT_BASH_PATH ?? process.env.PI_BASH_PATH;
  if (configured) return configured;
  if (process.platform !== 'win32') return '/bin/bash';
  const assets = getBundledAssetsDir('.');
  const candidates = [
    ...(assets ? [join(assets, '..', 'vendor', 'git-bash', 'bin', 'bash.exe'),
      join(assets, '..', '..', 'vendor', 'git-bash', 'bin', 'bash.exe')] : []),
    ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
      .filter((value): value is string => !!value).map(root => join(root, 'Git', 'bin', 'bash.exe')),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error('Git Bash is unavailable; configure its executable in settings');
  return found;
}

async function runCommand(command: string, timeout: number, cwd: string, signal: AbortSignal) {
  if (signal.aborted) throw new Error('Agent turn was stopped');
  return new Promise<{ content: string; isError: boolean }>((resolveResult, reject) => {
    const child = spawn(bashPath(), ['-c', command], { cwd, env: process.env,
      detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stopped: string | undefined;
    let killRequested = false;
    const collect = (chunk: Buffer) => {
      const remaining = 128 * 1024 - size;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) { const value = chunk.subarray(0, remaining); chunks.push(value); size += value.length; }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const killChild = () => {
      if (killRequested || !child.pid) return;
      killRequested = true;
      killProcessTree(child.pid, () => {
        if (child.exitCode === null) child.kill('SIGKILL');
        // Inherited handles in a detached child must not keep a stopped call
        // waiting after the process-tree kill has settled.
        child.stdout.destroy(); child.stderr.destroy();
      });
    };
    const stop = (reason: string) => { stopped ??= reason; killChild(); };
    child.once('spawn', () => { if (stopped) killChild(); });
    const onAbort = () => stop('Agent turn was stopped');
    const timer = setTimeout(() => stop('Command timed out'), timeout * 1000);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      const content = Buffer.concat(chunks).toString('utf8') + (truncated ? '\n[Output truncated at 128 KB]' : '');
      resolveResult({ content: content + (stopped ? `\n${stopped}` : code ? `\nExit code: ${code}` : ''), isError: !!stopped || code !== 0 });
    });
  });
}

export async function executeLocalAgentHostTool(name: string, input: Record<string, unknown>, cwd: string, signal: AbortSignal) {
  if (!['Bash', 'Write', 'Edit'].includes(name)) return undefined;
  if (signal.aborted) throw new Error('Agent turn was stopped');
  if (name === 'Bash' && typeof input.command !== 'string') throw new Error('Bash requires command');
  if (name !== 'Bash' && typeof input.file_path !== 'string') throw new Error(`${name} requires file_path`);
  if (name === 'Write' && typeof input.content !== 'string') throw new Error('Write requires content');
  if (name === 'Edit' && (typeof input.old_string !== 'string' || typeof input.new_string !== 'string')) throw new Error('Edit requires old_string and new_string');
  if (input.timeout != null && (typeof input.timeout !== 'number' || !Number.isFinite(input.timeout) || input.timeout < 1 || input.timeout > 1800)) throw new Error('Invalid command timeout');
  if (name === 'Bash') return runCommand(input.command as string, (input.timeout as number | undefined) ?? 300, cwd, signal);
  const path = resolve(cwd, input.file_path as string);
  return mutateFile(path, async () => {
    if (signal.aborted) throw new Error('Agent turn was stopped');
    if (name === 'Write') {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.content as string, { encoding: 'utf8', signal });
      return { content: `Wrote ${path}`, isError: false };
    }
    const content = await readFile(path, { encoding: 'utf8', signal });
    if (content.includes('\0')) throw new Error('Edit requires a text file');
    let oldText = input.old_string as string;
    if (!oldText) throw new Error('Edit requires a nonempty old_string');
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    if (!content.includes(oldText)) oldText = oldText.replace(/\r?\n/g, lineEnding);
    const first = content.indexOf(oldText);
    if (first < 0) throw new Error('Edit text was not found');
    if (content.indexOf(oldText, first + 1) >= 0) throw new Error('Edit text is ambiguous; provide a unique old_string');
    const newText = (input.new_string as string).replace(/\r?\n/g, lineEnding);
    await writeFile(path, content.slice(0, first) + newText + content.slice(first + oldText.length), { encoding: 'utf8', signal });
    return { content: `Edited ${path}`, isError: false };
  });
}
