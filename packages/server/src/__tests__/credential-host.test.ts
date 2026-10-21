import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialManager, getCredentialManager } from '@tokenbird/shared/credentials';
import { SecureStorageBackend } from '@tokenbird/shared/credentials/backends/secure-storage';
import { RPC_CHANNELS } from '@tokenbird/shared/protocol';
import { registerCredentialHandlers } from '@tokenbird/server-core/handlers/rpc/credentials';
import { handleSavedCredentials, type SavedCredentialArgs } from '../../../session-tools-core/src/handlers/saved-credentials';
import type { AuthRequest } from '@tokenbird/session-tools-core';
import { runSavedCredentialOperation } from '../../../server-core/src/sessions/saved-credentials';
import { createHeadlessCredentialHost } from '../credential-host';
import { createHeadlessSessionManager } from '../session-manager';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tokenbird-headless-vault-'));
  directories.push(root);
  const file = join(root, 'credentials.enc');
  const backend = new SecureStorageBackend(file);
  const manager = new CredentialManager();
  const notifyStoredCredentialChanges = mock(async () => ({ sessionIdsNeedingRestart: [] }));
  const host = createHeadlessCredentialHost({ notifyStoredCredentialChanges, reloadMcpServers: mock(async () => ({ failures: [] })) } as any, {
    backend, manager, workspaces: () => [
      { id: 'ws-a', slug: 'a', name: 'A', rootPath: join(root, 'a'), createdAt: 1 },
      { id: 'ws-b', slug: 'b', name: 'B', rootPath: join(root, 'b'), createdAt: 1 },
    ],
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  registerCredentialHandlers({ handle: (channel: string, fn: any) => handlers.set(channel, fn) } as any, { remoteCredentialHost: host } as any);
  const ctx = { clientId: 'client', workspaceId: 'ws-a', authenticatedBy: 'bearer' };
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(ctx, ...args);
  const authorize = async () => {
    await invoke(RPC_CHANNELS.credentials.REQUEST_ACCESS);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await invoke(RPC_CHANNELS.credentials.ACCESS)).state).toBe('approved');
  };
  return { root, file, backend, manager, host, ctx, handlers, invoke, authorize, notifyStoredCredentialChanges };
}

test('authenticated headless connections use the vault immediately with workspace isolation', async () => {
  const f = fixture();
  expect(await f.invoke(RPC_CHANNELS.credentials.ACCESS)).toEqual({ state: 'approved' });
  expect((await f.invoke(RPC_CHANNELS.credentials.LIST)).ok).toBe(true);
  const id = { type: 'saved_credential' as const, workspaceId: 'ws-a', name: 'binance-operations' };
  const secret = 'dummy-binance-secret';
  const create = await f.invoke(RPC_CHANNELS.credentials.APPLY, { changes: [{ op: 'upsert', id, credential: { value: secret, credentialKind: 'api-key' } }] });
  expect(create.ok).toBe(true);
  expect(create.value.warnings).toBeUndefined();
  expect(readFileSync(f.file).includes(Buffer.from(secret))).toBe(false);
  const list = await f.invoke(RPC_CHANNELS.credentials.LIST);
  expect(list.value.entries).toEqual([{ id, credentialKind: 'api-key', hasValue: true, presentFields: ['credentialKind', 'value'] }]);
  expect(JSON.stringify(list)).not.toContain(secret);
  expect(list.value.status).toMatchObject({ canApply: true, canList: true, protection: 'legacy-machine', canMigrate: false });
  const reloaded = new CredentialManager();
  reloaded.configureBackend(new SecureStorageBackend(f.file));
  expect((await reloaded.get(id))?.value).toBe(secret);
  expect((await f.invoke(RPC_CHANNELS.credentials.APPLY, { changes: [{ op: 'upsert', id, credential: { value: 'updated-secret' } }] })).ok).toBe(true);
  expect((await f.manager.get(id))?.credentialKind).toBe('api-key');
  expect((await f.handlers.get(RPC_CHANNELS.credentials.LIST)!({ ...f.ctx, clientId: 'other', authenticatedBy: null })).ok).toBe(false);
  expect((await f.invoke(RPC_CHANNELS.credentials.APPLY, { changes: [{ op: 'delete', id: { ...id, workspaceId: 'ws-b' } }] })).code).toBe('SCOPE_NOT_ALLOWED');
  expect(await f.invoke(RPC_CHANNELS.credentials.APPLY, { changes: [{ op: 'delete', id }] })).toMatchObject({ ok: true });
  expect((await f.invoke(RPC_CHANNELS.credentials.LIST)).value.entries).toEqual([]);
  expect(f.notifyStoredCredentialChanges).toHaveBeenCalled();
});

test('headless approval requires server-verified authentication, and unusable vaults are preserved', async () => {
  const f = fixture();
  expect(await f.host.approve({ clientId: 'client', workspaceId: 'ws-a', expiresAt: Date.now() + 10000 })).toBe(false);
  expect(await f.host.approve({ clientId: 'client', workspaceId: 'ws-a', authenticatedBy: 'cookie', expiresAt: Date.now() + 10000 })).toBe(true);
  expect(f.host.scope('unknown')).toBeNull();
  writeFileSync(f.file, 'corrupt-vault-preserve-this');
  expect(await f.host.status()).toMatchObject({ state: 'error', canList: false, canApply: false });
  await f.authorize();
  expect((await f.invoke(RPC_CHANNELS.credentials.LIST)).ok).toBe(false);
  const id = { type: 'saved_credential', workspaceId: 'ws-a', name: 'key' };
  expect((await f.invoke(RPC_CHANNELS.credentials.APPLY, { changes: [{ op: 'upsert', id, credential: { value: 'dummy' } }] })).ok).toBe(false);
  expect(readFileSync(f.file, 'utf8')).toBe('corrupt-vault-preserve-this');
});

test('default vault access survives reconnects and time without admitting unverified or closed connections', async () => {
  const f = fixture();
  const invoke = (ctx: any, channel: string, ...args: unknown[]) => f.handlers.get(channel)!(ctx, ...args);
  for (const authenticatedBy of ['bearer', 'cookie']) {
    const reconnected = { ...f.ctx, clientId: 'reconnected-' + authenticatedBy, authenticatedBy };
    expect(await invoke(reconnected, RPC_CHANNELS.credentials.ACCESS)).toEqual({ state: 'approved' });
    expect(await invoke(reconnected, RPC_CHANNELS.credentials.REQUEST_ACCESS)).toEqual({ state: 'approved' });
    expect((await invoke(reconnected, RPC_CHANNELS.credentials.LIST)).ok).toBe(true);
  }
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
  try {
    expect(await f.invoke(RPC_CHANNELS.credentials.ACCESS)).toEqual({ state: 'approved' });
    expect((await f.invoke(RPC_CHANNELS.credentials.LIST)).ok).toBe(true);
  } finally { clock.mockRestore(); }
  const cancelled = new AbortController(); cancelled.abort();
  for (const ctx of [
    { ...f.ctx, authenticatedBy: undefined },
    { ...f.ctx, authenticatedBy: null },
    { ...f.ctx, workspaceId: 'missing' },
    { ...f.ctx, signal: cancelled.signal },
  ]) {
    expect((await invoke(ctx, RPC_CHANNELS.credentials.ACCESS)).state).not.toBe('approved');
    for (const channel of [RPC_CHANNELS.credentials.STATUS, RPC_CHANNELS.credentials.LIST]) {
      expect((await invoke(ctx, channel)).ok).toBe(false);
    }
    expect((await invoke(ctx, RPC_CHANNELS.credentials.APPLY, { changes: [{ op: 'upsert', id: { type: 'saved_credential', workspaceId: 'ws-a', name: 'blocked' }, credential: { value: 'dummy-secret' } }] })).ok).toBe(false);
  }
  expect(await f.manager.get({ type: 'saved_credential', workspaceId: 'ws-a', name: 'blocked' })).toBeNull();
});

test('standalone session requests secure input, saves on the host and resumes without returning a secret', async () => {
  const f = fixture();
  const sm: any = createHeadlessSessionManager();
  const session: any = { id: 'session', workspace: { id: 'ws-a', rootPath: join(f.root, 'a') }, messages: [], enabledSourceSlugs: [] };
  sm.sessions.set('session', session);
  sm.ensureMessagesLoaded = mock(async () => {});
  sm.sendEvent = mock(() => {});
  sm.persistSession = mock(() => {});
  sm.sendMessage = mock(async () => {});
  const result = await handleSavedCredentials({ sessionId: 'session',
    savedCredentialsFn: (args: SavedCredentialArgs) => runSavedCredentialOperation('ws-a', args, { manager: f.manager }),
    callbacks: { onAuthRequest: (request: AuthRequest) => { session.pendingAuthRequest = request; } },
  } as any, { action: 'request', name: 'binance-operations', kind: 'api-key' });
  expect(result.isError).not.toBe(true);
  const request = session.pendingAuthRequest;
  session.messages.push({ role: 'auth-request', authStatus: 'pending', authRequestId: request.requestId });
  const apply = spyOn(getCredentialManager(), 'applyChanges').mockImplementation(changes => f.manager.applyChanges(changes));
  try {
    expect(await sm.respondToCredential('session', request.requestId, { type: 'credential', value: 'dummy-secret', cancelled: false })).toBe(true);
    expect((await f.manager.get({ type: 'saved_credential', workspaceId: 'ws-a', name: 'binance-operations' }))?.value).toBe('dummy-secret');
    expect(session.messages[0].authStatus).toBe('completed');
    expect(session.enabledSourceSlugs).toEqual([]);
    expect(sm.sendMessage).toHaveBeenCalled();
    expect(JSON.stringify(sm.sendEvent.mock.calls)).not.toContain('dummy-secret');
    expect(readFileSync(f.file).includes(Buffer.from('dummy-secret'))).toBe(false);
  } finally { apply.mockRestore(); }
});
