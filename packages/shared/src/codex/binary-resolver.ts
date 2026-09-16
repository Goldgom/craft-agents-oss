import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { getConfigDir } from '../config/paths.ts';

export interface NativeCodexBinary {
  path: string;
  source: 'CRAFT_CODEX_PATH' | 'CODEX_PATH' | 'bundled' | 'managed' | 'PATH';
  version: string;
  testedProtocol: boolean;
}

const TESTED_VERSION = /^0\.154\./;
export const MANAGED_CODEX_VERSION = '0.154.0';
let cached: NativeCodexBinary | null | undefined;
let configuredResourcesPath: string | undefined;
let managedInstall: Promise<ManagedCodexInstallResult> | null = null;

export interface NativeCodexStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  source: NativeCodexBinary['source'] | null;
  testedProtocol: boolean;
}

export interface ManagedCodexInstallResult extends NativeCodexStatus {
  success: boolean;
  error?: string;
}

function executableName(): string {
  return platform() === 'win32' ? 'codex.exe' : 'codex';
}

function pathCandidates(env: NodeJS.ProcessEnv): string[] {
  const names = platform() === 'win32'
    ? ['codex.exe', 'codex.cmd', 'codex.bat']
    : ['codex'];
  return (env.PATH ?? '').split(delimiter).filter(Boolean).flatMap(dir => names.map(name => join(dir, name)));
}

function managedCodexRoot(): string {
  return join(getConfigDir(), 'runtime', 'codex-cli');
}

function managedCodexCandidates(): string[] {
  const bin = join(managedCodexRoot(), 'node_modules', '.bin');
  return platform() === 'win32'
    ? [join(bin, 'codex.exe'), join(bin, 'codex.cmd'), join(bin, 'codex.bat')]
    : [join(bin, 'codex')];
}

function resolveExistingPath(value: string | undefined): string | null {
  if (!value) return null;
  if (existsSync(value)) return value;
  if (!isAbsolute(value) && extname(value) === '') return value;
  return null;
}

function readVersion(path: string): string | null {
  const result = spawnSync(path, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3_000,
  });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout ?? ''} ${result.stderr ?? ''}`.match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/)?.[1] ?? null;
}

export function clearNativeCodexBinaryCache(): void {
  cached = undefined;
}

export function configureNativeCodexResourcesPath(resourcesPath?: string): void {
  configuredResourcesPath = resourcesPath;
  clearNativeCodexBinaryCache();
}

export function resolveNativeCodexBinary(options: {
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  useCache?: boolean;
} = {}): NativeCodexBinary | null {
  if (options.useCache !== false && cached !== undefined) return cached;
  const env = options.env ?? process.env;
  const resourcesPath = options.resourcesPath ?? configuredResourcesPath;
  const bundled = resourcesPath ? [
    join(resourcesPath, 'codex', `${platform()}-${arch()}`, executableName()),
    join(resourcesPath, 'vendor', 'codex', `${platform()}-${arch()}`, executableName()),
    join(resourcesPath, 'app', 'vendor', 'codex', `${platform()}-${arch()}`, executableName()),
  ] : [];
  const candidates: Array<{ path: string | null; source: NativeCodexBinary['source'] }> = [
    { path: resolveExistingPath(env.CRAFT_CODEX_PATH), source: 'CRAFT_CODEX_PATH' },
    { path: resolveExistingPath(env.CODEX_PATH), source: 'CODEX_PATH' },
    ...bundled.map(path => ({ path: existsSync(path) ? path : null, source: 'bundled' as const })),
    ...managedCodexCandidates().map(path => ({ path: existsSync(path) ? path : null, source: 'managed' as const })),
    ...pathCandidates(env).map(path => ({ path: existsSync(path) ? path : null, source: 'PATH' as const })),
  ];

  for (const candidate of candidates) {
    if (!candidate.path) continue;
    const version = readVersion(candidate.path);
    if (!version) continue;
    const testedProtocol = TESTED_VERSION.test(version);
    if (!testedProtocol && env.CRAFT_CODEX_ALLOW_UNTESTED !== '1') continue;
    const resolved = { path: candidate.path, source: candidate.source, version, testedProtocol };
    if (options.useCache !== false) cached = resolved;
    return resolved;
  }

  if (options.useCache !== false) cached = null;
  return null;
}

export function getNativeCodexStatus(options: { forceRecheck?: boolean } = {}): NativeCodexStatus {
  if (options.forceRecheck) clearNativeCodexBinaryCache();
  const binary = resolveNativeCodexBinary();
  return binary
    ? { installed: true, path: binary.path, version: binary.version, source: binary.source, testedProtocol: binary.testedProtocol }
    : { installed: false, path: null, version: null, source: null, testedProtocol: false };
}

function runInstaller(command: string, args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let output = '';
    const append = (chunk: Buffer | string) => { output = `${output}${chunk.toString()}`.slice(-16_384); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => child.kill(), 180_000);
    child.once('error', error => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${output}\n${error.message}`.trim() });
    });
    child.once('exit', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.trim() });
    });
  });
}

/** Install a tested Codex CLI into TokenBird's private runtime directory. */
export function installManagedNativeCodex(): Promise<ManagedCodexInstallResult> {
  if (managedInstall) return managedInstall;
  managedInstall = (async () => {
    const installRoot = managedCodexRoot();
    await mkdir(installRoot, { recursive: true });
    const packageJson = join(installRoot, 'package.json');
    if (!existsSync(packageJson)) {
      await writeFile(packageJson, '{"name":"tokenbird-codex-runtime","private":true}\n', 'utf8');
    }

    const packageSpec = `@openai/codex@${MANAGED_CODEX_VERSION}`;
    const installers: Array<{ command: string; args: string[] }> = [];
    if (process.env.CRAFT_BUN) installers.push({
      command: process.env.CRAFT_BUN,
      args: ['add', '--cwd', installRoot, '--exact', packageSpec],
    });
    installers.push({ command: platform() === 'win32' ? 'bun.exe' : 'bun', args: ['add', '--cwd', installRoot, '--exact', packageSpec] });
    installers.push({ command: platform() === 'win32' ? 'npm.cmd' : 'npm', args: ['install', '--prefix', installRoot, '--save-exact', packageSpec] });

    let lastOutput = '';
    for (const installer of installers) {
      const result = await runInstaller(installer.command, installer.args, installRoot);
      lastOutput = result.output;
      if (!result.ok) continue;
      clearNativeCodexBinaryCache();
      const status = getNativeCodexStatus({ forceRecheck: true });
      if (status.installed) return { success: true, ...status };
      lastOutput = 'The package manager completed, but the tested Codex executable could not be detected.';
    }
    return {
      success: false,
      installed: false,
      path: null,
      version: null,
      source: null,
      testedProtocol: false,
      error: lastOutput || 'No supported package manager was available.',
    };
  })().finally(() => { managedInstall = null; });
  return managedInstall;
}
