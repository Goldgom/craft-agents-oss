import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { delimiter, extname, isAbsolute, join } from 'node:path';

export interface NativeCodexBinary {
  path: string;
  source: 'CRAFT_CODEX_PATH' | 'CODEX_PATH' | 'bundled' | 'PATH';
  version: string;
  testedProtocol: boolean;
}

const TESTED_VERSION = /^0\.154\./;
let cached: NativeCodexBinary | null | undefined;
let configuredResourcesPath: string | undefined;

function executableName(): string {
  return platform() === 'win32' ? 'codex.exe' : 'codex';
}

function pathCandidates(env: NodeJS.ProcessEnv): string[] {
  const names = platform() === 'win32'
    ? ['codex.exe', 'codex.cmd', 'codex.bat']
    : ['codex'];
  return (env.PATH ?? '').split(delimiter).filter(Boolean).flatMap(dir => names.map(name => join(dir, name)));
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
