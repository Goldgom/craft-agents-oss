/* eslint-disable craft-shared/no-inline-source-auth-check -- Assert the exact persisted badge value, not source usability. */
import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { CredentialManager } from '../../credentials/manager.ts';
import { saveSourceConfig, loadSource } from '../storage.ts';
import { saveSourceCredentialBatch, validateSourceCredential } from '../credential-batch.ts';
import type { FolderSourceConfig } from '../types.ts';

let root: string;
let save: ReturnType<typeof spyOn>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tokenbird-source-batch-'));
  save = spyOn(CredentialManager.prototype, 'setMany').mockResolvedValue(undefined);
});
afterEach(() => { save.mockRestore(); rmSync(root, { recursive: true, force: true }); });
function source(slug: string, config: Partial<FolderSourceConfig> = {}) {
  saveSourceConfig(root, { id: `id-${slug}`, slug, name: slug, type: 'mcp', provider: 'custom', enabled: true,
    mcp: { url: 'https://example.invalid/mcp', authType: 'bearer' }, ...config });
  return loadSource(root, slug)!;
}
describe('bulk source credential updates', () => {
  test('validates all entries before one atomic vault operation', async () => {
    source('one'); source('two');
    const result = await saveSourceCredentialBatch(root, [{ sourceSlug: 'one', credential: 'dummy-one' }, { sourceSlug: 'two', credential: 'dummy-two' }]);
    expect(result).toEqual({ saved: 2, statusUpdateFailed: [] });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toHaveLength(2);
    expect(save.mock.calls[0]![0][0].id.workspaceId).toBe(basename(root));
    expect(loadSource(root, 'one')!.config.isAuthenticated).toBe(true);
  });
  test('invalid late entry, duplicate, traversal and missing source never write', async () => {
    source('one'); source('two');
    for (const entries of [
      [{ sourceSlug: 'one', credential: 'dummy-one' }, { sourceSlug: 'two', credential: '' }],
      [{ sourceSlug: 'one', credential: 'dummy-one' }, { sourceSlug: 'one', credential: 'dummy-two' }],
      [{ sourceSlug: '../other', credential: 'dummy-one' }],
      [{ sourceSlug: 'missing', credential: 'dummy-one' }],
    ]) await expect(saveSourceCredentialBatch(root, entries)).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    expect(loadSource(root, 'one')!.config.isAuthenticated).not.toBe(true);
  });
  test('persistence failure never marks sources authenticated', async () => {
    source('one');
    save.mockRejectedValueOnce(new Error('dummy write failure'));
    await expect(saveSourceCredentialBatch(root, [{ sourceSlug: 'one', credential: 'dummy-one' }])).rejects.toThrow('dummy write failure');
    expect(loadSource(root, 'one')!.config.isAuthenticated).not.toBe(true);
  });
  test('preserves basic password whitespace and supports explicitly empty passwords', () => {
    const basic = source('basic', { type: 'api', mcp: undefined, api: { baseUrl: 'https://example.invalid', authType: 'basic' } });
    expect(JSON.parse(validateSourceCredential(basic, '{"username":"dummy-user","password":" dummy password "}')).password).toBe(' dummy password ');
    expect(JSON.parse(validateSourceCredential(basic, '{"username":"dummy-user","password":""}')).password).toBe('');
    expect(() => validateSourceCredential(basic, '{"username":"dummy-user"}')).toThrow();
  });
  test('requires all configured headers and never includes secret contents in errors', () => {
    const headers = source('headers', { mcp: { url: 'https://example.invalid', authType: 'none', headerNames: ['X-Key', 'X-Secret'] } });
    expect(() => validateSourceCredential(headers, 'dummy-not-json-secret')).toThrow('Credential must be a JSON object');
    expect(() => validateSourceCredential(headers, '{"X-Key":"dummy-one"}')).toThrow('required headers');
    expect(JSON.parse(validateSourceCredential(headers, '{"X-Key":"dummy-one","X-Secret":"dummy-two","Ignored":"dummy-three"}'))).toEqual({ 'X-Key': 'dummy-one', 'X-Secret': 'dummy-two' });
  });
  test('rejects OAuth token replacement and public/stdio sources', () => {
    for (const mcp of [
      { url: 'https://example.invalid', authType: 'oauth' as const },
      { url: 'https://example.invalid', authType: 'none' as const },
      { transport: 'stdio' as const, command: 'dummy-command' },
    ]) expect(() => validateSourceCredential(source('auth', { mcp }), 'dummy-token')).toThrow();
  });
});

test('API public auth cannot falsely report a credential saved into an auto-cleared slot', async () => {
  const api = source('public', { type: 'api', mcp: undefined, api: { baseUrl: 'https://example.invalid', authType: 'none', headerNames: ['X-Key'] } });
  expect(() => validateSourceCredential(api, '{"X-Key":"dummy-value"}')).toThrow('does not use');
});

test('invalid HTTP header bytes are rejected without exposing their value', () => {
  const bearer = source('bearer');
  const headers = source('headers', { mcp: { url: 'https://example.invalid', authType: 'none', headerNames: ['X-Key'] } });
  for (const value of ['dummy\u0000secret', 'dummy\r\nsecret', 'dummy\u2603secret']) {
    for (const operation of [() => validateSourceCredential(bearer, value), () => validateSourceCredential(headers, JSON.stringify({ 'X-Key': value }))]) {
      let failure: unknown;
      try { operation(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain('dummy');
    }
  }
});


test('provider-owned OAuth credentials cannot be overwritten through a conflicting manual auth mode', () => {
  const api = source('google', { type: 'api', provider: 'google', mcp: undefined, api: { baseUrl: 'https://example.invalid', authType: 'bearer' } });
  expect(() => validateSourceCredential(api, 'dummy-token')).toThrow('OAuth sign-in');
});
