import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import type { BackendHostRuntimeContext } from '../agent/backend/types.ts';
import { getConfigDir } from '../config/paths.ts';
import { killProcessTreeAsync } from '../utils/process-tree.ts';
import { clearNativeCodexBinaryCache, MANAGED_CODEX_VERSION, getNativeCodexStatus } from '../codex/binary-resolver.ts';
import { getBackendFrameworkCatalog, saveBackendFrameworkConfiguration } from './framework-storage.ts';
import { testBackendFrameworkConfiguration } from './framework-probe.ts';
import type { AgentPluginRuntime } from './types.ts';
import type { BackendFrameworkConfiguration, BackendFrameworkEntry, BackendFrameworkInstallResult, FrameworkInstallProgress, FrameworkDownloadSource } from './frameworks.ts';

// Reviewed upstream sources. Upgrades change these pins alongside adapter verification.
export const FRAMEWORK_INSTALL_VERSIONS = {
  codex: MANAGED_CODEX_VERSION, claude: '0.3.258', pi: '0.85.1', python: '3.14.7', uv: '0.13.0',
  dsh: '0.1.5rc1', hermes: 'dce1e9b37581dd62e480a9064dc04a709c2940d3',
} as const;
const supported = new Set<AgentPluginRuntime>(['codex', 'pi', 'claude-code', 'plugin:hermes', 'plugin:dsh']);
interface InstallJob { controller: AbortController; progress: FrameworkInstallProgress; promise: Promise<BackendFrameworkInstallResult>; }
const jobs = new Map<AgentPluginRuntime, InstallJob>();
const rootDirectory = () => join(getConfigDir(), 'runtime', 'frameworks');

function pathProgram(name: string): string | undefined {
  const names = process.platform === 'win32' ? [name, `${name}.exe`] : [name];
  return (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)
    .flatMap(directory => names.map(file => join(directory, file))).find(existsSync);
}
function hostFile(host: BackendHostRuntimeContext, relative: string): string | undefined {
  let base = resolve(host.appRootPath);
  for (let i = 0; i < 8; i++) {
    for (const candidate of [join(base, relative), join(base, 'apps', 'electron', relative)]) if (existsSync(candidate)) return candidate;
    const parent = dirname(base); if (parent === base) break; base = parent;
  }
}
function tooling(host: BackendHostRuntimeContext, name: 'bun' | 'uv' | 'git' | 'python' | 'node'): string | undefined {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const bundled = name === 'bun'
    ? [host.resourcesPath && join(host.resourcesPath, 'vendor', 'bun', `bun${exe}`), hostFile(host, `vendor/bun/bun${exe}`)]
    : name === 'uv' ? [hostFile(host, `resources/bin/${process.platform}-${process.arch}/uv${exe}`)]
    : name === 'git' ? [hostFile(host, 'vendor/git-bash/cmd/git.exe')]
    : [hostFile(host, `vendor/toolchains/${name}/${name}${exe}`)];
  return bundled.find((file): file is string => !!file && existsSync(file))
    ?? (name === 'bun' && (process.versions as any).bun ? process.execPath : pathProgram(name));
}

/** No model secrets, user npm config, or global Git credentials enter installers. */
function installEnvironment(host: BackendHostRuntimeContext, directory: string, source: FrameworkDownloadSource): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
    'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE']) if (process.env[key]) env[key] = process.env[key];
  env.PATH = [tooling(host, 'node'), tooling(host, 'git'), tooling(host, 'bun')].filter(Boolean).map(file => dirname(file!))
    .concat([env.PATH ?? env.Path ?? '']).join(delimiter);
  env.HOME = directory; env.USERPROFILE = directory; env.APPDATA = directory; env.LOCALAPPDATA = directory;
  env.GIT_TERMINAL_PROMPT = '0'; env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = join(directory, 'empty-git-config');
  env.NPM_CONFIG_USERCONFIG = join(directory, 'empty-npm-config');
  env.NPM_CONFIG_REGISTRY = source === 'mirror' ? 'https://registry.npmmirror.com' : 'https://registry.npmjs.org';
  env.UV_DEFAULT_INDEX = source === 'mirror' ? 'https://pypi.tuna.tsinghua.edu.cn/simple' : 'https://pypi.org/simple';
  env.UV_CACHE_DIR = join(rootDirectory(), 'cache'); env.UV_PYTHON_INSTALL_DIR = join(rootDirectory(), 'python');
  env.UV_NO_PROGRESS = '1'; env.NO_COLOR = '1';
  env.UV_HTTP_TIMEOUT = '120'; env.UV_HTTP_RETRIES = '3';
  return env;
}

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_384); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  let kill: Promise<void> | undefined;
  const stop = () => { if (child.pid) kill ??= killProcessTreeAsync(child.pid).catch(() => { child.kill('SIGKILL'); }); };
  child.once('spawn', () => { if (signal.aborted) stop(); }); signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, 10 * 60_000);
  try {
    const code = await new Promise<number | null>((done, fail) => { child.once('error', fail); child.once('close', done); });
    signal.throwIfAborted();
    if (code !== 0) throw new Error(`Backend installation command failed (${code ?? 'timeout'}): ${output.trim()}`);
    return output.trim();
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', stop); await kill;
    child.stdout.destroy(); child.stderr.destroy();
  }
}

async function obtainUv(host: BackendHostRuntimeContext, directory: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  const existing = tooling(host, 'uv');
  if (existing && (await run(existing, ['--version'], directory, env, signal)).startsWith(`uv ${FRAMEWORK_INSTALL_VERSIONS.uv}`)) return existing;
  const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'win32' ? 'pc-windows-msvc' : process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}`;
  const archiveName = `uv-${target}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const url = `https://github.com/astral-sh/uv/releases/download/${FRAMEWORK_INSTALL_VERSIONS.uv}/${archiveName}`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Unable to download the Python installer (HTTP ${response.status})`);
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break;
    length += chunk.value.byteLength; if (length > 80 * 1024 * 1024) throw new Error('Python installer download exceeded its limit'); chunks.push(chunk.value); }
  } finally { await reader.cancel().catch(() => {}); }
  const content = Buffer.concat(chunks);
  const checksum = await fetch(url + '.sha256', { signal });
  if (!checksum.ok || (await checksum.text()).trim().split(/\s+/)[0] !== createHash('sha256').update(content).digest('hex')) throw new Error('Python installer checksum verification failed');
  const archive = join(directory, archiveName); await writeFile(archive, new Uint8Array(content));
  const tar = pathProgram('tar'); if (!tar) throw new Error('Archive extraction requires tar; install the complete desktop build');
  await run(tar, ['-xf', archive, '-C', directory], directory, env, signal);
  const executable = process.platform === 'win32' ? join(directory, 'uv.exe') : join(directory, `uv-${target}`, 'uv');
  await chmod(executable, 0o755);
  const version = await run(executable, ['--version'], directory, env, signal);
  if (!version.startsWith(`uv ${FRAMEWORK_INSTALL_VERSIONS.uv}`)) throw new Error('Downloaded Python installer version does not match');
  return executable;
}

async function nodePackage(host: BackendHostRuntimeContext, directory: string, spec: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'tokenbird-framework-runtime', private: true }));
  const bun = tooling(host, 'bun');
  if (bun) await run(bun, ['add', '--exact', '--ignore-scripts', `--registry=${env.NPM_CONFIG_REGISTRY}`, spec], directory, env, signal);
  else {
    const node = tooling(host, 'node');
    const npm = node && join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!node || !npm || !existsSync(npm)) throw new Error('The packaged JavaScript runtime is missing; install the complete desktop build');
    await run(node, [npm, 'install', '--save-exact', '--ignore-scripts', `--registry=${env.NPM_CONFIG_REGISTRY}`, spec], directory, env, signal);
  }
}

function nativePackageBinary(directory: string, id: 'codex' | 'claude-code'): string {
  const win = process.platform === 'win32';
  if (id === 'claude-code') return join(directory, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, win ? 'claude.exe' : 'claude');
  const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${win ? 'pc-windows-msvc' : process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
  const paths = [
    join(directory, 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`, 'vendor', target, 'bin', win ? 'codex.exe' : 'codex'),
    join(directory, 'node_modules', '@openai', 'codex', 'vendor', target, 'bin', win ? 'codex.exe' : 'codex'),
  ];
  const result = paths.find(existsSync); if (!result) throw new Error('The native Codex package did not contain a binary for this platform');
  return result;
}

export function describeFrameworkInstallation(entry: BackendFrameworkEntry): BackendFrameworkEntry {
  const executable = entry.configuration.executablePath || entry.detectedLocation?.executablePath
    || (entry.id === 'codex' ? getNativeCodexStatus().path : undefined);
  const project = entry.configuration.projectPath;
  const available = !!executable && !!(existsSync(executable) || pathProgram(executable))
    && (entry.id !== 'pi' || existsSync(entry.configuration.entrypointPath || entry.detectedLocation?.entrypointPath || ''))
    && (entry.id !== 'plugin:hermes' || existsSync(join(project, 'run_agent.py')));
  return { ...entry, installation: { available, managed: !!executable && resolve(executable).startsWith(rootDirectory() + sep),
    installable: supported.has(entry.id) && ['win32', 'darwin', 'linux'].includes(process.platform) && ['x64', 'arm64'].includes(process.arch),
    progress: jobs.get(entry.id)?.progress } };
}
export function cancelBackendFrameworkInstall(id: AgentPluginRuntime): void { jobs.get(id)?.controller.abort(); }

/** Immutable install directories: failed downloads never replace a working environment. */
export function installBackendFramework(id: AgentPluginRuntime, host: BackendHostRuntimeContext,
  onProgress: (progress: FrameworkInstallProgress) => void = () => {}, source: FrameworkDownloadSource = 'official'): Promise<BackendFrameworkInstallResult> {
  const active = jobs.get(id); if (active) return active.promise;
  if (!supported.has(id)) return Promise.resolve({ success: false, error: 'This framework has no bundled installation recipe' });
  if (!['official', 'mirror'].includes(source)) return Promise.resolve({ success: false, error: 'Unknown framework download source' });
  const controller = new AbortController();
  const job: InstallJob = { controller, progress: { id, phase: 'preparing' }, promise: undefined! };
  jobs.set(id, job);
  const advance = (phase: FrameworkInstallProgress['phase']) => {
    job.progress = { id, phase };
    try { onProgress(job.progress); } catch { /* A disconnected UI cannot invalidate an installation. */ }
  };
  job.promise = (async () => {
    let directory: string | undefined; let activated = false;
    const deadline = setTimeout(() => controller.abort(), 20 * 60_000);
    try {
      if (!['win32', 'darwin', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('Backend installation is unavailable on this platform');
      const entry = getBackendFrameworkCatalog().frameworks.find(framework => framework.id === id)!;
      advance('preparing');
      await mkdir(rootDirectory(), { recursive: true });
      directory = join(rootDirectory(), id.replace(':', '-'), randomUUID()); await mkdir(directory, { recursive: true });
      const env = installEnvironment(host, join(directory, 'installer-home'), source);
      await mkdir(env.HOME!, { recursive: true }); await writeFile(env.GIT_CONFIG_GLOBAL!, ''); await writeFile(env.NPM_CONFIG_USERCONFIG!, '');
      let configuration: BackendFrameworkConfiguration = { ...entry.configuration, downloadSource: source, executablePath: '', entrypointPath: '', projectPath: '' };
      advance('downloading');
      if (id === 'codex' || id === 'claude-code') {
        await nodePackage(host, directory, id === 'codex' ? `@openai/codex@${FRAMEWORK_INSTALL_VERSIONS.codex}` : `@anthropic-ai/claude-agent-sdk@${FRAMEWORK_INSTALL_VERSIONS.claude}`, env, controller.signal);
        configuration.executablePath = nativePackageBinary(directory, id);
      } else if (id === 'pi') {
        await nodePackage(host, directory, `@earendil-works/pi-coding-agent@${FRAMEWORK_INSTALL_VERSIONS.pi}`, env, controller.signal);
        const service = entry.detectedLocation?.entrypointPath;
        const bun = tooling(host, 'bun');
        if (!service || !existsSync(service) || !bun) throw new Error('The bundled Pi service or Bun runtime is missing; install the complete desktop build');
        configuration.executablePath = bun; configuration.entrypointPath = join(directory, 'pi-agent-server.js');
        await copyFile(service, configuration.entrypointPath);
      } else {
        const uv = await obtainUv(host, directory, env, controller.signal);
        const environmentPath = join(directory, 'venv');
        const python = tooling(host, 'python');
        const usablePython = python && /^Python 3\.14\./.test(await run(python, ['--version'], directory, env, controller.signal));
        await run(uv, ['venv', '--python', usablePython ? python! : FRAMEWORK_INSTALL_VERSIONS.python,
          ...(usablePython ? ['--no-python-downloads'] : ['--managed-python']), environmentPath], directory, env, controller.signal);
        configuration.executablePath = join(environmentPath, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        advance('dependencies');
        if (id === 'plugin:dsh') {
          await run(uv, ['pip', 'install', '--python', configuration.executablePath, '--index-url', env.UV_DEFAULT_INDEX!, `deepseek-harness-sdk==${FRAMEWORK_INSTALL_VERSIONS.dsh}`], directory, env, controller.signal);
        } else {
          const git = tooling(host, 'git'); if (!git) throw new Error('Git is required to install the official Hermes framework');
          const project = join(directory, 'hermes'); await mkdir(project);
          await run(git, ['init', project], directory, env, controller.signal);
          await run(git, ['-C', project, 'config', 'core.longpaths', 'true'], directory, env, controller.signal);
          await run(git, ['-C', project, 'fetch', '--depth=1', 'https://github.com/NousResearch/hermes-agent.git', FRAMEWORK_INSTALL_VERSIONS.hermes], directory, env, controller.signal);
          await run(git, ['-C', project, 'checkout', '--detach', 'FETCH_HEAD'], directory, env, controller.signal);
          if ((await run(git, ['-C', project, 'rev-parse', 'HEAD'], directory, env, controller.signal)).trim() !== FRAMEWORK_INSTALL_VERSIONS.hermes) throw new Error('Hermes source revision verification failed');
          await run(uv, ['pip', 'install', '--python', configuration.executablePath, '--index-url', env.UV_DEFAULT_INDEX!, '--editable', `${project}[mcp,anthropic]`], directory, env, controller.signal);
          configuration.projectPath = project;
        }
      }
      controller.signal.throwIfAborted(); advance('testing');
      const test = await testBackendFrameworkConfiguration(configuration);
      controller.signal.throwIfAborted();
      if (!test.success) throw new Error(test.checks.filter(check => !check.success).map(check => check.detail).join('; ') || 'The installed native runtime failed its local test');
      advance('activating');
      // No venv moves or editable-path rewrites. Configuration is the atomic activation pointer.
      await writeFile(join(directory, 'installation.json'), JSON.stringify({ id, version: test.version, configuration, installedAt: new Date().toISOString() }, null, 2));
      configuration = saveBackendFrameworkConfiguration(configuration); activated = true;
      clearNativeCodexBinaryCache();
      advance('complete'); return { success: true, configuration, test };
    } catch (error) {
      advance(controller.signal.aborted ? 'cancelled' : 'failed');
      return { success: false, error: controller.signal.aborted ? 'Backend installation cancelled' : (error instanceof Error ? error.message : String(error)).slice(-2000) };
    } finally {
      clearTimeout(deadline);
      if (directory && !activated) {
        // Check the final absolute target and reject redirected parents before recursive cleanup.
        try {
          const base = realpathSync(rootDirectory());
          const target = realpathSync(directory);
          if (target === resolve(directory) && target.startsWith(base + sep)) await rm(target, { recursive: true, force: true }).catch(() => {});
        } catch { /* Failed creation or a redirected parent is never a cleanup target. */ }
      }
      jobs.delete(id);
    }
  })();
  return job.promise;
}
