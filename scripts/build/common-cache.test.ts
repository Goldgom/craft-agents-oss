import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BUN_VERSION,
  NODE_VERSION,
  PYTHON_VERSION,
  TEMURIN_JDK_VERSION,
  UV_VERSION,
  downloadBun,
  downloadUv,
  downloadWindowsToolchains,
  type BuildConfig,
} from './common';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function buildConfig(): BuildConfig {
  const rootDir = mkdtempSync(join(tmpdir(), 'tokenbird-build-cache-'));
  temporaryDirectories.push(rootDir);
  return {
    platform: 'win32',
    arch: 'x64',
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir,
    electronDir: join(rootDir, 'electron'),
  };
}

describe('local build runtime caches', () => {
  it('reuses the pinned Bun binary without fetching it again', async () => {
    const config = buildConfig();
    const vendorDir = join(config.electronDir, 'vendor', 'bun');
    mkdirSync(vendorDir, { recursive: true });
    const binary = join(vendorDir, 'bun.exe');
    writeFileSync(binary, 'cached Bun');
    writeFileSync(join(vendorDir, '.build-runtime'), `${BUN_VERSION}:bun-windows-x64-baseline`);

    await downloadBun(config);

    expect(readFileSync(binary, 'utf8')).toBe('cached Bun');
  });

  it('reuses the pinned uv binary without fetching it again', async () => {
    const config = buildConfig();
    const binDir = join(config.electronDir, 'resources', 'bin', 'win32-x64');
    mkdirSync(binDir, { recursive: true });
    const binary = join(binDir, 'uv.exe');
    writeFileSync(binary, 'cached uv');
    writeFileSync(join(binDir, '.uv-build-version'), UV_VERSION);

    await downloadUv(config);

    expect(readFileSync(binary, 'utf8')).toBe('cached uv');
  });

  it('accepts existing cross-platform binaries before a version stamp exists', async () => {
    const config = buildConfig();
    config.platform = process.platform === 'linux' ? 'darwin' : 'linux';
    const platformKey = `${config.platform}-x64`;
    config.bunVendorDir = join(config.electronDir, 'vendor', 'server-bun', platformKey);
    mkdirSync(config.bunVendorDir, { recursive: true });
    const bunBinary = join(config.bunVendorDir, 'bun');
    writeFileSync(bunBinary, 'pre-seeded Bun');

    const uvDir = join(config.electronDir, 'resources', 'bin', platformKey);
    mkdirSync(uvDir, { recursive: true });
    const uvBinary = join(uvDir, 'uv');
    writeFileSync(uvBinary, 'pre-seeded uv');

    await downloadBun(config);
    await downloadUv(config);

    expect(readFileSync(bunBinary, 'utf8')).toBe('pre-seeded Bun');
    expect(readFileSync(uvBinary, 'utf8')).toBe('pre-seeded uv');
    expect(readFileSync(join(config.bunVendorDir, '.build-runtime'), 'utf8'))
      .toBe(`${BUN_VERSION}:${config.platform === 'linux' ? 'bun-linux-x64-baseline' : 'bun-darwin-x64'}`);
    expect(readFileSync(join(uvDir, '.uv-build-version'), 'utf8')).toBe(UV_VERSION);
  });

  it('reuses a complete pinned Windows toolchain', async () => {
    const config = buildConfig();
    const toolchainsDir = join(config.electronDir, 'vendor', 'toolchains');
    for (const relativePath of [
      'node/node.exe', 'node/npm.cmd',
      'python/python.exe', 'python/Lib/site-packages/pip/__init__.py',
      'jdk/bin/java.exe', 'jdk/bin/javac.exe',
    ]) {
      const path = join(toolchainsDir, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'cached');
    }
    writeFileSync(join(toolchainsDir, '.build-versions'), `${NODE_VERSION}:${PYTHON_VERSION}:${TEMURIN_JDK_VERSION}`);

    await downloadWindowsToolchains(config);

    expect(readFileSync(join(toolchainsDir, 'node', 'node.exe'), 'utf8')).toBe('cached');
    expect(readFileSync(join(toolchainsDir, 'python', 'Scripts', 'pip.cmd'), 'utf8')).toContain('python.exe');
  });
});
