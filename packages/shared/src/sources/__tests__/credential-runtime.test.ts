import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getCredentialManager } from '../../credentials/index.ts';
import { SecureStorageBackend } from '../../credentials/backends/secure-storage.ts';
import { loadSource, loadSourceConfig, saveSourceConfig, isSourceUsable } from '../storage.ts';
import { SourceCredentialManager } from '../credential-manager.ts';
import { SourceServerBuilder } from '../server-builder.ts';
import { reconcileSourceCredentialChanges } from '../credential-runtime.ts';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(authType: 'bearer' | 'none' = 'bearer') {
  const directory = mkdtempSync(join(tmpdir(), 'credential-runtime-source-')), root = join(directory, 'actual-directory-slug'); mkdirSync(root);
  const manager = getCredentialManager(), previous = { backends: (manager as any).backends, writeBackend: (manager as any).writeBackend, initialized: (manager as any).initialized, initPromise: (manager as any).initPromise };
  const backend = new SecureStorageBackend(join(directory, 'credentials.enc')); manager.configureBackend(backend);
  cleanup.push(() => { Object.assign(manager, previous); rmSync(directory, { recursive: true, force: true }); });
  saveSourceConfig(root, { id: 'dummy', slug: 'dummy-source', name: 'Dummy', provider: 'custom', type: 'mcp', enabled: true, isAuthenticated: false, connectionStatus: 'needs_auth', mcp: { transport: 'http', url: 'https://dummy.invalid/mcp', authType } });
  const source = loadSource(root, 'dummy-source')!, sources = new SourceCredentialManager(), id = sources.getCredentialId(source);
  const resolve = (alias: string) => alias === 'actual-directory-slug' ? { id: 'registered-workspace-uuid', rootPath: root } : null;
  return { backend, root, source, sources, id, resolve };
}
test('real basename-based source credentials heal needs_auth and return registered IDs for deferred reload', async () => {
  const f = fixture(); expect(f.id.workspaceId).toBe('actual-directory-slug');
  await f.backend.applyChanges([{ op: 'upsert', id: f.id, credential: { value: 'dummy-token' } }]);
  expect(isSourceUsable(loadSource(f.root, f.source.config.slug)!)).toBe(false);
  const result = await reconcileSourceCredentialChanges([{ op: 'upsert', id: f.id }], f.resolve);
  expect(result).toEqual({ workspaceIds: ['registered-workspace-uuid'], failed: false });
  const source = loadSource(f.root, f.source.config.slug)!; expect(isSourceUsable(source)).toBe(true);
  const token = await f.sources.getToken(source); const built = await new SourceServerBuilder().buildAll([{ source, token, credential: token }]);
  expect((built.mcpServers['dummy-source'] as any).headers.Authorization).toBe('Bearer dummy-token');
});
test('deleted current source credential marks only the relevant source unavailable for its next turn', async () => {
  const f = fixture(); await f.backend.set(f.id, { value: 'dummy-token' });
  await reconcileSourceCredentialChanges([{ op: 'upsert', id: f.id }], f.resolve);
  await f.backend.applyChanges([{ op: 'delete', id: f.id }]);
  expect((await reconcileSourceCredentialChanges([{ op: 'delete', id: f.id }], f.resolve)).failed).toBe(false);
  expect(loadSourceConfig(f.root, f.source.config.slug)).toMatchObject({ isAuthenticated: false, connectionStatus: 'needs_auth' });
});
test('inactive source credential types do not change active bearer auth status', async () => {
  const f = fixture(); await f.backend.set(f.id, { value: 'dummy-token' });
  await reconcileSourceCredentialChanges([{ op: 'upsert', id: f.id }], f.resolve);
  const inactive = { ...f.id, type: 'source_oauth' as const }; await f.backend.set(inactive, { value: 'dummy-inactive' });
  expect(await reconcileSourceCredentialChanges([{ op: 'upsert', id: inactive }], f.resolve)).toEqual({ workspaceIds: [], failed: false });
  expect(loadSourceConfig(f.root, f.source.config.slug)?.isAuthenticated).toBe(true);
});
test('authType none remains public and does not become authenticated by an unrelated saved slot', async () => {
  const f = fixture('none'); const staleId = { ...f.id, type: 'source_bearer' as const }; await f.backend.set(staleId, { value: 'dummy-stale' });
  const before = loadSourceConfig(f.root, f.source.config.slug);
  expect(await reconcileSourceCredentialChanges([{ op: 'upsert', id: staleId }], f.resolve)).toEqual({ workspaceIds: [], failed: false });
  expect(loadSourceConfig(f.root, f.source.config.slug)).toEqual(before);
});
test('unresolvable/ambiguous source namespace reports post-commit warning without deleting the saved credential', async () => {
  const f = fixture(); await f.backend.set(f.id, { value: 'dummy-token' });
  expect(await reconcileSourceCredentialChanges([{ op: 'upsert', id: f.id }], () => null)).toEqual({ workspaceIds: [], failed: true });
  expect((await f.backend.get(f.id))?.value).toBe('dummy-token'); expect(loadSourceConfig(f.root, f.source.config.slug)?.isAuthenticated).toBe(false);
});
