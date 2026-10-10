import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { killProcessTreeAsync } from '../utils/process-tree.ts';
import { getNativeCodexStatus } from '../codex/binary-resolver.ts';
import { createBundledAgentManifest } from './presets.ts';
import { loadAgentPluginManifests } from './storage.ts';
import { AgentPluginStdioClient } from './stdio-client.ts';
import { getBackendFrameworkCatalog, validateBackendFrameworkConfiguration } from './framework-storage.ts';
import type { BackendFrameworkTestResult } from './frameworks.ts';

function resolveExecutable(value: string): string {
  if (!value) throw new Error('No backend executable was detected; specify its location');
  if (isAbsolute(value)) return value;
  const names = process.platform === 'win32' && !value.toLowerCase().endsWith('.exe') ? [value, `${value}.exe`] : [value];
  const found = (process.env.PATH ?? process.env.Path ?? '').split(delimiter)
    .flatMap(directory => names.map(name => join(directory, name))).find(existsSync);
  if (!found) throw new Error('Backend executable was not found');
  return found;
}

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
    'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL']) if (process.env[key] != null) env[key] = process.env[key];
  return env;
}

/** Bounded local version/protocol probe. stderr never becomes application text. */
async function runProbe(command: string, args: string[], cwd: string, input?: object, accept?: (message: any) => boolean): Promise<string> {
  const child = spawn(command, args, { cwd, windowsHide: true, detached: process.platform !== 'win32',
    env: { ...environment(), CODEX_HOME: join(cwd, 'codex-home') }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    return await new Promise<string>((resolve, reject) => {
      let output = '';
      let frame = '';
      let settled = false;
      const done = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(output.trim()); };
      const timer = setTimeout(() => done(new Error('Backend local test timed out')), 20_000);
      child.stderr.on('data', () => {});
      child.stdin.on('error', error => done(error));
      child.on('error', error => done(error));
      child.stdout.on('data', chunk => {
        if (settled) return;
        output += chunk.toString('utf8');
        if (Buffer.byteLength(output) > 256 * 1024) { done(new Error('Backend test output exceeded its limit')); return; }
        if (!accept) return;
        frame += chunk.toString('utf8');
        let newline: number;
        while ((newline = frame.indexOf('\n')) >= 0) {
          const line = frame.slice(0, newline); frame = frame.slice(newline + 1);
          try { if (accept(JSON.parse(line))) { done(); return; } } catch { /* inspect next local protocol frame */ }
        }
      });
      child.on('close', code => done(code === 0 && !accept ? undefined : new Error(`Backend local test exited (${code ?? 'signal'}) before completing`)));
      if (input) child.stdin.write(JSON.stringify(input) + '\n'); else child.stdin.end();
    });
  } finally {
    if (child.pid) await killProcessTreeAsync(child.pid).catch(() => { child.kill(); });
    child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
  }
}

export async function testBackendFrameworkConfiguration(value: unknown): Promise<BackendFrameworkTestResult> {
  const result: BackendFrameworkTestResult = { success: false, checks: [] };
  let root: string | undefined;
  let kind: 'location' | 'runtime' | 'protocol' = 'location';
  try {
    const configuration = validateBackendFrameworkConfiguration(value);
    const entry = getBackendFrameworkCatalog().frameworks.find(item => item.id === configuration.id)!;
    const codex = configuration.id === 'codex' && !configuration.executablePath ? getNativeCodexStatus({ forceRecheck: true }) : undefined;
    const executable = resolveExecutable(configuration.executablePath || entry.detectedLocation?.executablePath || codex?.path || '');
    if (!(await stat(executable)).isFile()) throw new Error('Backend location must point to an executable file');
    const piEntry = configuration.id === 'pi' ? configuration.entrypointPath || entry.detectedLocation?.entrypointPath : undefined;
    if (configuration.id === 'pi' && (!piEntry || !(await stat(piEntry)).isFile())) throw new Error('Pi service entrypoint was not found');
    if (configuration.id === 'plugin:hermes' && !(await stat(join(configuration.projectPath, 'run_agent.py'))).isFile()) throw new Error('Hermes project must contain run_agent.py');
    result.checks.push({ kind, success: true });
    root = await mkdtemp(join(tmpdir(), 'tokenbird-framework-probe-'));
    await mkdir(join(root, 'codex-home'));
    kind = 'runtime';
    const versionText = await runProbe(executable, ['--version'], root);
    const version = versionText.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
    if (!version) throw new Error('Backend did not return a valid runtime version');
    if (configuration.id === 'codex' && !/^0\.154\./.test(version)) throw new Error('This Codex version is not supported; use the tested 0.154.x runtime');
    result.version = version;
    result.checks.push({ kind, success: true });
    kind = 'protocol';
    if (configuration.id === 'pi') {
      await runProbe(executable, [piEntry!], root, { type: 'init', apiKey: '', model: 'probe', cwd: root,
        workspaceRootPath: root, sessionId: 'probe', sessionPath: root, workingDirectory: root, plansFolderPath: root,
        thinkingLevel: 'off', providerType: 'pi_compat', authType: 'none' }, message => message.type === 'ready' && Number.isInteger(message.callbackPort));
    } else if (configuration.id === 'codex') {
      await runProbe(executable, ['app-server', '--listen', 'stdio://'], root,
        { id: 'framework-probe', jsonrpc: '2.0', method: 'initialize', params: { clientInfo: { name: 'tokenbird-probe', version: '1' }, capabilities: { experimentalApi: true } } },
        message => message.id === 'framework-probe' && !!message.result && !message.error);
    } else if (configuration.id.startsWith('plugin:')) {
      const existing = loadAgentPluginManifests().manifests.find(item => item.id === configuration.id);
      const manifest = configuration.id === 'plugin:hermes' || configuration.id === 'plugin:dsh'
        ? createBundledAgentManifest({ backend: configuration.id === 'plugin:hermes' ? 'hermes' : 'dsh', pythonPath: executable, hermesRoot: configuration.projectPath })
        : existing && { ...existing, transport: { ...existing.transport, command: executable } };
      if (!manifest) throw new Error('Backend adapter is not installed');
      if (existing?.transport.env) manifest.transport.env = existing.transport.env;
      const client = new AgentPluginStdioClient(manifest, { cwd: root,
        onNotification: () => {}, onRequest: async () => { throw new Error('Tools are unavailable during a local framework test'); }, onFailure: () => {} });
      try {
        const initialized = await client.request('initialize', { protocolVersion: 1, probe: true,
          runtimeDataDirectory: join(root, 'runtime'), session: { id: 'probe', workingDirectory: root, workspaceRootPath: root },
          connection: { providerType: 'pi_compat', authType: 'none', model: 'deepseek-v4-flash',
            baseUrl: 'http://127.0.0.1:9/v1', customEndpoint: { api: 'openai-completions' } }, history: [], hostCapabilities: ['hostTools', 'toolApproval'] }, 60_000) as any;
        if (initialized?.protocolVersion !== 1 || !Array.isArray(initialized.capabilities)
          || manifest.capabilities.some(capability => !initialized.capabilities.includes(capability))) throw new Error('Backend protocol or capabilities do not match its adapter');
      } finally { client.destroy(); await client.exited; }
    }
    // Claude's SDK executable version is its local installation contract.
    if (configuration.id !== 'claude-code') result.checks.push({ kind, success: true });
    result.success = true;
  } catch (error) {
    result.checks.push({ kind, success: false, detail: (error instanceof Error ? error.message : String(error)).slice(0, 2000) });
  } finally {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  return result;
}
