/* eslint-disable craft-shared/no-inline-source-auth-check -- Assert persisted batch status, not source usability. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialManager } from '../../credentials/manager.ts';
import { saveSourceCredentialBatch, validateSourceCredential } from '../credential-batch.ts';
import { loadSource, saveSourceConfig } from '../storage.ts';
import type { FolderSourceConfig } from '../types.ts';
import { executeApiRequest } from '../api-tools.ts';
import { SourceServerBuilder } from '../server-builder.ts';

let root: string;
let save: ReturnType<typeof spyOn>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tokenbird-source-boundary-'));
  save = spyOn(CredentialManager.prototype, 'setMany').mockResolvedValue(undefined);
});
afterEach(() => { save.mockRestore(); rmSync(root, { recursive: true, force: true }); });
function source(slug: string, config: Partial<FolderSourceConfig> = {}) {
  saveSourceConfig(root, { id: `dummy-${slug}`, slug, name: slug, type: 'mcp', provider: 'custom', enabled: true,
    mcp: { url: 'https://example.invalid/mcp', authType: 'bearer' }, ...config });
  return loadSource(root, slug)!;
}

describe('source credential batch size boundaries', () => {
  test('100 sources succeed in exactly one write and all badges are updated', async () => {
    const entries = Array.from({ length: 100 }, (_, index) => {
      const sourceSlug = `source-${index}`;
      source(sourceSlug);
      return { sourceSlug, credential: `dummy-${index}` };
    });
    expect(await saveSourceCredentialBatch(root, entries)).toEqual({ saved: 100, statusUpdateFailed: [] });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toHaveLength(100);
    for (const { sourceSlug } of entries) expect(loadSource(root, sourceSlug)!.config.isAuthenticated).toBe(true);
  });

  test('empty, non-array, and 101-entry requests fail before credential writes', async () => {
    source('existing');
    const entries = Array.from({ length: 101 }, (_, index) => ({ sourceSlug: `source-${index}`, credential: `dummy-${index}` }));
    for (const invalid of [[], entries, null, {}, 'dummy-invalid']) {
      await expect(saveSourceCredentialBatch(root, invalid as any)).rejects.toThrow('between 1 and 100');
    }
    expect(save).not.toHaveBeenCalled();
    expect(loadSource(root, 'existing')!.config.isAuthenticated).not.toBe(true);
  });

  test('invalid 100th entry rejects the entire otherwise valid batch', async () => {
    const entries = Array.from({ length: 100 }, (_, index) => {
      const sourceSlug = `source-${index}`;
      source(sourceSlug);
      return { sourceSlug, credential: index === 99 ? '' : `dummy-${index}` };
    });
    await expect(saveSourceCredentialBatch(root, entries)).rejects.toThrow('non-empty');
    expect(save).not.toHaveBeenCalled();
    for (const { sourceSlug } of entries) expect(loadSource(root, sourceSlug)!.config.isAuthenticated).not.toBe(true);
  });
});

describe('source credential length boundaries', () => {
  test('exactly one MiB succeeds; one additional character is rejected without exposing the secret', async () => {
    const bearer = source('bearer');
    const value = 'dummy-length-boundary-'.padEnd(1024 * 1024, 'x');
    expect(validateSourceCredential(bearer, value)).toBe(value);
    await expect(saveSourceCredentialBatch(root, [{ sourceSlug: 'bearer', credential: `${value}x` }])).rejects.toThrow('at most 1 MiB');
    expect(save).not.toHaveBeenCalled();
    expect(loadSource(root, 'bearer')!.config.isAuthenticated).not.toBe(true);
  });

  test('JSON credentials enforce the complete serialized input limit', () => {
    const basic = source('basic', { type: 'api', mcp: undefined, api: { baseUrl: 'https://example.invalid', authType: 'basic' } });
    const overhead = JSON.stringify({ username: 'dummy-user', password: '' }).length;
    const exact = JSON.stringify({ username: 'dummy-user', password: 'x'.repeat(1024 * 1024 - overhead) });
    expect(exact).toHaveLength(1024 * 1024);
    expect(validateSourceCredential(basic, exact)).toBe(exact);
    expect(() => validateSourceCredential(basic, `${exact} `)).toThrow('at most 1 MiB');
  });
});

describe('query credentials have URL encoding rather than header restrictions', () => {
  test('Unicode and interior line breaks round-trip as one encoded query parameter', async () => {
    const query = source('query', { type: 'api', mcp: undefined,
      api: { baseUrl: 'https://example.invalid', authType: 'query', queryParam: 'key' } });
    const value = 'dummy-雪-🔑\r\nvalue&injected=wrong#fragment';
    expect(validateSourceCredential(query, value)).toBe(value);
    await expect(saveSourceCredentialBatch(root, [{ sourceSlug: 'query', credential: value }])).resolves.toEqual({ saved: 1, statusUpdateFailed: [] });
    expect(save.mock.calls[0]![0][0].credential.value).toBe(value);
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
    try {
      const config = new SourceServerBuilder().buildApiConfig(query);
      await executeApiRequest(config, value, { path: '/check', method: 'GET' });
      const [requestUrl, options] = fetch.mock.calls.find(([url]) => String(url).startsWith('https://example.invalid/check'))!;
      const url = new URL(String(requestUrl));
      expect(url.searchParams.get('key')).toBe(value);
      expect([...url.searchParams.keys()]).toEqual(['key']);
      expect(url.hash).toBe('');
      expect(String(requestUrl)).not.toContain('\r');
      expect(String(requestUrl)).not.toContain('\n');
      expect(new Headers(options?.headers).has('Authorization')).toBe(false);
    } finally { fetch.mockRestore(); }
  });

  test('unpaired surrogates are rejected before they reach encodeURIComponent', () => {
    const query = source('query', { type: 'api', mcp: undefined,
      api: { baseUrl: 'https://example.invalid', authType: 'query' } });
    expect(() => validateSourceCredential(query, 'dummy-\ud800-token')).toThrow('valid Unicode');
  });

  test('API bearer and single-header values retain strict header-byte protection', () => {
    for (const authType of ['bearer', 'header'] as const) {
      const header = source(authType, { type: 'api', mcp: undefined,
        api: { baseUrl: 'https://example.invalid', authType, headerName: 'X-Dummy' } });
      for (const value of ['dummy-雪', 'dummy\r\nvalue']) expect(() => validateSourceCredential(header, value)).toThrow();
    }
  });
});
