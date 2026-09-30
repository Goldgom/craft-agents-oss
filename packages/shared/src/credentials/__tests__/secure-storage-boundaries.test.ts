import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecureStorageBackend } from '../backends/secure-storage.ts';
import { credentialIdToAccount, type CredentialId, type CredentialWrite } from '../types.ts';

let directory: string;
let path: string;
const id = (sourceId: string): CredentialId => ({ type: 'source_bearer', workspaceId: 'dummy-boundary-workspace', sourceId });
const entry = (sourceId: string): CredentialWrite => ({ id: id(sourceId), credential: { value: `dummy-${sourceId}` } });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tokenbird-vault-boundary-'));
  path = join(directory, 'credentials.enc');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

/** Construct authenticated fixtures without production format changes or real credentials. */
function fixture(payload: unknown, legacy = false) {
  const backend = new SecureStorageBackend(path) as any;
  const salt = randomBytes(32);
  const key: Buffer = legacy ? backend.getLegacyEncryptionKey(salt) : backend.getEncryptionKey(salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  const header = Buffer.alloc(64);
  Buffer.from('CRAFT01\0').copy(header);
  salt.copy(header, 12);
  const bytes = Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]);
  writeFileSync(path, bytes, { mode: 0o600 });
  return bytes;
}

function payload(credentials: Record<string, unknown> = { [credentialIdToAccount(id('old'))]: { value: 'dummy-old' } }) {
  return { version: 1, credentials, metadata: { createdAt: 123, updatedAt: 456 } };
}

function decrypt(bytes: Buffer, legacy: boolean): unknown {
  const backend = new SecureStorageBackend(path) as any;
  const key = legacy ? backend.getLegacyEncryptionKey(bytes.subarray(12, 44)) : backend.getEncryptionKey(bytes.subarray(12, 44));
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(64, 76));
  decipher.setAuthTag(bytes.subarray(76, 92));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(92)), decipher.final()]).toString('utf8'));
}

describe('vault batch limits', () => {
  test('empty batches are no-ops and 1000 entries round-trip in one encrypted transaction', async () => {
    const backend = new SecureStorageBackend(path);
    await backend.setMany([]);
    expect(readdirSync(directory)).toEqual([]);
    const entries = Array.from({ length: 1000 }, (_, index) => entry(`source-${index}`));
    await backend.setMany(entries);
    const fresh = new SecureStorageBackend(path);
    expect(await fresh.list()).toHaveLength(1000);
    expect(await fresh.get(id('source-0'))).toEqual(entries[0]!.credential);
    expect(await fresh.get(id('source-999'))).toEqual(entries[999]!.credential);
    const original = readFileSync(path);
    await backend.setMany([]);
    expect(readFileSync(path)).toEqual(original);
    await expect(backend.setMany([...entries, entry('overflow')])).rejects.toThrow('Invalid credential batch');
    expect(readFileSync(path)).toEqual(original);
    expect(await fresh.get(id('overflow'))).toBeNull();
    expect(readdirSync(directory)).toEqual(['credentials.enc']);
  });

  test('a one-MiB synthetic credential round-trips without plaintext bytes in the vault', async () => {
    const value = 'dummy-boundary-'.padEnd(1024 * 1024, 'x');
    await new SecureStorageBackend(path).set(id('large'), { value });
    expect((await new SecureStorageBackend(path).get(id('large')))?.value).toBe(value);
    expect(readFileSync(path).includes(Buffer.from('dummy-boundary-'))).toBe(false);
  });
});

describe('authenticated schema corruption', () => {
  for (const [name, malformed] of [
    ['null credential', null],
    ['string credential', 'dummy-invalid-string'],
    ['array credential', ['dummy-invalid-array']],
    ['missing value', { refreshToken: 'dummy-refresh' }],
    ['numeric value', { value: 123 }],
    ['object value', { value: { secret: 'dummy-nested-secret' } }],
  ] as const) {
    test(`${name} cannot be read or rewritten as a healthy vault`, async () => {
      const original = fixture(payload({ [credentialIdToAccount(id('old'))]: malformed }));
      const backend = new SecureStorageBackend(path);
      await expect(backend.get(id('old'))).rejects.toThrow('preserved');
      await expect(backend.setMany([entry('new')])).rejects.toThrow('preserved');
      expect(readFileSync(path)).toEqual(original);
      expect(readdirSync(directory)).toEqual(['credentials.enc']);
    });
  }

  for (const [name, malformed] of [
    ['future version', { ...payload(), version: 2 }],
    ['missing metadata', { version: 1, credentials: {} }],
    ['invalid timestamp', { ...payload(), metadata: { createdAt: '123', updatedAt: 456 } }],
    ['array map', { ...payload(), credentials: [] }],
  ]) {
    test(`${name} remains byte-for-byte preserved`, async () => {
      const original = fixture(malformed);
      await expect(new SecureStorageBackend(path).setMany([entry('new')])).rejects.toThrow('preserved');
      expect(readFileSync(path)).toEqual(original);
    });
  }

  test('unknown entries and fields remain compatible, including empty legacy values', async () => {
    const unknown = { value: 'dummy-future', futureField: { version: 3 } };
    fixture(payload({
      [credentialIdToAccount(id('old'))]: { value: '', refreshToken: 'dummy-refresh' },
      'future_credential::dummy-scope': unknown,
    }));
    const backend = new SecureStorageBackend(path);
    expect(await backend.get(id('old'))).toEqual({ value: '', refreshToken: 'dummy-refresh' });
    await backend.setMany([entry('new')]);
    const result = decrypt(readFileSync(path), false) as any;
    expect(result.credentials['future_credential::dummy-scope']).toEqual(unknown);
    expect(result.credentials[credentialIdToAccount(id('old'))]).toEqual({ value: '', refreshToken: 'dummy-refresh' });
    expect(result.metadata.createdAt).toBe(123);
  });
});

describe('legacy key migration boundaries', () => {
  test('reads never migrate; the next successful batch migrates every entry to the stable key', async () => {
    const original = fixture(payload(), true);
    const backend = new SecureStorageBackend(path);
    expect((await backend.get(id('old')))?.value).toBe('dummy-old');
    expect(await backend.list()).toHaveLength(1);
    expect(readFileSync(path)).toEqual(original);
    expect(() => decrypt(original, false)).toThrow();
    await backend.setMany([entry('new')]);
    const migrated = readFileSync(path);
    expect(migrated).not.toEqual(original);
    const result = decrypt(migrated, false) as any;
    expect(Object.keys(result.credentials)).toHaveLength(2);
    expect(result.credentials[credentialIdToAccount(id('old'))].value).toBe('dummy-old');
    expect(result.metadata.createdAt).toBe(123);
    expect(() => decrypt(migrated, true)).toThrow();
    expect(await new SecureStorageBackend(path).list()).toHaveLength(2);
  });

  test('failed migration preserves the legacy file and permits a later successful retry', async () => {
    const original = fixture(payload(), true);
    const backend = new SecureStorageBackend(path);
    const save = spyOn(backend as any, 'saveStoreSync').mockImplementationOnce(() => { throw new Error('dummy migration write failure'); });
    try {
      await expect(backend.setMany([entry('new')])).rejects.toThrow('dummy migration write failure');
    } finally { save.mockRestore(); }
    expect(readFileSync(path)).toEqual(original);
    expect((await backend.get(id('old')))?.value).toBe('dummy-old');
    expect(await backend.get(id('new'))).toBeNull();
    await backend.setMany([entry('new')]);
    expect(await new SecureStorageBackend(path).list()).toHaveLength(2);
    expect(() => decrypt(readFileSync(path), false)).not.toThrow();
  });

  test('a cached instance reloads a replacement vault with a different salt', async () => {
    const backend = new SecureStorageBackend(path);
    fixture(payload());
    expect((await backend.get(id('old')))?.value).toBe('dummy-old');
    fixture(payload({ [credentialIdToAccount(id('replacement'))]: { value: 'dummy-replacement' } }), true);
    expect(await backend.get(id('old'))).toBeNull();
    expect((await backend.get(id('replacement')))?.value).toBe('dummy-replacement');
    await backend.setMany([entry('new')]);
    expect(await new SecureStorageBackend(path).list()).toHaveLength(2);
  });
});
