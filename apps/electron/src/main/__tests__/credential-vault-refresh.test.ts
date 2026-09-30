import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CredentialManager, CredentialChangedError } from '@craft-agent/shared/credentials';
import { SecureStorageBackend } from '@craft-agent/shared/credentials/backends/secure-storage';
import { checkTokenNestAuthorization, getValidTokenNestCredentials, TOKENNEST_OAUTH_CONFIG } from '@craft-agent/shared/auth/tokennest-oauth';
import { configureElectronCredentialVault } from '../credential-vault';
import { nativeVaultFixture } from './fixtures/native-vault-harness';

const originalFetch = globalThis.fetch;
const cleanups: Array<() => void> = [];
afterEach(() => { globalThis.fetch = originalFetch; for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const id = { type: 'llm_oauth' as const, connectionSlug: 'dummy-tokennest-cas' };
const old = { value: 'dummy-old-access', refreshToken: 'dummy-old-refresh', expiresAt: 1, scope: 'dummy-original-scope' };
async function fixture(native: boolean) {
  const item = nativeVaultFixture();
  cleanups.push(item.cleanup);
  await new SecureStorageBackend(item.filePath).set(id, old);
  const manager = new CredentialManager();
  const vault = configureElectronCredentialVault({ ...item, platform: 'linux', manager });
  if (native) await vault.migrate();
  return { ...item, manager, vault };
}

for (const native of [false, true]) {
  for (const change of ['replace', 'delete', 'metadata', 'delete-recreate-same-value'] as const) {
    test(`${native ? 'native' : 'legacy'} actual TokenNest refresh cannot overwrite ${change}`, async () => {
      const item = await fixture(native);
      const entered = gate(), release = gate();
      let requests = 0;
      globalThis.fetch = (async () => {
        requests++;
        entered.resolve();
        await release.promise;
        return Response.json({ access_token: 'dummy-stale-network-access', refresh_token: 'dummy-stale-network-refresh', expires_in: 3600 });
      }) as unknown as typeof fetch;
      const refreshing = getValidTokenNestCredentials(id.connectionSlug, item.manager).then(value => ({ value }), error => ({ error }));
      try {
        await entered.promise;
        if (change === 'delete' || change === 'delete-recreate-same-value') await item.vault.apply([{ op: 'delete', id }]);
        if (change === 'replace') await item.vault.apply([{ op: 'upsert', id, credential: { value: 'dummy-user-new-access', refreshToken: 'dummy-user-new-refresh' } }]);
        if (change === 'metadata') await item.vault.apply([{ op: 'upsert', id, credential: { scope: 'dummy-user-new-scope' } }]);
        if (change === 'delete-recreate-same-value') await item.manager.set(id, old);
        const committed = await item.manager.get(id);
        const bytes = readFileSync(item.filePath);
        release.resolve();
        const outcome = await refreshing;
        expect('error' in outcome && outcome.error instanceof CredentialChangedError).toBe(true);
        expect(await item.manager.get(id)).toEqual(committed);
        expect(readFileSync(item.filePath)).toEqual(bytes);
        expect(requests).toBe(1);
      } finally { release.resolve(); await refreshing; }
    });
  }
  test(`${native ? 'native' : 'legacy'} late provider invalid_grant does not label a newer user credential expired`, async () => {
    const item = await fixture(native);
    await item.manager.set(id, { ...old, scope: TOKENNEST_OAUTH_CONFIG.scopes });
    const entered = gate(), release = gate();
    let requests = 0;
    globalThis.fetch = (async () => { requests++; entered.resolve(); await release.promise; return Response.json({ error: 'invalid_grant' }, { status: 400 }); }) as unknown as typeof fetch;
    const checking = checkTokenNestAuthorization(id.connectionSlug, item.manager);
    try {
      await entered.promise;
      await item.vault.apply([{ op: 'upsert', id, credential: { value: 'dummy-new-user-access', refreshToken: 'dummy-new-user-refresh' } }]);
      release.resolve();
      expect(await checking).toBeNull();
      expect((await item.manager.get(id))?.value).toBe('dummy-new-user-access');
      expect(requests).toBe(1);
    } finally { release.resolve(); await checking; }
  });
}

test('normal TokenNest refresh commits once and optional format migration does not invalidate its snapshot', async () => {
  const item = await fixture(false);
  const entered = gate(), release = gate();
  let requests = 0;
  globalThis.fetch = (async () => { requests++; entered.resolve(); await release.promise; return Response.json({ access_token: 'dummy-fresh', refresh_token: 'dummy-rotated', expires_in: 3600 }); }) as unknown as typeof fetch;
  const first = getValidTokenNestCredentials(id.connectionSlug, item.manager);
  const second = getValidTokenNestCredentials(id.connectionSlug, item.manager);
  try {
    await entered.promise;
    await item.vault.migrate();
    release.resolve();
    expect(await first).toEqual(await second);
    expect((await item.manager.get(id))?.value).toBe('dummy-fresh');
    expect((await item.manager.get(id))?.refreshToken).toBe('dummy-rotated');
    expect(requests).toBe(1);
  } finally { release.resolve(); await Promise.allSettled([first, second]); }
});

test('multi-entry CAS is atomic, deletion-safe and independent of unrelated writes', async () => {
  const item = await fixture(true);
  const secondId = { type: 'claude_oauth' as const };
  await item.manager.set(secondId, { value: 'dummy-second' });
  const first = await item.manager.getSnapshot(id);
  const second = await item.manager.getSnapshot(secondId);
  await item.manager.set(secondId, { value: 'dummy-user-replacement' });
  const bytes = readFileSync(item.filePath);
  expect(await item.manager.compareAndSetMany([
    { id, expectedRevision: first.revision, credential: { value: 'must-not-save' } },
    { id: secondId, expectedRevision: second.revision, credential: null },
  ])).toBe(false);
  expect(readFileSync(item.filePath)).toEqual(bytes);
  expect((await item.manager.get(id))?.value).toBe(old.value);
  expect(await item.manager.compareAndSetMany([{ id, expectedRevision: first.revision, credential: { ...old, value: 'dummy-fresh' } }])).toBe(true);
  expect((await item.manager.get(id))?.value).toBe('dummy-fresh');
  expect((await item.manager.get(secondId))?.value).toBe('dummy-user-replacement');
});

test('revision tombstones are bounded and pruning cannot revive a stale absence or existing snapshot', async () => {
  const item = await fixture(false);
  const absentId = { type: 'llm_oauth' as const, connectionSlug: 'dummy-absent' };
  const absent = await item.manager.getSnapshot(absentId);
  const live = await item.manager.getSnapshot(id);
  const temporary = Array.from({ length: 350 }, (_, index) => ({ type: 'llm_api_key' as const, connectionSlug: `dummy-prune-${index}` }));
  await item.manager.setMany(temporary.map(id => ({ id, credential: { value: 'dummy-value' } })));
  await item.vault.apply(temporary.map(id => ({ op: 'delete' as const, id })));
  const store = (item.vault.backend as any).loadStoreSync();
  expect(Object.keys(store.entryRevisions).filter(key => !(key in store.credentials)).length).toBeLessThanOrEqual(256);
  expect(await item.manager.compareAndSetMany([{ id: absentId, expectedRevision: absent.revision, credential: { value: 'must-not-save' } }])).toBe(false);
  expect(await item.manager.compareAndSetMany([{ id, expectedRevision: live.revision, credential: { ...old, value: 'dummy-live-refresh' } }])).toBe(true);
  await item.vault.apply([{ op: 'delete', id }]);
  await item.manager.set(id, old);
  expect(await item.manager.compareAndSetMany([{ id, expectedRevision: live.revision, credential: { value: 'must-not-resurrect' } }])).toBe(false);
});

test('legacy snapshots require no write, preserve unknown schema fields and never expose revision metadata as a credential', async () => {
  const item = await fixture(false);
  const backend = item.vault.backend as any;
  const historical = backend.loadStoreSync();
  delete historical.entryRevisions;
  historical.unknownRoot = { keep: true };
  historical.metadata.unknownMetadata = 'keep';
  backend.saveStoreSync(historical);
  const bytes = readFileSync(item.filePath);
  const snapshot = await item.manager.getSnapshot(id);
  expect(readFileSync(item.filePath)).toEqual(bytes);
  expect(await item.manager.compareAndSetMany([{ id, expectedRevision: snapshot.revision, credential: { ...old, value: 'dummy-fresh' } }])).toBe(true);
  const updated = backend.loadStoreSync();
  expect(updated.unknownRoot).toEqual({ keep: true });
  expect(updated.metadata.unknownMetadata).toBe('keep');
  expect(Object.keys((await item.manager.get(id))!)).not.toContain('revision');
  expect(JSON.stringify(await item.vault.listMetadata())).not.toContain(snapshot.revision);
});

test('a separate writer process cannot hide same-value delete/recreate from an existing snapshot', async () => {
  const item = await fixture(false);
  const snapshot = await item.manager.getSnapshot(id);
  const backendUrl = new URL('../../../../../packages/shared/src/credentials/backends/secure-storage.ts', import.meta.url).href;
  const child = Bun.spawn([process.execPath, '--eval', `
    import { SecureStorageBackend } from ${JSON.stringify(backendUrl)};
    const backend = new SecureStorageBackend(${JSON.stringify(item.filePath)});
    await backend.delete(${JSON.stringify(id)});
    await backend.set(${JSON.stringify(id)}, ${JSON.stringify(old)});
  `], { stdout: 'pipe', stderr: 'pipe' });
  try {
    expect(await child.exited).toBe(0);
    expect(await item.manager.get(id)).toEqual(old);
    expect(await item.manager.compareAndSetMany([{ id, expectedRevision: snapshot.revision, credential: { value: 'must-not-overwrite' } }])).toBe(false);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
});
