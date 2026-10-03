import { afterEach, describe, expect, jest, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getCredentialManager, CredentialChangedError } from '../../credentials/index.ts';
import { SecureStorageBackend } from '../../credentials/backends/secure-storage.ts';
import { PiAgent } from '../pi-agent.ts';
import { NativeCodexAgent } from '../native-codex-agent.ts';
import { performTokenRefresh } from '../../auth/state.ts';
const originalFetch = globalThis.fetch;
const cleanups: Array<() => void> = [];
afterEach(() => { jest.useRealTimers(); globalThis.fetch = originalFetch; for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => resolve = done); return { promise, resolve }; }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'llm-refresh-cas-'));
  const manager = getCredentialManager();
  const old = { backends: (manager as any).backends, writeBackend: (manager as any).writeBackend, initialized: (manager as any).initialized, initPromise: (manager as any).initPromise };
  const backend = new SecureStorageBackend(join(root, 'credentials.enc')); manager.configureBackend(backend);
  cleanups.push(() => { Object.assign(manager, old); rmSync(root, { recursive: true, force: true }); });
  const id = { type: 'llm_oauth' as const, connectionSlug: 'dummy-provider' };
  const credential = { value: 'dummy-old', refreshToken: 'dummy-old-refresh', expiresAt: 1 };
  const config = { provider: 'pi', authType: 'oauth', connectionSlug: id.connectionSlug, workspace: { id: 'dummy', name: 'Dummy', rootPath: root }, session: { id: 'dummy-session', workspaceRootPath: root, createdAt: Date.now(), lastUsedAt: Date.now() }, isHeadless: true } as any;
  return { root, manager, backend, id, credential, config };
}
function jwt() { return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'dummy-account' } })).toString('base64url')}.`; }
function remoteGate(failure = false) {
  const entered = gate(), release = gate(); let requests = 0;
  globalThis.fetch = (async () => { requests++; entered.resolve(); await release.promise; return failure
    ? Response.json({ error: 'invalid_grant', error_description: 'invalid_grant dummy-secret-echo' }, { status: 401 })
    : Response.json({ access_token: jwt(), id_token: 'dummy-id', refresh_token: 'dummy-rotated', expires_in: 3600, token: 'dummy-copilot-token', expires_at: Math.floor(Date.now() / 1000) + 3600 }); }) as unknown as typeof fetch;
  return { entered, release, requests: () => requests };
}
for (const provider of ['chatgpt', 'copilot']) for (const mutation of ['replace', 'delete', 'failed-old-grant'] as const) test(`Pi ${provider} refresh preserves newer ${mutation}`, async () => {
  const f = fixture(); await f.backend.set(f.id, f.credential);
  const agent: any = new PiAgent({ ...f.config, runtime: { piAuthProvider: provider === 'copilot' ? 'github-copilot' : 'openai-codex' } }); cleanups.push(() => agent.destroy());
  const remote = remoteGate(mutation === 'failed-old-grant');
  const pending = agent.refreshAndPushTokens().then(() => null, (error: unknown) => error);
  await remote.entered.promise;
  await f.backend.applyChanges(mutation === 'delete' ? [{ op: 'delete', id: f.id }] : [{ op: 'upsert', id: f.id, credential: { value: 'dummy-user', refreshToken: 'dummy-user-refresh' } }]);
  remote.release.resolve(); const error = await pending;
  expect(error).toBeInstanceOf(CredentialChangedError); expect(String(error)).not.toContain('dummy-secret-echo');
  expect((await f.backend.get(f.id))?.value).toBe(mutation === 'delete' ? undefined : 'dummy-user'); expect(remote.requests()).toBe(1);
});
for (const provider of ['chatgpt', 'copilot', 'tokennest']) for (const outcome of ['timeout', 'rejected', 'replaced'] as const) test(`Pi ${provider} saved refresh retains the ${outcome} runtime outcome`, async () => {
  const f = fixture(); await f.backend.set(f.id, f.credential);
  const agent: any = new PiAgent({ ...f.config, runtime: {
    piAuthProvider: provider === 'copilot' ? 'github-copilot' : 'openai-codex',
    ...(provider === 'tokennest' ? { oauthProvider: 'tokennest' } : {}),
  } });
  const sent: any[] = [];
  agent.subprocess = { kill() { return true; } };
  agent.send = (command: any) => sent.push(command);
  cleanups.push(() => agent.destroy());
  jest.useFakeTimers();
  const remote = remoteGate();
  const pending = agent.refreshAndPushTokens().then(() => null, (error: unknown) => error);
  await remote.entered.promise; remote.release.resolve();
  for (let n = 0; n < 100 && !sent.length; n++) await Promise.resolve();
  expect(sent).toHaveLength(1); expect(sent[0].type).toBe('token_update');
  const saved = await f.backend.get(f.id);
  expect(saved?.value).not.toBe(f.credential.value);
  if (outcome === 'timeout') jest.advanceTimersByTime(15001);
  else {
    if (outcome === 'replaced') await f.backend.set(f.id, { value: 'dummy-user', refreshToken: 'dummy-user-refresh' });
    agent.handleLine(JSON.stringify({ type: 'token_update_result', id: sent[0].id, success: outcome === 'replaced', message: 'dummy-secret-echo' }));
  }
  const error = await pending;
  if (outcome === 'replaced') expect(error).toBeInstanceOf(CredentialChangedError);
  else {
    expect(error).not.toBeInstanceOf(CredentialChangedError);
    expect(String(error)).toContain(outcome === 'timeout' ? 'not acknowledged' : 'Credential update failed in the local runtime');
  }
  expect(String(error)).not.toContain('dummy-secret-echo');
  expect((await f.backend.get(f.id))?.value).toBe(outcome === 'replaced' ? 'dummy-user' : saved?.value);
  expect(remote.requests()).toBe(1); expect(agent.pendingAuthUpdates.size).toBe(0);
});
for (const mutation of ['replace', 'delete', 'failed-old-grant'] as const) test(`native Codex refresh returns safe changed outcome after ${mutation}`, async () => {
  const f = fixture(); await f.backend.set(f.id, f.credential);
  const agent: any = new NativeCodexAgent(f.config, { path: 'codex', source: 'PATH', version: '0.154.0', testedProtocol: true }); cleanups.push(() => agent.destroy());
  const replies: any[] = [], errors: any[] = [];
  const client = { respond: async (...args: any[]) => replies.push(args), respondError: async (...args: any[]) => errors.push(args) };
  const remote = remoteGate(mutation === 'failed-old-grant'); const pending = agent.handleTokenRefresh(client, { id: 'dummy-request' });
  await remote.entered.promise;
  await f.backend.applyChanges(mutation === 'delete' ? [{ op: 'delete', id: f.id }] : [{ op: 'upsert', id: f.id, credential: { value: 'dummy-user', refreshToken: 'dummy-user-refresh' } }]);
  remote.release.resolve(); await pending;
  expect(replies).toHaveLength(0); expect(errors).toHaveLength(1); expect(errors[0][1]).toBe(new CredentialChangedError().message); expect(JSON.stringify(errors)).not.toContain('dummy-secret-echo');
  expect((await f.backend.get(f.id))?.value).toBe(mutation === 'delete' ? undefined : 'dummy-user'); expect(remote.requests()).toBe(1);
});
for (const changedSlot of ['global', 'connection']) for (const mutation of ['replace', 'delete', 'failed-old-grant'] as const) test(`Claude dual refresh/cleanup is atomic after ${changedSlot} ${mutation}`, async () => {
  const f = fixture(); const globalId = { type: 'claude_oauth' as const };
  await f.backend.setMany([{ id: globalId, credential: f.credential }, { id: f.id, credential: f.credential }]);
  const target = changedSlot === 'global' ? globalId : f.id;
  const remote = remoteGate(mutation === 'failed-old-grant'); const pending = performTokenRefresh(f.manager, f.credential.refreshToken, 'native', f.id.connectionSlug).then(() => null, error => error);
  await remote.entered.promise;
  await f.backend.applyChanges(mutation === 'delete' ? [{ op: 'delete', id: target }] : [{ op: 'upsert', id: target, credential: { value: 'dummy-user', refreshToken: 'dummy-user-refresh' } }]);
  remote.release.resolve(); expect(await pending).toBeInstanceOf(CredentialChangedError);
  expect((await f.backend.get(target))?.value).toBe(mutation === 'delete' ? undefined : 'dummy-user');
  expect((await f.backend.get(changedSlot === 'global' ? f.id : globalId))?.value).toBe('dummy-old'); expect(remote.requests()).toBe(1);
});
test('Claude rejects an already-obsolete supplied refresh token before network I/O', async () => {
  const f = fixture(); await f.backend.set({ type: 'claude_oauth' }, f.credential); const remote = remoteGate();
  await expect(performTokenRefresh(f.manager, 'dummy-obsolete-refresh', 'native', f.id.connectionSlug)).rejects.toBeInstanceOf(CredentialChangedError);
  expect(remote.requests()).toBe(0);
});
test('genuine Claude invalid grant clears only its observed two OAuth slots, not other auth types', async () => {
  const f = fixture(); const globalId = { type: 'claude_oauth' as const }, apiId = { type: 'llm_api_key' as const, connectionSlug: f.id.connectionSlug };
  await f.backend.setMany([{ id: globalId, credential: f.credential }, { id: f.id, credential: f.credential }, { id: apiId, credential: { value: 'dummy-unrelated' } }]);
  const remote = remoteGate(true); const pending = performTokenRefresh(f.manager, f.credential.refreshToken, 'native', f.id.connectionSlug); await remote.entered.promise; remote.release.resolve();
  expect((await pending).accessToken).toBeNull(); expect(await f.backend.get(globalId)).toBeNull(); expect(await f.backend.get(f.id)).toBeNull(); expect((await f.backend.get(apiId))?.value).toBe('dummy-unrelated');
});
