import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { nativeVaultFixture } from './fixtures/native-vault-harness';
import { recoverStartupCredentials, type CredentialStartupRecoveryDependencies } from '../credential-startup-recovery';
import type { NativeCredentialVaultStatus } from '@tokenbird/shared/credentials/native-types';

const fixtures: ReturnType<typeof nativeVaultFixture>[] = [];
afterEach(() => { for (const item of fixtures.splice(0)) item.cleanup(); });
function fixture() { const item = nativeVaultFixture(); fixtures.push(item); return item; }
const id = { type: 'anthropic_api_key' as const };
const blocked: NativeCredentialVaultStatus = {
  state: 'error', protection: 'electron-safe-storage', backend: 'dpapi', canList: false,
  canApply: false, canMigrate: false, legacyBackupAvailable: true,
  requiresSeparateHeadlessConfig: true, errorCode: 'VAULT_READ_FAILED',
};
const ready: NativeCredentialVaultStatus = { ...blocked, state: 'ready', errorCode: undefined };
function dependencies(overrides: Partial<CredentialStartupRecoveryDependencies> = {}): CredentialStartupRecoveryDependencies {
  return {
    status: async () => blocked,
    reset: async () => { throw new Error('Unexpected reset'); },
    prompt: async () => 'quit', wait: async () => {}, report: () => {}, ...overrides,
  };
}

test('transient OS failure recovers automatically without prompting or resetting', async () => {
  let reads = 0;
  const waits: number[] = [];
  expect(await recoverStartupCredentials(dependencies({
    status: async () => ++reads < 3 ? blocked : ready,
    wait: async ms => { waits.push(ms); },
    prompt: async () => { throw new Error('Unexpected dialog'); },
  }))).toBe('ready');
  expect(waits).toEqual([250, 750]);
});

test('persistent failure offers a picker without changing credentials', async () => {
  let prompts = 0;
  expect(await recoverStartupCredentials(dependencies({ prompt: async status => {
    prompts++; expect(status.errorCode).toBe('VAULT_READ_FAILED'); return 'picker';
  } }))).toBe('picker');
  expect(prompts).toBe(1);
});

test('reconfigure requires an explicit choice and a native vault', async () => {
  let prompts = 0;
  expect(await recoverStartupCredentials(dependencies({
    status: async () => ({ ...blocked, protection: 'legacy-machine' }),
    prompt: async () => ++prompts === 1 ? 'reconfigure' : 'quit',
  }))).toBe('quit');
});

test('failed backup/reset remains in recovery and can be retried', async () => {
  let prompts = 0, resets = 0;
  expect(await recoverStartupCredentials(dependencies({
    reset: async () => { if (++resets === 1) throw new Error('Disk error'); return {}; },
    prompt: async (_status, resetFailed) => {
      expect(resetFailed).toBe(++prompts > 1); return 'reconfigure';
    },
  }))).toBe('picker');
  expect(resets).toBe(2);
});

test('lost OS key is backed up exactly and replaced with a usable protected vault', async () => {
  const item = fixture();
  await item.create().backend.set(id, { value: 'dummy-key' });
  const damaged = readFileSync(item.filePath);
  damaged[20] = damaged[20]! ^ 1; // Corrupt only the OS-wrapped key.
  writeFileSync(item.filePath, damaged);
  const vault = item.create();
  expect((await vault.status()).errorCode).toBe('VAULT_READ_FAILED');
  expect(await recoverStartupCredentials(dependencies({
    status: () => vault.status(), reset: () => vault.backend.resetUnreadableNativeVault(),
    prompt: async () => 'reconfigure',
  }))).toBe('picker');
  const backups = readdirSync(item.directory).filter(name => name.includes('.recovery-'));
  expect(backups).toHaveLength(1);
  expect(readFileSync(`${item.directory}/${backups[0]}`)).toEqual(damaged);
  expect(readFileSync(item.filePath).subarray(0, 8).toString()).toBe('TBVAULT2');
  expect((await item.create().status()).state).toBe('ready');
  expect(await vault.backend.get(id)).toBeNull();
  await vault.backend.set(id, { value: 'dummy-reconfigured' });
  expect((await item.create().backend.get(id))?.value).toBe('dummy-reconfigured');
  expect(existsSync(`${item.filePath}.lock`)).toBe(false);
});

test('OS write failure preserves the live original and its recovery backup', async () => {
  const item = fixture();
  await item.create().backend.set(id, { value: 'dummy-key' });
  const damaged = readFileSync(item.filePath); damaged[20] = damaged[20]! ^ 1;
  writeFileSync(item.filePath, damaged);
  item.state.failEncrypt = true;
  await expect(item.create().backend.resetUnreadableNativeVault()).rejects.toThrow();
  expect(readFileSync(item.filePath)).toEqual(damaged);
  expect(readdirSync(item.directory).filter(name => name.includes('.recovery-'))).toHaveLength(1);
});

test('healthy, temporarily locked, and concurrent-writer vaults are never reset', async () => {
  const item = fixture();
  await item.create().backend.set(id, { value: 'dummy-key' });
  const original = readFileSync(item.filePath);
  expect(await item.create().backend.resetUnreadableNativeVault()).toEqual({});
  item.state.available = false;
  await expect(item.create().backend.resetUnreadableNativeVault()).rejects.toThrow();
  expect(readFileSync(item.filePath)).toEqual(original);
  item.state.available = true;
  writeFileSync(`${item.filePath}.lock`, 'busy');
  await expect(item.create().backend.resetUnreadableNativeVault()).rejects.toThrow();
  expect(readFileSync(item.filePath)).toEqual(original);
  expect(readdirSync(item.directory).filter(name => name.includes('.recovery-'))).toHaveLength(0);
}, 10000);
