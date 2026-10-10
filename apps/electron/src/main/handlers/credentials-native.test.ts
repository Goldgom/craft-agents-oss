import { afterEach, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SecureStorageBackend } from '@craft-agent/shared/credentials/backends/secure-storage';
import { NATIVE_CREDENTIAL_IPC, NATIVE_CREDENTIAL_TYPES } from '@craft-agent/shared/credentials/native-types';
import type { CredentialId, CredentialType } from '@craft-agent/shared/credentials';
import { nativeVaultFixture } from '../__tests__/fixtures/native-vault-harness';
import { advanceNativeWindowBinding, createNativeWindowAuthority, type NativeAuthorityEvent } from '../native-window-authority';
import { registerNativeCredentialIpcHandlers } from './credentials-native';
import { sourceCredentialWorkspaceId } from '../credential-scope';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function idFor(type: CredentialType, workspaceId = 'local-a'): CredentialId {
  return type.startsWith('llm_') ? { type, connectionSlug: 'dummy-provider' }
    : type.startsWith('source_') ? { type, workspaceId, sourceId: 'dummy-source' }
    : type === 'workspace_oauth' ? { type, workspaceId }
    : type === 'messaging_bearer' || type === 'page_publish_token' || type === 'saved_credential' ? { type, workspaceId, name: 'dummy-account' }
    : { type };
}
async function fixture(onApplied?: import('./credentials-native').NativeCredentialHandlerDeps['onApplied']) {
  const storage = nativeVaultFixture();
  cleanups.push(storage.cleanup);
  await new SecureStorageBackend(storage.filePath).setMany(NATIVE_CREDENTIAL_TYPES.map(type => ({
    id: idFor(type), credential: { value: `dummy-secret-${type}`, refreshToken: 'dummy-secret-refresh', clientSecret: 'dummy-secret-client', expiresAt: 123 },
  })));
  const vault = storage.create();
  await vault.backend.set(idFor('source_bearer', 'local-b'), { value: 'dummy-other-workspace-secret' });
  const frame = { url: 'file:///owned/renderer/index.html', processId: 1, routingId: 2 };
  const sender = { id: 7, mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false };
  const window = { webContents: sender, isDestroyed: () => false };
  const state = { workspaceId: 'local-a', local: true, sourceAlias: 'local-a' as string | null };
  const assertSender = createNativeWindowAuthority({
    getWindowByWebContentsId: id => id === sender.id ? window : null,
    getWorkspaceForWindow: () => state.workspaceId,
  }, ['file:///owned/renderer/index.html']);
  const handlers = new Map<string, (event: NativeAuthorityEvent, ...args: unknown[]) => Promise<any>>();
  registerNativeCredentialIpcHandlers({ handle: (channel, handler) => { handlers.set(channel, handler); } }, {
    vault, assertSender, onApplied, isLocalWorkspace: workspaceId => state.local && ['local-a', 'local-b'].includes(workspaceId),
    getSourceWorkspaceId: () => state.sourceAlias,
  });
  const event = { sender, senderFrame: frame };
  return { ...storage, vault, handlers, event, windowState: state, invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args) };
}

test('native-only inventory covers every existing domain, redacts secrets and limits workspace scope', async () => {
  const item = await fixture();
  expect([...item.handlers.keys()].sort()).toEqual(Object.values(NATIVE_CREDENTIAL_IPC).sort());
  const result = await item.invoke(NATIVE_CREDENTIAL_IPC.LIST);
  expect(result.ok).toBe(true);
  expect(result.value.status).toMatchObject({ protection: 'legacy-machine', state: 'ready', canApply: true, canMigrate: true });
  expect(result.value.entries).toHaveLength(NATIVE_CREDENTIAL_TYPES.length);
  expect(result.value.entries.map((entry: any) => entry.id.type).sort()).toEqual([...NATIVE_CREDENTIAL_TYPES].sort());
  expect(JSON.stringify(result)).not.toContain('dummy-secret');
  expect(JSON.stringify(result)).not.toContain('dummy-other-workspace-secret');
  expect(result.value.scope).toEqual({ workspaceId: 'local-a', sourceWorkspaceId: 'local-a', sourceScopeUnavailable: false, includesGlobal: true, includesLlm: true });
});

test('forged sender IDs, subframes, navigations and remote windows cannot read or mutate', async () => {
  const item = await fixture();
  const original = readFileSync(item.filePath);
  const handler = item.handlers.get(NATIVE_CREDENTIAL_IPC.LIST)!;
  expect((await handler({ ...item.event, sender: { ...item.event.sender } })).code).toBe('UNTRUSTED_SENDER');
  expect((await handler({ ...item.event, senderFrame: { ...item.event.senderFrame } })).code).toBe('UNTRUSTED_SENDER');
  item.event.senderFrame.url = 'https://untrusted.invalid/';
  expect((await item.invoke(NATIVE_CREDENTIAL_IPC.STATUS)).code).toBe('UNTRUSTED_SENDER');
  item.event.senderFrame.url = 'file:///owned/renderer/index.html';
  item.windowState.local = false;
  expect((await item.invoke(NATIVE_CREDENTIAL_IPC.LIST)).code).toBe('SCOPE_NOT_ALLOWED');
  expect((await item.invoke(NATIVE_CREDENTIAL_IPC.MIGRATE, { acknowledgeHeadlessIncompatibility: true })).code).toBe('SCOPE_NOT_ALLOWED');
  expect(readFileSync(item.filePath)).toEqual(original);
});

test('entire mixed batch is denied before any write if one ID is cross-workspace or has an ignored scope alias', async () => {
  const item = await fixture();
  const original = readFileSync(item.filePath);
  const crossScope = await item.invoke(NATIVE_CREDENTIAL_IPC.APPLY, { changes: [
    { op: 'delete', id: idFor('anthropic_api_key') },
    { op: 'delete', id: idFor('source_bearer', 'local-b') },
  ] });
  expect(crossScope.code).toBe('SCOPE_NOT_ALLOWED');
  const aliased = await item.invoke(NATIVE_CREDENTIAL_IPC.APPLY, { changes: [
    { op: 'delete', id: { type: 'anthropic_api_key', workspaceId: 'local-b' } },
  ] });
  expect(aliased.code).toBe('INVALID_REQUEST');
  const forged = await item.invoke(NATIVE_CREDENTIAL_IPC.APPLY, { webContentsId: 7, changes: [] });
  expect(forged.code).toBe('INVALID_REQUEST');
  expect(readFileSync(item.filePath)).toEqual(original);
});

test('write-only replacements and deletion are atomic and never return old or submitted values', async () => {
  const item = await fixture();
  const id = idFor('llm_oauth');
  const result = await item.invoke(NATIVE_CREDENTIAL_IPC.APPLY, { changes: [
    { op: 'upsert', id, credential: { value: 'dummy-updated-secret' } },
    { op: 'delete', id: idFor('source_basic') },
  ] });
  expect(result.ok).toBe(true);
  expect(result.value).toMatchObject({ upsertedCount: 1, deletedCount: 1 });
  expect(JSON.stringify(result)).not.toContain('dummy-updated-secret');
  expect((await item.vault.backend.get(id))?.refreshToken).toBe('dummy-secret-refresh');
  expect((await item.vault.backend.get(id))?.value).toBe('dummy-updated-secret');
  expect(await item.vault.backend.get(idFor('source_basic'))).toBeNull();
});

test('protection upgrade requires explicit fixed acknowledgement and never returns key material', async () => {
  const item = await fixture();
  expect((await item.invoke(NATIVE_CREDENTIAL_IPC.MIGRATE, {})).code).toBe('INVALID_REQUEST');
  expect((await item.invoke(NATIVE_CREDENTIAL_IPC.MIGRATE, { acknowledgeHeadlessIncompatibility: false })).code).toBe('INVALID_REQUEST');
  expect(item.vault.backend.getProtectionFormat()).toBe('legacy');
  const upgraded = await item.invoke(NATIVE_CREDENTIAL_IPC.MIGRATE, { acknowledgeHeadlessIncompatibility: true });
  expect(upgraded.ok).toBe(true);
  expect(upgraded.value.status).toMatchObject({ protection: 'electron-safe-storage', requiresSeparateHeadlessConfig: true });
  expect(upgraded.value.migratedCredentialCount).toBe(NATIVE_CREDENTIAL_TYPES.length + 1);
  expect(JSON.stringify(upgraded)).not.toContain('dummy-secret');
  expect(JSON.stringify(upgraded)).not.toContain('wrapped');
});

test('stale asynchronous inventory is discarded when the native window binding changes', async () => {
  const item = await fixture();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const list = item.vault.listMetadata.bind(item.vault);
  const pendingList = spyOn(item.vault, 'listMetadata').mockImplementation(async () => { entered(); await gate; return list(); });
  const pending = item.invoke(NATIVE_CREDENTIAL_IPC.LIST);
  await started;
  item.windowState.workspaceId = 'local-b';
  advanceNativeWindowBinding(item.event.sender);
  release();
  const result = await pending;
  pendingList.mockRestore();
  expect(result.code).toBe('SCOPE_NOT_ALLOWED');
  expect(JSON.stringify(result)).not.toContain('dummy-secret');
  expect(result.value).toBeUndefined();
});

test('provider errors are fixed/redacted and legacy inventory remains available if optional OS upgrade is unavailable', async () => {
  const item = await fixture();
  item.state.available = false;
  const unavailable = await item.invoke(NATIVE_CREDENTIAL_IPC.MIGRATE, { acknowledgeHeadlessIncompatibility: true });
  expect(unavailable.code).toBe('OS_STORAGE_UNAVAILABLE');
  expect((await item.invoke(NATIVE_CREDENTIAL_IPC.LIST)).ok).toBe(true);
  item.state.available = true;
  item.state.failEncrypt = true;
  const failed = await item.invoke(NATIVE_CREDENTIAL_IPC.MIGRATE, { acknowledgeHeadlessIncompatibility: true });
  expect(failed.ok).toBe(false);
  expect(JSON.stringify(failed)).not.toContain('dummy-secret-echo');
  expect((await item.invoke(NATIVE_CREDENTIAL_IPC.STATUS)).value.status.protection).toBe('legacy-machine');
});

test('post-commit reconciliation failure reports saved success with a fixed warning and no secret input to the hook', async () => {
  let notified: unknown;
  const item = await fixture(async changes => { notified = changes; throw new Error('dummy-secret-runtime-echo'); });
  const id = idFor('llm_api_key');
  const result = await item.invoke(NATIVE_CREDENTIAL_IPC.APPLY, { changes: [{ op: 'upsert', id, credential: { value: 'dummy-new-secret' } }] });
  expect(result.ok).toBe(true);
  expect(result.value).toMatchObject({ upsertedCount: 1, warnings: ['RUNTIME_RECONCILIATION_PENDING'] });
  expect(notified).toEqual([{ op: 'upsert', id, fields: ['value'] }]);
  expect(JSON.stringify(result)).not.toContain('dummy-secret-runtime-echo');
  expect((await item.vault.backend.get(id))?.value).toBe('dummy-new-secret');
});

test('source namespace uses trusted root basename rather than the registered window ID', async () => {
  const item = await fixture();
  const workspaces = [{ id: 'local-a', rootPath: join(item.directory, 'source-folder') }, { id: 'local-b', rootPath: join(item.directory, 'other-folder') }];
  item.windowState.sourceAlias = sourceCredentialWorkspaceId('local-a', workspaces);
  expect(item.windowState.sourceAlias).toBe('source-folder');
  const sourceId = idFor('source_bearer', 'source-folder');
  await item.vault.backend.set(sourceId, { value: 'dummy-canonical-source' });
  const inventory = await item.invoke(NATIVE_CREDENTIAL_IPC.LIST);
  expect(inventory.value.scope).toMatchObject({ workspaceId: 'local-a', sourceWorkspaceId: 'source-folder', sourceScopeUnavailable: false });
  expect(inventory.value.entries.filter((entry: any) => entry.id.type.startsWith('source_')).map((entry: any) => entry.id)).toEqual([sourceId]);
  expect((await item.invoke(NATIVE_CREDENTIAL_IPC.APPLY, { changes: [{ op: 'upsert', id: sourceId, credential: { value: 'dummy-updated-source' } }] })).ok).toBe(true);
  expect((await item.vault.backend.get(sourceId))?.value).toBe('dummy-updated-source');
  expect((await item.invoke(NATIVE_CREDENTIAL_IPC.APPLY, { changes: [{ op: 'delete', id: idFor('source_bearer', 'local-a') }] })).code).toBe('SCOPE_NOT_ALLOWED');
  expect((await item.invoke(NATIVE_CREDENTIAL_IPC.APPLY, { changes: [{ op: 'upsert', id: idFor('workspace_oauth'), credential: { value: 'dummy-workspace-new' } }] })).ok).toBe(true);
});

test('duplicate source basenames hide ambiguous rows and block only source mutations', async () => {
  const item = await fixture();
  const workspaces = [{ id: 'local-a', rootPath: join(item.directory, 'first', 'shared-name') }, { id: 'local-b', rootPath: join(item.directory, 'second', 'shared-name') }];
  item.windowState.sourceAlias = sourceCredentialWorkspaceId('local-a', workspaces);
  expect(item.windowState.sourceAlias).toBeNull();
  await item.vault.backend.set(idFor('source_oauth', 'shared-name'), { value: 'dummy-ambiguous-secret' });
  const inventory = await item.invoke(NATIVE_CREDENTIAL_IPC.LIST);
  expect(inventory.value.scope).toMatchObject({ sourceWorkspaceId: null, sourceScopeUnavailable: true });
  expect(inventory.value.entries.some((entry: any) => entry.id.type.startsWith('source_'))).toBe(false);
  expect(JSON.stringify(inventory)).not.toContain('dummy-ambiguous-secret');
  expect((await item.invoke(NATIVE_CREDENTIAL_IPC.APPLY, { changes: [{ op: 'delete', id: idFor('source_oauth', 'shared-name') }] })).code).toBe('SCOPE_NOT_ALLOWED');
  expect((await item.invoke(NATIVE_CREDENTIAL_IPC.APPLY, { changes: [{ op: 'upsert', id: idFor('llm_api_key'), credential: { value: 'dummy-working-global' } }] })).ok).toBe(true);
  expect((await item.vault.backend.get(idFor('source_oauth', 'shared-name')))?.value).toBe('dummy-ambiguous-secret');
  expect(sourceCredentialWorkspaceId('local-a', [{ id: 'local-a', rootPath: 'relative/root' }])).toBeNull();
  expect(sourceCredentialWorkspaceId('local-a', [{ id: 'local-a', rootPath: join(item.directory, 'root') }, { id: 'remote', rootPath: join(item.directory, 'other', 'root'), remoteServer: {} }])).toBe('root');
});

test('a source alias becoming ambiguous while inventory is pending discards the old inventory', async () => {
  const item = await fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const list = item.vault.listMetadata.bind(item.vault);
  const pendingList = spyOn(item.vault, 'listMetadata').mockImplementation(async () => { entered(); await gate; return list(); });
  const pending = item.invoke(NATIVE_CREDENTIAL_IPC.LIST);
  await started;
  item.windowState.sourceAlias = null;
  release();
  expect((await pending).code).toBe('SCOPE_NOT_ALLOWED');
  pendingList.mockRestore();
});
