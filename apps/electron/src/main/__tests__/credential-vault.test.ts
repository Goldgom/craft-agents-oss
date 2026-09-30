import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { SecureStorageBackend } from '@craft-agent/shared/credentials/backends/secure-storage';
import { CredentialManager } from '@craft-agent/shared/credentials';
import { configureElectronCredentialVault, ElectronCredentialVault } from '../credential-vault';
import { nativeVaultFixture } from './fixtures/native-vault-harness';

const cleanups: Array<() => void> = [];
function fixture() { const item = nativeVaultFixture(); cleanups.push(item.cleanup); return item; }
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const id = { type: 'llm_oauth' as const, connectionSlug: 'dummy-model' };
const oldCredential = { value: 'dummy-access', refreshToken: 'dummy-refresh', clientSecret: 'dummy-client-secret', expiresAt: 100 };

test('existing legacy LLM reads, writes and refreshes remain usable without OS protection or implicit migration', async () => {
  const item = fixture();
  const legacy = new SecureStorageBackend(item.filePath);
  await legacy.set(id, oldCredential);
  item.state.available = false;
  item.state.selected = 'basic_text';
  const manager = new CredentialManager();
  const vault = configureElectronCredentialVault({ ...item, platform: 'linux', manager });
  expect(await manager.get(id)).toEqual(oldCredential);
  await manager.set(id, { ...oldCredential, value: 'dummy-refreshed', refreshToken: 'dummy-rotated' });
  expect((await legacy.get(id))?.value).toBe('dummy-refreshed');
  expect((await vault.status())).toMatchObject({ state: 'ready', protection: 'legacy-machine', canApply: true, canMigrate: false });
  expect(readFileSync(item.filePath).subarray(0, 8).toString()).toBe('CRAFT01\0');
  expect(item.state.wraps).toBe(0);
  expect(item.state.unwraps).toBe(0);
  item.state.available = true;
  item.state.selected = 'gnome_libsecret';
  await manager.set(id, { ...oldCredential, value: 'dummy-still-legacy' });
  expect((await vault.status())).toMatchObject({ protection: 'legacy-machine', canMigrate: true });
  expect(item.state.wraps).toBe(0);
});

test('explicit optional migration preserves every credential and the exact encrypted rollback snapshot', async () => {
  const item = fixture();
  const legacy = new SecureStorageBackend(item.filePath);
  await legacy.set(id, oldCredential);
  const original = readFileSync(item.filePath);
  const vault = item.create();
  expect(await vault.migrate()).toEqual({ migratedCredentialCount: 1, backupCreated: true });
  expect(vault.readLegacyRollbackSnapshot()).toEqual(original);
  expect(readFileSync(`${item.filePath}.legacy-backup`).subarray(0, 8).toString()).toBe('TBROLL01');
  await expect(new SecureStorageBackend(`${item.filePath}.legacy-backup`).get(id)).rejects.toThrow('protected by Electron');
  // Explicit recovery to an owned alternate destination proves byte-for-byte
  // rollback without modifying the live native vault or exposing an IPC getter.
  const recoveredPath = `${item.filePath}.dummy-recovered`;
  writeFileSync(recoveredPath, vault.readLegacyRollbackSnapshot(), { mode: 0o600 });
  expect(await new SecureStorageBackend(recoveredPath).get(id)).toEqual(oldCredential);
  expect(readFileSync(item.filePath).subarray(0, 8).toString()).toBe('TBVAULT2');
  expect(readFileSync(item.filePath).includes(Buffer.from('dummy-access'))).toBe(false);
  expect(await item.create().backend.get(id)).toEqual(oldCredential);
  await vault.backend.set(id, { ...oldCredential, value: 'dummy-new-native', refreshToken: 'dummy-native-refresh' });
  expect((await item.create().backend.get(id))?.refreshToken).toBe('dummy-native-refresh');
  expect(await vault.migrate()).toEqual({ migratedCredentialCount: 0, backupCreated: false });
  expect(await vault.status()).toMatchObject({ state: 'ready', protection: 'electron-safe-storage', requiresSeparateHeadlessConfig: true });
  // Standalone/headless must reject the native format, never consult the backup.
  await expect(legacy.get(id)).rejects.toThrow('protected by Electron');
  const headlessManager = new CredentialManager();
  headlessManager.configureBackend(new SecureStorageBackend(item.filePath));
  await expect(headlessManager.get(id)).rejects.toThrow('protected by Electron');
  if (process.platform !== 'win32') {
    expect(statSync(item.filePath).mode & 0o777).toBe(0o600);
    expect(statSync(`${item.filePath}.legacy-backup`).mode & 0o777).toBe(0o600);
  }
});

test('failed OS wrapping leaves legacy LLM refresh usable and a retry backs up the latest snapshot', async () => {
  const item = fixture();
  const legacy = new SecureStorageBackend(item.filePath);
  await legacy.set(id, oldCredential);
  const original = readFileSync(item.filePath);
  const vault = item.create();
  item.state.failEncrypt = true;
  const error = await vault.migrate().then(() => undefined, error => error as Error);
  expect(error?.message).not.toContain('dummy-secret-echo');
  expect(error?.cause).toBeUndefined();
  expect(readFileSync(item.filePath)).toEqual(original);
  await vault.backend.set(id, { ...oldCredential, value: 'dummy-after-failed-upgrade' });
  expect((await legacy.get(id))?.value).toBe('dummy-after-failed-upgrade');
  const latest = readFileSync(item.filePath);
  item.state.failEncrypt = false;
  await vault.migrate();
  expect(vault.readLegacyRollbackSnapshot()).toEqual(latest);
  expect((await vault.backend.get(id))?.value).toBe('dummy-after-failed-upgrade');
});

test('failed native publish preserves legacy file/cache, then normal writes and a later upgrade succeed', async () => {
  const item = fixture();
  await new SecureStorageBackend(item.filePath).set(id, oldCredential);
  const original = readFileSync(item.filePath);
  const vault = item.create();
  const persist = (vault.backend as any).persistFileSync.bind(vault.backend);
  const fault = spyOn(vault.backend as any, 'persistFileSync').mockImplementation((target: string, bytes: Buffer) => {
    if (target === item.filePath) throw new Error('dummy-secret-echo');
    persist(target, bytes);
  });
  await expect(vault.migrate()).rejects.toThrow('existing credential vault is unchanged');
  fault.mockRestore();
  expect(readFileSync(item.filePath)).toEqual(original);
  expect(await vault.backend.get(id)).toEqual(oldCredential);
  await vault.backend.set(id, { ...oldCredential, value: 'dummy-normal-refresh' });
  await vault.migrate();
  expect((await item.create().backend.get(id))?.value).toBe('dummy-normal-refresh');
  expect(readdirSync(item.directory).filter(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);
});

test('migrated native vault fails closed on unavailable/basic_text OS storage without fallback or overwrite', async () => {
  const item = fixture();
  await new SecureStorageBackend(item.filePath).set(id, oldCredential);
  const vault = item.create();
  await vault.migrate();
  const native = readFileSync(item.filePath);
  item.state.selected = 'basic_text';
  expect(await vault.status()).toMatchObject({ state: 'unavailable', protection: 'electron-safe-storage', canApply: false, errorCode: 'OS_STORAGE_INSECURE' });
  await expect(vault.backend.get(id)).rejects.toThrow('No secure operating system');
  expect(() => vault.readLegacyRollbackSnapshot()).toThrow('No secure operating system');
  await expect(vault.backend.set(id, { value: 'must-not-save' })).rejects.toThrow();
  expect(readFileSync(item.filePath)).toEqual(native);
  item.state.selected = 'gnome_libsecret';
  item.state.available = false;
  await expect(item.create().backend.get(id)).rejects.toThrow('unavailable');
  item.state.available = true;
  expect(await item.create().backend.get(id)).toEqual(oldCredential);
});

test('empty vault initializes native only on save and refuses unsupported OS storage', async () => {
  const item = fixture();
  const vault = item.create();
  expect(await vault.status()).toMatchObject({ state: 'empty', canApply: true });
  expect(existsSync(item.filePath)).toBe(false);
  item.state.selected = 'basic_text';
  await expect(vault.backend.set(id, oldCredential)).rejects.toThrow('No secure operating system');
  expect(existsSync(item.filePath)).toBe(false);
  item.state.selected = 'gnome_libsecret';
  await vault.backend.set(id, oldCredential);
  expect(vault.backend.getProtectionFormat()).toBe('native');
  expect(vault.backend.hasLegacyBackup()).toBe(false);
});

test('atomic mixed mutation preserves omitted secrets, clears explicit nulls, and rejects all invalid batches before commit', async () => {
  const item = fixture();
  const vault = item.create();
  const other = { type: 'anthropic_api_key' as const };
  await vault.backend.setMany([{ id, credential: { ...oldCredential, idToken: 'dummy-id-token' } }, { id: other, credential: { value: 'dummy-remove' } }]);
  const original = readFileSync(item.filePath);
  await expect(vault.apply([{ op: 'delete', id }, { op: 'upsert', id: { type: 'claude_oauth' }, credential: { refreshToken: 'missing-value' } }])).rejects.toThrow('invalid');
  expect(readFileSync(item.filePath)).toEqual(original);
  expect(await vault.apply([{ op: 'upsert', id, credential: { value: 'dummy-replacement', idToken: null } }, { op: 'delete', id: other }])).toEqual({ upsertedCount: 1, deletedCount: 1 });
  expect(await vault.backend.get(id)).toEqual({ ...oldCredential, value: 'dummy-replacement' });
  expect(await vault.backend.get(other)).toBeNull();
  const committed = readFileSync(item.filePath);
  for (const changes of [
    [{ op: 'delete', id }, { op: 'delete', id }],
    [{ op: 'upsert', id, credential: { value: 'dummy', unknown: 'dummy' } }],
    [{ op: 'delete', id: { ...id, workspaceId: 'ignored-scope' } }],
    [{ op: 'upsert', id, credential: { expiresAt: Infinity } }],
  ]) await expect(vault.apply(changes as any)).rejects.toThrow('invalid');
  expect(readFileSync(item.filePath)).toEqual(committed);
});

test('native corruption and OS decryption errors preserve files and return no provider details', async () => {
  const item = fixture();
  await item.create().backend.set(id, oldCredential);
  const original = readFileSync(item.filePath);
  item.state.failDecrypt = true;
  const failure = await item.create().backend.get(id).then(() => undefined, error => error as Error);
  expect(failure?.message).not.toContain('dummy-secret-echo');
  expect(failure?.cause).toBeUndefined();
  item.state.failDecrypt = false;
  const corrupt = Buffer.from(original);
  corrupt[corrupt.length - 1]! ^= 1;
  writeFileSync(item.filePath, corrupt);
  const vault = item.create();
  expect(await vault.status()).toMatchObject({ state: 'error', canApply: false });
  await expect(vault.backend.set(id, oldCredential)).rejects.toThrow();
  expect(readFileSync(item.filePath)).toEqual(corrupt);
});

test('native independent instances preserve concurrent writes and observe each other’s commits', async () => {
  const item = fixture();
  const first = item.create().backend;
  const second = item.create().backend;
  await first.set(id, oldCredential);
  await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).set({ type: 'llm_api_key', connectionSlug: `dummy-${index}` }, { value: `dummy-${index}` })));
  expect(await first.list()).toHaveLength(21);
  expect(await second.list()).toHaveLength(21);
  expect(await first.get(id)).toEqual(oldCredential);
});

test('normal cached native refresh writes do not repeatedly unwrap the OS key', async () => {
  const item = fixture();
  const vault = item.create();
  await vault.backend.set(id, oldCredential);
  const wraps = item.state.wraps;
  const unwraps = item.state.unwraps;
  for (let index = 0; index < 10; index++) await vault.backend.set(id, { ...oldCredential, value: `dummy-refreshed-${index}` });
  expect(item.state.wraps).toBe(wraps);
  expect(item.state.unwraps).toBe(unwraps);
  expect((await item.create().backend.get(id))?.value).toBe('dummy-refreshed-9');
});

test('optional remote staging failure leaves legacy LLM reads and refresh persistence usable', async () => {
  const item = fixture();
  await new SecureStorageBackend(item.filePath).set(id, oldCredential);
  const vault = new ElectronCredentialVault({ ...item, platform: 'linux', remoteMigration: {
    hasPending: () => true,
    listMetadata: async () => { throw new Error('dummy-secret-registry-error'); },
    migrate: async () => {
      await vault.backend.set({ type: 'remote_server_token', name: 'dummy-owner/dummy-revision' }, { value: 'dummy-staged-remote' });
      throw new Error('dummy-secret-publish-error');
    },
  } });
  expect(await vault.status()).toMatchObject({ state: 'ready', protection: 'legacy-machine', canApply: true, pendingRemoteCredentials: true });
  expect(await vault.listManagedMetadata()).toEqual({ managedEntries: [], managedEntriesUnavailable: true });
  await expect(vault.migrate()).rejects.toThrow('Existing credentials remain usable');
  expect(vault.backend.getProtectionFormat()).toBe('legacy');
  expect(await vault.backend.get(id)).toEqual(oldCredential);
  await vault.backend.set(id, { ...oldCredential, value: 'dummy-refresh-after-partial-remote' });
  expect((await new SecureStorageBackend(item.filePath).get(id))?.value).toBe('dummy-refresh-after-partial-remote');
  expect((await vault.listMetadata()).some(entry => entry.id.type.startsWith('remote_'))).toBe(false);
});

test('already-native vault reports pending managed migration and preserves explicit retry without leaking secret properties', async () => {
  const item = fixture();
  let pending = true;
  const vault = new ElectronCredentialVault({ ...item, platform: 'linux', remoteMigration: {
    hasPending: () => pending,
    listMetadata: async () => [{ kind: 'remote-profile', id: 'dummy-profile', name: 'Dummy profile',
      serverOrigin: 'https://user:dummy-secret@example.invalid/path?token=dummy-secret', fields: ['token'],
      protection: 'legacy-configuration', settingsTarget: 'remoteServers', value: 'dummy-secret',
    } as any],
    migrate: async () => { pending = false; return { migratedSecretCount: 1 }; },
  } });
  await vault.backend.set(id, oldCredential);
  expect(await vault.status()).toMatchObject({ protection: 'electron-safe-storage', canMigrate: true, pendingRemoteCredentials: true });
  expect(JSON.stringify(await vault.listManagedMetadata())).not.toContain('dummy-secret');
  expect((await vault.listManagedMetadata()).managedEntries[0]?.serverOrigin).toBe('https://example.invalid');
  expect(await vault.migrate()).toMatchObject({ migratedCredentialCount: 1, migratedRemoteSecretCount: 1 });
  expect(await vault.status()).toMatchObject({ protection: 'electron-safe-storage', canMigrate: false });
});
