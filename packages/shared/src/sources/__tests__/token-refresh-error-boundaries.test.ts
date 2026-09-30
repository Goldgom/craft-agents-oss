/* eslint-disable craft-shared/no-inline-source-auth-check -- Verify persisted failure state. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceCredentialManager } from '../credential-manager.ts';
import { TokenRefreshManager } from '../token-refresh-manager.ts';
import { loadSource, saveSourceConfig } from '../storage.ts';
import { getCredentialManager } from '../../credentials/index.ts';
import { SecureStorageBackend } from '../../credentials/backends/secure-storage.ts';
import * as debugModule from '../../utils/debug.ts';

let root: string;
let restoreManager: () => void;
let backend: SecureStorageBackend;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tokenbird-refresh-error-'));
  const manager = getCredentialManager();
  const previous = { backends: (manager as any).backends, writeBackend: (manager as any).writeBackend, initialized: (manager as any).initialized, initPromise: (manager as any).initPromise };
  backend = new SecureStorageBackend(join(root, 'credentials.enc'));
  manager.configureBackend(backend);
  restoreManager = () => Object.assign(manager, previous);
});
afterEach(() => { restoreManager(); rmSync(root, { recursive: true, force: true }); });
function source(provider = 'custom', renew = false) {
  saveSourceConfig(root, { id: 'dummy-source', slug: 'dummy-oauth', name: 'Dummy OAuth', provider,
    type: 'api', enabled: true, isAuthenticated: true,
    api: renew ? { baseUrl: 'https://example.invalid', authType: 'bearer', renewEndpoint: { path: '/renew' } }
      : { baseUrl: 'https://example.invalid', authType: 'oauth', oauth: {
      tokenUrl: 'https://example.invalid/oauth/token', authorizationUrl: 'https://example.invalid/oauth/authorize', clientId: 'dummy-client-id',
    } } });
  return loadSource(root, 'dummy-oauth')!;
}
const expired = { value: 'dummy-access-token', refreshToken: 'dummy-refresh-token', clientId: 'dummy-client-id', clientSecret: 'dummy-client-secret', expiresAt: 1 };

describe('provider error text never becomes durable source state', () => {
  for (const [name, failure] of [
    ['Error', new Error('Provider echoed dummy-token-private-boundary')],
    ['string', 'Provider echoed dummy-token-private-boundary'],
    ['object', { toString: () => 'Provider echoed dummy-token-private-boundary' }],
  ] as const) {
    test(`orchestrator sanitizes a thrown ${name} before logging, persisting, and returning it`, async () => {
      const loaded = source();
      const credentials = new SourceCredentialManager();
      const load = spyOn(credentials, 'load').mockResolvedValue(expired);
      const refresh = spyOn(credentials, 'refresh').mockRejectedValue(failure);
      const logs: string[] = [];
      const manager = new TokenRefreshManager(credentials, { log: message => logs.push(message) });
      try {
        const result = await manager.ensureFreshToken(loaded);
        expect(result.success).toBe(false);
        const persisted = readFileSync(join(loaded.folderPath, 'config.json'), 'utf8');
        for (const exposed of [JSON.stringify(result), JSON.stringify(loaded.config), persisted, logs.join('\n')]) {
          expect(exposed).not.toContain('dummy-token-private-boundary');
        }
        expect(loaded.config.connectionStatus).toBe('needs_auth');
        expect(loaded.config.isAuthenticated).toBe(false);
        expect(manager.isInCooldown(loaded.config.slug)).toBe(true);
        expect(await manager.ensureFreshToken(loaded)).toMatchObject({ success: false, rateLimited: true });
        expect(refresh).toHaveBeenCalledTimes(1);
      } finally { refresh.mockRestore(); load.mockRestore(); }
    });
  }

  for (const provider of ['custom', 'google', 'slack', 'microsoft', 'renew']) {
    test(`${provider} refresh does not log or persist a thrown fetch error before orchestration`, async () => {
      const loaded = source(provider, provider === 'renew');
      const credentials = new SourceCredentialManager();
      await backend.set(credentials.getCredentialId(loaded), expired);
      const load = spyOn(credentials, 'load').mockResolvedValue(expired);
      const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider echoed dummy-token-private-boundary'));
      const debug = spyOn(debugModule, 'debug').mockImplementation(() => {});
      try {
        expect(await credentials.refresh(loaded)).toBeNull();
        // Background source-icon probes may also use fetch in the aggregate suite.
        expect(fetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true);
        const persisted = readFileSync(join(loaded.folderPath, 'config.json'), 'utf8');
        expect(persisted).not.toContain('dummy-token-private-boundary');
        expect(debug.mock.calls.flat().map(String).join('\n')).not.toContain('dummy-token-private-boundary');
        expect(loadSource(root, loaded.config.slug)!.config.connectionStatus).toBe('needs_auth');
      } finally { debug.mockRestore(); fetch.mockRestore(); load.mockRestore(); }
    });
  }

  for (const provider of ['custom', 'slack', 'renew']) {
    test(`${provider} refresh never exposes an error response body echoing a secret`, async () => {
      const loaded = source(provider, provider === 'renew');
      const credentials = new SourceCredentialManager();
      await backend.set(credentials.getCredentialId(loaded), expired);
      const load = spyOn(credentials, 'load').mockResolvedValue(expired);
      const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        ok: false, error: 'dummy-token-private-boundary', error_description: 'dummy-token-private-boundary',
      }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
      const debug = spyOn(debugModule, 'debug').mockImplementation(() => {});
      try {
        expect(await credentials.refresh(loaded)).toBeNull();
        expect(fetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true);
        expect(readFileSync(join(loaded.folderPath, 'config.json'), 'utf8')).not.toContain('dummy-token-private-boundary');
        expect(debug.mock.calls.flat().map(String).join('\n')).not.toContain('dummy-token-private-boundary');
      } finally { debug.mockRestore(); fetch.mockRestore(); load.mockRestore(); }
    });
  }
});
