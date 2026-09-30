import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getCredentialManager, CredentialChangedError } from '../../credentials/index.ts';
import { SecureStorageBackend } from '../../credentials/backends/secure-storage.ts';
import { SourceCredentialManager } from '../credential-manager.ts';
import { TokenRefreshManager } from '../token-refresh-manager.ts';
import { isSourceUsable } from '../storage.ts';
import { CraftOAuth } from '../../auth/oauth.ts';
import type { LoadedSource } from '../types.ts';
import type { CredentialId } from '../../credentials/types.ts';
const originalFetch = globalThis.fetch;
const cleanup: Array<() => void> = [];
afterEach(() => { globalThis.fetch = originalFetch; for (const fn of cleanup.splice(0).reverse()) fn(); });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => resolve = done); return { promise, resolve }; }
function fixture(provider: string, workspaceId = 'dummy-workspace', fallback = false) {
  const root = mkdtempSync(join(tmpdir(), 'source-refresh-cas-'));
  const manager = getCredentialManager();
  const previous = { backends: (manager as any).backends, writeBackend: (manager as any).writeBackend, initialized: (manager as any).initialized, initPromise: (manager as any).initPromise };
  const backend = new SecureStorageBackend(join(root, 'credentials.enc'));
  manager.configureBackend(backend);
  cleanup.push(() => { Object.assign(manager, previous); rmSync(root, { recursive: true, force: true }); });
  const source: LoadedSource = { config: {
    id: 'dummy-source', slug: 'shared-slug', name: 'Dummy', enabled: true, isAuthenticated: true,
    provider: ['google', 'slack', 'microsoft'].includes(provider) ? provider : 'custom',
    type: provider === 'mcp' ? 'mcp' : 'api',
    ...(provider === 'mcp' ? { mcp: { transport: 'http', url: 'https://dummy.invalid/mcp', ...(fallback ? {} : { authType: 'oauth' as const }) } }
      : { api: { baseUrl: 'https://dummy.invalid/', authType: provider === 'renew' ? 'bearer' : 'oauth', ...(provider === 'renew' ? { renewEndpoint: { path: '/renew' } } : provider === 'generic' ? { oauth: { tokenUrl: 'https://dummy.invalid/token' } } : {}) } }),
  }, guide: null, folderPath: root, workspaceRootPath: root, workspaceId } as LoadedSource;
  const sources = new SourceCredentialManager();
  const id: CredentialId = fallback ? { type: 'source_bearer', workspaceId, sourceId: source.config.slug } : sources.getCredentialId(source);
  const credential = { value: 'dummy-old', refreshToken: 'dummy-old-refresh', clientId: 'dummy-client', clientSecret: 'dummy-client-secret', expiresAt: 1 };
  const marked = spyOn(sources, 'markSourceNeedsReauth').mockImplementation(() => {}); cleanup.push(() => marked.mockRestore());
  return { manager, backend, source, sources, id, credential, marked };
}

for (const provider of ['renew', 'google', 'slack', 'microsoft', 'generic', 'mcp']) {
  describe(`${provider} refresh CAS`, () => {
    for (const mutation of ['replace', 'delete', 'failed-old-grant'] as const) test(`does not overwrite or reauthenticate after ${mutation}`, async () => {
      const f = fixture(provider); await f.backend.set(f.id, f.credential);
      const entered = gate(), release = gate(); let requests = 0;
      const remote = async () => { requests++; entered.resolve(); await release.promise; if (mutation === 'failed-old-grant') throw new Error('invalid_grant dummy-provider-secret'); return { accessToken: 'dummy-refreshed', refreshToken: 'dummy-refreshed-refresh', tokenType: 'Bearer', expiresAt: Date.now() + 3600000 }; };
      if (provider === 'mcp') { const mock = spyOn(CraftOAuth.prototype, 'refreshAccessToken').mockImplementation(remote); cleanup.push(() => mock.mockRestore()); }
      else globalThis.fetch = (async () => { const value = await remote(); return Response.json({ ok: true, access_token: value.accessToken, refresh_token: value.refreshToken, expires_in: 3600, token_type: 'Bearer' }); }) as unknown as typeof fetch;
      const pending = f.sources.refresh(f.source).then(value => value, error => error);
      await entered.promise;
      await f.backend.applyChanges(mutation === 'delete' ? [{ op: 'delete', id: f.id }] : [{ op: 'upsert', id: f.id, credential: { value: 'dummy-new-user', refreshToken: 'dummy-new-user-refresh' } }]);
      release.resolve(); const outcome = await pending;
      expect(outcome).toBeInstanceOf(CredentialChangedError);
      expect(String(outcome)).not.toContain('dummy-provider-secret');
      expect((await f.backend.get(f.id))?.value).toBe(mutation === 'delete' ? undefined : 'dummy-new-user');
      expect(f.marked).not.toHaveBeenCalled(); expect(requests).toBe(1);
    });
  });
}

test('MCP legacy fallback refresh writes the actual bearer slot and never creates an OAuth alias', async () => {
  const f = fixture('mcp', 'dummy-workspace', true); await f.backend.set(f.id, f.credential);
  const remote = spyOn(CraftOAuth.prototype, 'refreshAccessToken').mockResolvedValue({ accessToken: 'dummy-updated', refreshToken: 'dummy-rotated', tokenType: 'Bearer', expiresAt: Date.now() + 3600000 }); cleanup.push(() => remote.mockRestore());
  expect(await f.sources.refresh(f.source)).toBe('dummy-updated');
  expect((await f.backend.get(f.id))?.value).toBe('dummy-updated');
  expect(await f.backend.get({ ...f.id, type: 'source_oauth' })).toBeNull();
});

test('same source slug in different workspaces cannot share a refresh promise/token', async () => {
  const f = fixture('renew', 'workspace-one');
  const other = { ...f.source, workspaceId: 'workspace-two' };
  const otherId = f.sources.getCredentialId(other);
  await f.backend.setMany([{ id: f.id, credential: f.credential }, { id: otherId, credential: { ...f.credential, value: 'dummy-other' } }]);
  const release = gate(); let requests = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => { requests++; const token = new Headers(init?.headers).get('Authorization')!; await release.promise; return Response.json({ access_token: token.endsWith('dummy-other') ? 'dummy-other-new' : 'dummy-first-new', expires_in: 3600 }); }) as unknown as typeof fetch;
  const first = f.sources.refresh(f.source), second = f.sources.refresh(other);
  for (let n = 0; n < 30 && requests < 2; n++) await Bun.sleep(1);
  release.resolve(); expect(await first).toBe('dummy-first-new'); expect(await second).toBe('dummy-other-new'); expect(requests).toBe(2);
});

test('TokenRefreshManager treats stale refresh as obsolete without marking new credentials or cooldown', async () => {
  const f = fixture('renew'); await f.backend.set(f.id, f.credential);
  const entered = gate(), release = gate();
  globalThis.fetch = (async () => { entered.resolve(); await release.promise; return Response.json({ access_token: 'dummy-stale', expires_in: 3600 }); }) as unknown as typeof fetch;
  const refresher = new TokenRefreshManager(f.sources); const pending = refresher.ensureFreshToken(f.source);
  await entered.promise; await f.backend.applyChanges([{ op: 'upsert', id: f.id, credential: { value: 'dummy-user', expiresAt: Date.now() + 3600000 } }]); release.resolve();
  expect((await pending).success).toBe(false); expect(f.marked).not.toHaveBeenCalled(); expect(refresher.isInCooldown(f.source.config.slug)).toBe(false);
  expect(isSourceUsable(f.source)).toBe(true);
});

test('same basename across distinct normalized roots does not share the in-memory refresh promise', async () => {
  const f = fixture('renew', 'same-basename'); const release = gate(); const roots: string[] = [];
  const doRefresh = spyOn(f.sources as any, 'doRefresh').mockImplementation(async (source: LoadedSource) => { roots.push(source.workspaceRootPath); await release.promise; return source.workspaceRootPath.includes('/first/') ? 'dummy-first-token' : 'dummy-second-token'; }); cleanup.push(() => doRefresh.mockRestore());
  const first = f.sources.refresh({ ...f.source, workspaceRootPath: '/dummy/first/same-basename' });
  const second = f.sources.refresh({ ...f.source, workspaceRootPath: '/dummy/second/same-basename' });
  expect(roots).toHaveLength(2); release.resolve(); expect(await first).toBe('dummy-first-token'); expect(await second).toBe('dummy-second-token');
});

test('temporary native vault failure is not labeled as source reauthentication or cooldown', async () => {
  const f = fixture('renew'); await f.backend.set(f.id, f.credential);
  const { CredentialVaultError } = await import('../../credentials/backends/vault-protection.ts');
  const refreshing = spyOn(f.sources, 'refresh').mockRejectedValue(new CredentialVaultError('OS_STORAGE_UNAVAILABLE')); cleanup.push(() => refreshing.mockRestore());
  const refresher = new TokenRefreshManager(f.sources), result = await refresher.ensureFreshToken(f.source);
  expect(result.success).toBe(false); expect(result.reason).toContain('operating system'); expect(f.marked).not.toHaveBeenCalled(); expect(refresher.isInCooldown(f.source.config.slug)).toBe(false); expect(isSourceUsable(f.source)).toBe(true);
});
