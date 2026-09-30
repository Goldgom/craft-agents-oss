import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecureStorageBackend } from '../backends/secure-storage.ts';
import type { CredentialId, CredentialWrite } from '../types.ts';

let directory: string;
let path: string;
const id = (sourceId: string): CredentialId => ({ type: 'source_bearer', workspaceId: 'dummy-workspace', sourceId });
const entry = (sourceId: string, value = `dummy-${sourceId}`): CredentialWrite => ({ id: id(sourceId), credential: { value } });
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'tokenbird-vault-test-')); path = join(directory, 'credentials.enc'); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('encrypted credential transactions', () => {
  test('simultaneous writes to an initially empty vault preserve every entry', async () => {
    const backend = new SecureStorageBackend(path);
    await Promise.all(Array.from({ length: 30 }, (_, index) => backend.set(id(`source-${index}`), { value: `dummy-${index}` })));
    expect(await new SecureStorageBackend(path).list()).toHaveLength(30);
    expect(readFileSync(path).includes(Buffer.from('dummy-0'))).toBe(false);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('concurrent instances and later reads observe atomic replacements', async () => {
    const first = new SecureStorageBackend(path);
    const second = new SecureStorageBackend(path);
    await first.setMany([entry('one')]);
    expect((await second.get(id('one')))?.value).toBe('dummy-one');
    await Promise.all([first.setMany([entry('one', 'dummy-new')]), second.setMany([entry('two')])]);
    expect((await second.get(id('one')))?.value).toBe('dummy-new');
    expect(await first.list()).toHaveLength(2);
    await second.delete(id('one'));
    expect(await first.get(id('one'))).toBeNull();
  });

  test('invalid and duplicate batches leave persisted and cached credentials intact', async () => {
    const backend = new SecureStorageBackend(path);
    await backend.setMany([entry('one')]);
    const original = readFileSync(path);
    await expect(backend.setMany([entry('one', 'dummy-changed'), entry('two', '')])).rejects.toThrow('non-empty');
    await expect(backend.setMany([entry('two'), entry('two')])).rejects.toThrow('Duplicate');
    await expect(backend.setMany([{ id: { type: 'source_bearer' }, credential: { value: 'dummy-secret' } }])).rejects.toThrow('scope');
    expect(readFileSync(path)).toEqual(original);
    expect((await backend.get(id('one')))?.value).toBe('dummy-one');
  });

  test('failed persistence does not alter the file, cache, or later successful writes', async () => {
    const backend = new SecureStorageBackend(path);
    await backend.setMany([entry('one')]);
    const original = readFileSync(path);
    // Force exclusive temporary-file creation to fail after the old vault loaded.
    const writer = spyOn(backend as any, 'saveStoreSync').mockImplementationOnce(() => { throw new Error('dummy disk failure'); });
    await expect(backend.setMany([entry('one', 'dummy-changed'), entry('two')])).rejects.toThrow('dummy disk failure');
    writer.mockRestore();
    expect(readFileSync(path)).toEqual(original);
    expect((await backend.get(id('one')))?.value).toBe('dummy-one');
    expect(await backend.get(id('two'))).toBeNull();
    await backend.setMany([entry('three')]);
    expect(await new SecureStorageBackend(path).list()).toHaveLength(2);
  });

  test('actual rename failure preserves the original vault and cleans up temporary files', async () => {
    const backend = new SecureStorageBackend(path);
    await backend.setMany([entry('one')]);
    const original = readFileSync(path);
    // Replace the file with a directory only after load, forcing commit to fail.
    const originalLoad = (backend as any).loadStoreSync.bind(backend);
    const failingLoad = spyOn(backend as any, 'loadStoreSync').mockImplementationOnce(() => {
      const result = originalLoad();
      renameSync(path, `${path}.original`);
      mkdirSync(path);
      return result;
    });
    await expect(backend.setMany([entry('two')])).rejects.toThrow('Could not save credentials');
    failingLoad.mockRestore();
    rmSync(path, { recursive: true });
    renameSync(`${path}.original`, path);
    expect(readFileSync(path)).toEqual(original);
    expect(readdirSync(directory)).toEqual(['credentials.enc']);
    expect(await backend.get(id('two'))).toBeNull();
  });

  test('an unreadable or corrupted store is preserved and cannot be silently overwritten', async () => {
    const corrupt = Buffer.from('dummy broken encrypted file');
    writeFileSync(path, corrupt);
    const backend = new SecureStorageBackend(path);
    await expect(backend.setMany([entry('one')])).rejects.toThrow('preserved');
    expect(readFileSync(path)).toEqual(corrupt);
  });

  test('returned and submitted objects cannot mutate the cached store', async () => {
    const backend = new SecureStorageBackend(path);
    const credential = { value: 'dummy-original' };
    await backend.set(id('one'), credential);
    credential.value = 'dummy-mutated';
    const returned = await backend.get(id('one'));
    returned!.value = 'dummy-mutated-again';
    expect((await backend.get(id('one')))?.value).toBe('dummy-original');
  });
});

test('two independent processes cannot overwrite each other’s concurrent batches', async () => {
  const moduleUrl = new URL('../backends/secure-storage.ts', import.meta.url).href;
  const run = (prefix: string) => Bun.spawn([process.execPath, '--eval', `
    import { SecureStorageBackend } from ${JSON.stringify(moduleUrl)};
    const store = new SecureStorageBackend(${JSON.stringify(path)});
    for (let index = 0; index < 25; index++) {
      await store.set({ type: 'source_bearer', workspaceId: 'dummy-workspace', sourceId: ${JSON.stringify(prefix)} + index }, { value: 'dummy-token' });
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  `], { stdout: 'pipe', stderr: 'pipe' });
  const first = run('first-');
  const second = run('second-');
  expect(await first.exited).toBe(0);
  expect(await second.exited).toBe(0);
  expect(await new SecureStorageBackend(path).list()).toHaveLength(50);
  expect(readdirSync(directory)).toEqual(['credentials.enc']);
}, 15000);

test('an abandoned writer lock times out without changing credentials or stealing the lock', async () => {
  const backend = new SecureStorageBackend(path);
  await backend.setMany([entry('one')]);
  const original = readFileSync(path);
  writeFileSync(`${path}.lock`, '', { mode: 0o600 });
  await expect(backend.setMany([entry('two')])).rejects.toThrow('Credential store is busy');
  expect(readFileSync(path)).toEqual(original);
  expect(readdirSync(directory).sort()).toEqual(['credentials.enc', 'credentials.enc.lock']);
  rmSync(`${path}.lock`);
  await backend.setMany([entry('two')]);
  expect(await backend.list()).toHaveLength(2);
}, 10000);
