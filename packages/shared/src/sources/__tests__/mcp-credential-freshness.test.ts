import { describe, expect, test, spyOn } from 'bun:test';
import { CredentialManager } from '../../credentials/manager.ts';
import { SourceCredentialManager } from '../credential-manager.ts';
import { SourceServerBuilder } from '../server-builder.ts';
import { TokenRefreshManager } from '../token-refresh-manager.ts';
import type { LoadedSource } from '../types.ts';

const source = (mcp: LoadedSource['config']['mcp']): LoadedSource => ({
  workspaceId: 'dummy-workspace', workspaceRootPath: '/tmp/dummy-workspace', folderPath: '/tmp/dummy-workspace/sources/dummy-source', guide: null,
  config: { id: 'dummy-id', slug: 'dummy-source', name: 'Dummy Source', type: 'mcp', enabled: true, provider: 'custom', isAuthenticated: true, mcp },
});
describe('MCP credential freshness and auth modes', () => {
  test('configured bearer credentials win over stale OAuth credentials', async () => {
    const get = spyOn(CredentialManager.prototype, 'get').mockImplementation(async id => ({ value: id.type === 'source_oauth' ? 'dummy-old-oauth' : 'dummy-new-bearer' }));
    try {
      const value = await new SourceCredentialManager().getToken(source({ url: 'https://example.invalid', authType: 'bearer' }));
      expect(value).toBe('dummy-new-bearer');
      expect(get).toHaveBeenCalledTimes(1);
    } finally { get.mockRestore(); }
  });
  test('header JSON is never attached as a bearer token and header-mode authentication works', async () => {
    const s = source({ url: 'https://example.invalid', authType: 'bearer', headerNames: ['X-Key'] });
    const stored = '{"X-Key":"dummy-secret"}';
    const config = new SourceServerBuilder().buildMcpServer(s, stored, { 'X-Key': 'dummy-secret' });
    expect(config).toEqual({ type: 'http', url: 'https://example.invalid', headers: { 'X-Key': 'dummy-secret' } });
    expect(new SourceServerBuilder().buildMcpServer(s, null, null)).toBeNull();
  });
  test('omitted authType remains public even after a successful refresh', () => {
    expect(new SourceServerBuilder().buildMcpServer(source({ url: 'https://example.invalid' }), null)).toEqual({ type: 'http', url: 'https://example.invalid' });
  });
  test('expired non-refreshable credentials are rejected', async () => {
    const manager = new SourceCredentialManager();
    const load = spyOn(manager, 'load').mockResolvedValue({ value: 'dummy-expired', expiresAt: 1 });
    try { expect((await new TokenRefreshManager(manager).ensureFreshToken(source({ authType: 'bearer' }))).success).toBe(false); }
    finally { load.mockRestore(); }
  });
  test('newly saved credentials work during cooldown from an old failed refresh', async () => {
    const manager = new SourceCredentialManager();
    const load = spyOn(manager, 'load').mockResolvedValue({ value: 'dummy-new' });
    const refresh = new TokenRefreshManager(manager);
    (refresh as any).failedAttempts.set('dummy-source', Date.now());
    try { expect(await refresh.ensureFreshToken(source({ authType: 'bearer' }))).toEqual({ success: true, token: 'dummy-new' }); }
    finally { load.mockRestore(); }
  });
});
