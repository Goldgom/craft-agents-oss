/**
 * McpClientPool.ensureConnected: single-source connect/reconnect semantics —
 * connect once, no-op on unchanged config, reconnect on credential change,
 * and the local-MCP gate for stdio configs (same gate sync() applies).
 */

import { afterEach, describe, test, expect } from 'bun:test';
import { McpClientPool } from '../mcp-pool.ts';
import type { PoolClient } from '../client.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';

const pools: McpClientPool[] = [];
afterEach(async () => { await Promise.all(pools.splice(0).map(pool => pool.disconnectAll())); });

class TestPool extends McpClientPool {
  constructor(options?: ConstructorParameters<typeof McpClientPool>[0]) {
    super(options);
    pools.push(this);
  }
  connectCalls: Array<{ slug: string; config: SdkMcpServerConfig }> = [];
  closedSlugs: string[] = [];

  override async registerClient(slug: string, client: PoolClient): Promise<void> {
    this.connectCalls.push({ slug, config: this.activeConfigs.get(slug)! });
    client.listTools = async () => [];
    client.callTool = async () => ({ content: [] });
    client.close = async () => { this.closedSlugs.push(slug); };
    await super.registerClient(slug, client);
  }
}

function httpConfig(token: string): SdkMcpServerConfig {
  return { type: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: `Bearer ${token}` } };
}

describe('McpClientPool.ensureConnected', () => {
  test('connects an absent source once', async () => {
    const pool = new TestPool();
    await pool.ensureConnected('craft', httpConfig('a'));
    expect(pool.connectCalls.length).toBe(1);
    expect(pool.isConnected('craft')).toBe(true);
  });

  test('is a no-op when already connected with an unchanged config', async () => {
    const pool = new TestPool();
    await pool.ensureConnected('craft', httpConfig('a'));
    await pool.ensureConnected('craft', httpConfig('a'));
    expect(pool.connectCalls.length).toBe(1);
    expect(pool.closedSlugs).toEqual([]);
  });

  test('reconnects when the auth header changed (token refresh)', async () => {
    const pool = new TestPool();
    await pool.ensureConnected('craft', httpConfig('a'));
    await pool.ensureConnected('craft', httpConfig('b'));
    expect(pool.connectCalls.length).toBe(2);
    expect(pool.closedSlugs).toEqual(['craft']);
    expect(pool.isConnected('craft')).toBe(true);
  });

  test('reconnects when a custom API key header is rotated or removed', async () => {
    const pool = new TestPool();
    const config = (headers: Record<string, string>): SdkMcpServerConfig => ({ type: 'http', url: 'https://mcp.example.test/mcp', headers });
    await pool.ensureConnected('custom', config({ 'X-Api-Key': 'dummy-old' }));
    await pool.ensureConnected('custom', config({ 'x-api-key': 'dummy-new' }));
    await pool.ensureConnected('custom', config({}));
    expect(pool.connectCalls.length).toBe(3);
    expect(pool.closedSlugs).toEqual(['custom', 'custom']);
  });

  test('ignores header casing and map insertion order', async () => {
    const pool = new TestPool();
    await pool.ensureConnected('same', { type: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: 'Bearer dummy', Accept: 'application/json' } });
    await pool.ensureConnected('same', { type: 'http', url: 'https://mcp.example.test/mcp', headers: { accept: 'application/json', authorization: 'Bearer dummy' } });
    expect(pool.connectCalls.length).toBe(1);
  });

  test('reconnects after stdio credentials, arguments, or executable change', async () => {
    const pool = new TestPool();
    const base = { type: 'stdio' as const, command: 'dummy-mcp', args: ['--test'], env: { API_KEY: 'dummy-old' } };
    await pool.ensureConnected('local', base);
    await pool.ensureConnected('local', { ...base, env: { API_KEY: 'dummy-new' } });
    await pool.ensureConnected('local', { ...base, args: ['--other'] });
    await pool.ensureConnected('local', { ...base, command: 'dummy-mcp-v2' });
    expect(pool.connectCalls.length).toBe(4);
    expect(pool.closedSlugs).toHaveLength(3);
  });

  test('does not reconnect unchanged stdio settings with reordered environment', async () => {
    const pool = new TestPool();
    await pool.ensureConnected('local', { type: 'stdio', command: 'dummy-mcp', env: { A: '1', B: '2' } });
    await pool.ensureConnected('local', { type: 'stdio', command: 'dummy-mcp', args: [], env: { B: '2', A: '1' } });
    expect(pool.connectCalls.length).toBe(1);
  });

  test('does not touch other pool members', async () => {
    const pool = new TestPool();
    await pool.ensureConnected('one', httpConfig('a'));
    await pool.ensureConnected('two', httpConfig('x'));
    await pool.ensureConnected('one', httpConfig('b')); // reconnect 'one' only
    expect(pool.isConnected('two')).toBe(true);
    expect(pool.closedSlugs).toEqual(['one']);
  });

  test('refuses stdio configs when local MCP is disabled for the workspace', async () => {
    const prev = process.env.CRAFT_LOCAL_MCP_ENABLED;
    process.env.CRAFT_LOCAL_MCP_ENABLED = 'false';
    try {
      const pool = new TestPool({ workspaceRootPath: '/tmp/ws-does-not-exist' });
      const stdio: SdkMcpServerConfig = { type: 'stdio', command: 'echo', args: [] };
      await expect(pool.ensureConnected('local', stdio)).rejects.toThrow(/Local MCP is disabled/);
      expect(pool.connectCalls.length).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.CRAFT_LOCAL_MCP_ENABLED;
      else process.env.CRAFT_LOCAL_MCP_ENABLED = prev;
    }
  });
});
