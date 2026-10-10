import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const config = mkdtempSync(join(tmpdir(), 'tokenbird-installer-policy-'));
const previous = process.env.TOKENBIRD_CONFIG_DIR; process.env.TOKENBIRD_CONFIG_DIR = config;
const { installBackendFramework, cancelBackendFrameworkInstall, describeFrameworkInstallation } = await import('./framework-installer');
const { getBackendFrameworkCatalog, saveBackendFrameworkConfiguration } = await import('./framework-storage');
const host = { appRootPath: resolve(import.meta.dir, '../../../../apps/electron'), isPackaged: false };
afterAll(() => { if (previous === undefined) delete process.env.TOKENBIRD_CONFIG_DIR; else process.env.TOKENBIRD_CONFIG_DIR = previous; });

test('unsupported recipes and unknown sources fail before downloading or changing configuration', async () => {
  expect((await installBackendFramework('plugin:unknown', host)).success).toBe(false);
  expect((await installBackendFramework('codex', host, () => {}, 'untrusted' as any)).success).toBe(false);
  expect(existsSync(join(config, 'runtime'))).toBe(false);
});

test('cancelling a deduplicated install preserves the working configuration and cleans its staging directory', async () => {
  const codex = getBackendFrameworkCatalog().frameworks.find(item => item.id === 'codex')!;
  saveBackendFrameworkConfiguration({ ...codex.configuration, executablePath: '/current/working/codex' });
  const settings = readFileSync(join(config, 'agent-frameworks.json'), 'utf8');
  const phases: string[] = [];
  const pending = installBackendFramework('codex', host, progress => { phases.push(progress.phase); if (progress.phase === 'preparing') cancelBackendFrameworkInstall('codex'); });
  expect(installBackendFramework('codex', host)).toBe(pending);
  expect(await pending).toMatchObject({ success: false, error: 'Backend installation cancelled' });
  expect(phases.at(-1)).toBe('cancelled');
  expect(readFileSync(join(config, 'agent-frameworks.json'), 'utf8')).toBe(settings);
  expect(readdirSync(join(config, 'runtime/frameworks/codex'))).toEqual([]);
  expect(describeFrameworkInstallation(codex).installation?.progress).toBeUndefined();
});

test('availability requires a native executable and framework-specific entrypoint', () => {
  const entry = getBackendFrameworkCatalog().frameworks.find(item => item.id === 'plugin:hermes')!;
  const executable = join(config, 'python.exe'); writeFileSync(executable, 'fixture');
  expect(describeFrameworkInstallation({ ...entry, configuration: { ...entry.configuration, executablePath: executable, projectPath: config } }).installation)
    .toMatchObject({ available: false, installable: true });
});
