import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialManager, getCredentialManager } from '@craft-agent/shared/credentials';
import { SessionManager } from '../SessionManager';
import { SecureStorageBackend } from '@craft-agent/shared/credentials/backends/secure-storage';
import { accountToCredentialId, credentialIdToAccount } from '@craft-agent/shared/credentials/types';
import { runSavedCredentialOperation, saveRequestedCredential } from '../saved-credentials';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tokenbird-named-credentials-'));
  directories.push(dir);
  const file = join(dir, 'credentials.enc');
  const manager = new CredentialManager();
  manager.configureBackend(new SecureStorageBackend(file));
  return { manager, file };
}

test('named credentials persist encrypted, preserve secret whitespace, and remain isolated by workspace', async () => {
  const { manager, file } = fixture();
  const request = { savedCredentialName: '工作邮箱', savedCredentialKind: 'password' as const, sourceUrl: 'https://mail.example.com/login' };
  const secret = '  dummy-password-$&\n  ';
  await saveRequestedCredential('ws-a', request, { username: ' me@example.com ', password: secret }, manager);
  const id = { type: 'saved_credential' as const, workspaceId: 'ws-a', name: request.savedCredentialName };
  expect(accountToCredentialId(credentialIdToAccount(id))).toEqual(id);
  expect(readFileSync(file).includes(Buffer.from(secret))).toBe(false);
  const reloaded = new CredentialManager();
  reloaded.configureBackend(new SecureStorageBackend(file));
  expect((await reloaded.get(id))?.value).toBe(secret);
  const inventory = await runSavedCredentialOperation('ws-a', { action: 'list' }, { manager: reloaded });
  expect(inventory).toEqual([{ name: '工作邮箱', kind: 'password', username: 'me@example.com', url: request.sourceUrl }]);
  expect(JSON.stringify(inventory)).not.toContain(secret);
  expect(await runSavedCredentialOperation('ws-b', { action: 'list' }, { manager })).toEqual([]);
  await expect(runSavedCredentialOperation('ws-b', { action: 'run', name: '工作邮箱', command: 'echo no', env: { TB_CRED_PASSWORD: 'secret' } }, { manager })).rejects.toThrow();
});

test('invalid save never overwrites an existing credential', async () => {
  const { manager } = fixture();
  const request = { savedCredentialName: 'key', savedCredentialKind: 'api-key' as const };
  await saveRequestedCredential('ws', request, { value: 'original' }, manager);
  for (const sourceUrl of ['https://user:password@example.com', 'https://example.com?key=secret', 'file:///secret']) {
    await expect(saveRequestedCredential('ws', { ...request, sourceUrl }, { value: 'replacement' }, manager)).rejects.toThrow();
  }
  await expect(saveRequestedCredential('ws', request, { value: '' }, manager)).rejects.toThrow();
  expect((await manager.get({ type: 'saved_credential', workspaceId: 'ws', name: 'key' }))?.value).toBe('original');
});

test('browser use requires the saved origin and forwards protection without returning plaintext', async () => {
  const { manager } = fixture();
  await saveRequestedCredential('ws', { savedCredentialName: 'login', sourceUrl: 'https://example.com/login' }, { username: 'user', password: 'dummy-pass' }, manager);
  const fill = mock(async () => {});
  const browser = { snapshot: mock(async () => ({ url: 'https://evil.example' })), fill } as any;
  const args = { action: 'fill' as const, name: 'login', field: 'secret' as const, ref: '@e1' };
  await expect(runSavedCredentialOperation('ws', args, { manager, browser })).rejects.toThrow();
  expect(fill).not.toHaveBeenCalled();
  browser.snapshot = mock(async () => ({ url: 'https://example.com/login' }));
  expect(await runSavedCredentialOperation('ws', args, { manager, browser })).toEqual({ filled: true, name: 'login', field: 'secret' });
  expect(fill).toHaveBeenCalledWith('@e1', 'dummy-pass', { expectedOrigin: 'https://example.com', sensitive: true });
});

test('shell receives private environment but tool result contains no output or secret', async () => {
  const { manager } = fixture();
  await saveRequestedCredential('ws', { savedCredentialName: 'key', savedCredentialKind: 'api-key' }, { value: 'dummy-key-$&' }, manager);
  const command = `node -e "process.stdout.write(process.env.TB_CRED_KEY || 'missing'); process.exit(process.env.TB_CRED_KEY === 'dummy-key-$&' ? 0 : 9)"`;
  const result = await runSavedCredentialOperation('ws', { action: 'run', name: 'key', command, env: { TB_CRED_KEY: 'secret' } }, { manager });
  expect(result).toEqual({ name: 'key', exitCode: 0, timedOut: false });
  expect(JSON.stringify(result)).not.toContain('dummy-key');
  await expect(runSavedCredentialOperation('ws', { action: 'run', name: 'key', command: 'echo no', env: { PATH: 'secret' } }, { manager })).rejects.toThrow();
});

test('session credential handoff saves by workspace UUID, resumes without activating a data source, and restores persisted forms', async () => {
  const manager: any = Object.create(SessionManager.prototype);
  const authMessage = { role: 'auth-request', authStatus: 'pending', authRequestId: 'request', authRequestType: 'credential', authSavedCredentialName: 'Work', authSavedCredentialKind: 'password', authCredentialMode: 'basic', authSourceUrl: 'https://example.com' };
  const session = { id: 'session', workspace: { id: 'uuid', rootPath: 'different-basename' }, messages: [authMessage], enabledSourceSlugs: [], tokenRefreshManager: { clearCooldown: mock(() => {}) } };
  manager.sessions = new Map([['session', session]]);
  manager.localCredentialAccessEnabled = true;
  manager.ensureMessagesLoaded = mock(async () => {});
  manager.sendEvent = mock(() => {});
  manager.persistSession = mock(() => {});
  manager.sendMessage = mock(async () => {});
  const apply = spyOn(getCredentialManager(), 'applyChanges').mockResolvedValue({ upsertedCount: 1, deletedCount: 0 });
  try {
    expect(await manager.respondToCredential('session', 'request', { type: 'credential', username: 'me', password: '  dummy-pass  ', cancelled: false })).toBe(true);
    expect(apply.mock.calls[0]?.[0]).toEqual([{ op: 'upsert', id: { type: 'saved_credential', workspaceId: 'uuid', name: 'Work' }, credential: { value: '  dummy-pass  ', username: 'me', credentialKind: 'password', credentialUrl: 'https://example.com' } }]);
    expect(session.enabledSourceSlugs).toEqual([]);
    expect(session.tokenRefreshManager.clearCooldown).not.toHaveBeenCalled();
    expect(authMessage.authStatus).toBe('completed');
    expect(JSON.stringify(manager.sendMessage.mock.calls)).not.toContain('dummy-pass');
  } finally { apply.mockRestore(); }
});

test('failed named saves keep the form pending for retry and redact storage errors', async () => {
  const manager: any = Object.create(SessionManager.prototype);
  const request = { type: 'credential', requestId: 'request', savedCredentialName: 'key', savedCredentialKind: 'api-key', sourceSlug: 'key' };
  const session = { workspace: { id: 'uuid' }, pendingAuthRequest: request };
  manager.sessions = new Map([['session', session]]);
  manager.pendingCredentialResolvers = new Map();
  manager.localCredentialAccessEnabled = true;
  const apply = spyOn(getCredentialManager(), 'applyChanges').mockRejectedValue(new Error('dummy-leaked-secret'));
  try {
    await expect(manager.respondToCredential('session', 'request', { type: 'credential', value: 'dummy-key', cancelled: false })).rejects.toThrow('Could not save credential');
    expect(session.pendingAuthRequest).toBe(request);
    expect(await manager.respondToCredential('session', 'wrong-id', { type: 'credential', value: 'dummy-key', cancelled: false })).toBe(false);
  } finally { apply.mockRestore(); }
});
