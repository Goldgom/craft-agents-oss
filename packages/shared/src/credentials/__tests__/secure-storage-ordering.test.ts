import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecureStorageBackend } from '../backends/secure-storage.ts';
import type { CredentialWrite } from '../types.ts';
import { CredentialManager } from '../manager.ts';
import * as credentialsModule from '../index.ts';
import { SourceCredentialManager } from '../../sources/credential-manager.ts';
import { loadSource, saveSourceConfig } from '../../sources/storage.ts';

let directory: string;
let path: string;
let children: ReturnType<typeof Bun.spawn>[];
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'tokenbird-vault-lock-')); path = join(directory, 'credentials.enc'); children = []; });
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
  }
  rmSync(directory, { recursive: true, force: true });
});

async function waitForMarker(marker: string, child: ReturnType<typeof Bun.spawn>) {
  const deadline = Date.now() + 5000;
  while (!existsSync(marker) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(marker)).toBe(true);
}

async function holdLock(autoReleaseMs?: number) {
  const ready = join(directory, 'holder-ready');
  const release = join(directory, 'release-holder');
  const child = Bun.spawn([process.execPath, '--eval', `
    import { openSync, closeSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
    const fd = openSync(${JSON.stringify(`${path}.lock`)}, 'wx', 0o600);
    try {
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      const deadline = Date.now() + 10000;
      const releaseAt = ${autoReleaseMs === undefined ? 'Infinity' : `Date.now() + ${autoReleaseMs}`};
      while (!existsSync(${JSON.stringify(release)})) {
        if (Date.now() >= releaseAt) break;
        if (Date.now() > deadline) throw new Error('Dummy lock holder expired');
        await Bun.sleep(10);
      }
    } finally { closeSync(fd); unlinkSync(${JSON.stringify(`${path}.lock`)}); }
  `], { stdout: 'pipe', stderr: 'pipe' });
  children.push(child);
  await waitForMarker(ready, child);
  return { child, release: () => writeFileSync(release, 'release') };
}

test('a contended save completes its transaction before returning and preserves copied inputs', async () => {
  const backend = new SecureStorageBackend(path);
  const holder = await holdLock(100);
  const entries: CredentialWrite[] = [{
    id: { type: 'source_bearer', workspaceId: 'dummy-workspace', sourceId: 'original' },
    credential: { value: 'dummy-original', refreshToken: 'dummy-refresh' },
  }];
  const pending = backend.setMany(entries);
  entries[0]!.id.sourceId = 'mutated';
  entries[0]!.credential.value = '';
  entries[0]!.credential.refreshToken = 'dummy-mutated-refresh';
  entries.push({ id: { type: 'anthropic_api_key' }, credential: { value: 'dummy-injected' } });
  await pending;
  expect(await holder.child.exited).toBe(0);
  const fresh = new SecureStorageBackend(path);
  expect(await fresh.list()).toHaveLength(1);
  expect(await fresh.get({ type: 'source_bearer', workspaceId: 'dummy-workspace', sourceId: 'original' }))
    .toEqual({ value: 'dummy-original', refreshToken: 'dummy-refresh' });
  expect(await fresh.get({ type: 'source_bearer', workspaceId: 'dummy-workspace', sourceId: 'mutated' })).toBeNull();
  expect(existsSync(`${path}.lock`)).toBe(false);
}, 10000);

test('a write failure after contended acquisition propagates and releases its own lock', async () => {
  const backend = new SecureStorageBackend(path);
  await backend.set({ type: 'anthropic_api_key' }, { value: 'dummy-old' });
  const original = readFileSync(path);
  const holder = await holdLock(100);
  const save = spyOn(backend as any, 'saveStoreSync').mockImplementationOnce(() => { throw new Error('dummy acquired-write failure'); });
  try {
    await expect(backend.set({ type: 'anthropic_api_key' }, { value: 'dummy-new' })).rejects.toThrow('dummy acquired-write failure');
    expect(await holder.child.exited).toBe(0);
    expect(readFileSync(path)).toEqual(original);
    expect(existsSync(`${path}.lock`)).toBe(false);
  } finally { save.mockRestore(); }
  await backend.set({ type: 'anthropic_api_key' }, { value: 'dummy-retry' });
  expect((await new SecureStorageBackend(path).get({ type: 'anthropic_api_key' }))?.value).toBe('dummy-retry');
}, 10000);

test('a later synchronous delete on another instance cannot be undone by an earlier contended save', async () => {
  const backend = new SecureStorageBackend(path);
  const other = new SecureStorageBackend(path);
  const id = { type: 'anthropic_api_key' } as const;
  await backend.set(id, { value: 'dummy-old' });
  const holder = await holdLock(100);
  const pending = backend.set(id, { value: 'dummy-new' });
  expect(other.deleteSync(id)).toBe(true);
  await pending;
  expect(await holder.child.exited).toBe(0);
  expect(await backend.get(id)).toBeNull();
  expect(await other.list()).toEqual([]);
});

test('async deletion and read-after-write preserve call order across multiple instances', async () => {
  const first = new SecureStorageBackend(path);
  const second = new SecureStorageBackend(path);
  const third = new SecureStorageBackend(path);
  const id = { type: 'anthropic_api_key' } as const;
  const holder = await holdLock(100);
  const write = first.set(id, { value: 'dummy-first' });
  expect((await second.get(id))?.value).toBe('dummy-first');
  const deletion = second.delete(id);
  await write;
  expect(await deletion).toBe(true);
  expect(await third.get(id)).toBeNull();
  const firstWrite = first.set(id, { value: 'dummy-before' });
  const secondWrite = second.set(id, { value: 'dummy-after' });
  await Promise.all([firstWrite, secondWrite]);
  expect((await third.get(id))?.value).toBe('dummy-after');
  expect(await holder.child.exited).toBe(0);
});

test('authType none cleanup cannot be undone by an earlier contended backend save', async () => {
  const backend = new SecureStorageBackend(path);
  const manager = new CredentialManager();
  // Route actual source cleanup through this test-owned vault, never a real HOME.
  Object.assign(manager as any, { initialized: true, backends: [backend], writeBackend: backend });
  const getter = spyOn(credentialsModule, 'getCredentialManager').mockReturnValue(manager);
  const workspace = join(directory, 'workspace');
  try {
    saveSourceConfig(workspace, { id: 'dummy-source', slug: 'dummy-source', name: 'Dummy', type: 'api', provider: 'custom', enabled: true,
      api: { baseUrl: 'https://example.invalid', authType: 'header', headerName: 'X-Dummy' } });
    const source = loadSource(workspace, 'dummy-source')!;
    const id = new SourceCredentialManager().getCredentialId(source);
    await backend.set(id, { value: 'dummy-old' });
    const holder = await holdLock(100);
    const pending = backend.set(id, { value: 'dummy-new' });
    saveSourceConfig(workspace, { ...source.config, api: { ...source.config.api!, authType: 'none' } });
    await pending;
    expect(await holder.child.exited).toBe(0);
    expect(await new SecureStorageBackend(path).get(id)).toBeNull();
    saveSourceConfig(workspace, source.config);
    expect(await manager.get(id)).toBeNull();
  } finally { getter.mockRestore(); }
});

test('terminating a waiting process never releases a different process’s active lock', async () => {
  const backend = new SecureStorageBackend(path);
  await backend.set({ type: 'anthropic_api_key' }, { value: 'dummy-old' });
  const original = readFileSync(path);
  const holder = await holdLock();
  const ready = join(directory, 'waiter-started');
  const moduleUrl = new URL('../backends/secure-storage.ts', import.meta.url).href;
  const waiter = Bun.spawn([process.execPath, '--eval', `
    import { writeFileSync } from 'node:fs';
    import { SecureStorageBackend } from ${JSON.stringify(moduleUrl)};
    writeFileSync(${JSON.stringify(ready)}, 'started');
    await new SecureStorageBackend(${JSON.stringify(path)}).set({ type: 'anthropic_api_key' }, { value: 'dummy-waiter' });
  `], { stdout: 'pipe', stderr: 'pipe' });
  children.push(waiter);
  await waitForMarker(ready, waiter);
  await Bun.sleep(40);
  waiter.kill('SIGKILL');
  expect(await waiter.exited).not.toBe(0);
  expect(existsSync(`${path}.lock`)).toBe(true);
  expect(readFileSync(path)).toEqual(original);
  holder.release();
  expect(await holder.child.exited).toBe(0);
  await backend.set({ type: 'anthropic_api_key' }, { value: 'dummy-recovered' });
  expect((await new SecureStorageBackend(path).get({ type: 'anthropic_api_key' }))?.value).toBe('dummy-recovered');
}, 10000);
