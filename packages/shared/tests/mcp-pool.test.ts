/**
 * Tests for McpClientPool — config change detection during sync().
 *
 * Verifies that when a source's OAuth token is refreshed, sync() reconnects
 * the source with fresh credentials instead of keeping a stale connection.
 * This was the root cause of MCP connection drops every 30-60 minutes:
 * tokens were refreshed but never applied to existing transports.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { McpClientPool } from '../src/mcp/mcp-pool.ts';
import type { SdkMcpServerConfig } from '../src/agent/backend/types.ts';
import type { PoolClient } from '../src/mcp/client.ts';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// ============================================================
// Helpers
// ============================================================

const mockTools: Tool[] = [
  {
    name: 'test-tool',
    description: 'A test tool',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

function httpConfig(token: string, url = 'https://mcp.example.com'): SdkMcpServerConfig {
  return { type: 'http', url, headers: { Authorization: `Bearer ${token}` } };
}

/**
 * Replace transport I/O only, preserving the real connect and ownership path.
 */
const pools: TestablePool[] = [];
afterEach(async () => { await Promise.all(pools.splice(0).map(pool => pool.disconnectAll())); });
class TestablePool extends McpClientPool {
  failNext = false;
  constructor() { super(); pools.push(this); }
  public connectCalls: Array<{ slug: string; config: SdkMcpServerConfig }> = [];
  public disconnectCalls: string[] = [];

  override async registerClient(slug: string, client: PoolClient): Promise<void> {
    this.connectCalls.push({ slug, config: this.activeConfigs.get(slug)! });
    client.listTools = async () => {
      if (this.failNext) { this.failNext = false; throw new Error('Server unavailable'); }
      return mockTools;
    };
    client.callTool = async () => ({ content: [{ type: 'text', text: 'ok' }] });
    client.close = async () => { this.disconnectCalls.push(slug); };
    await super.registerClient(slug, client);
  }

  /** Reset tracking arrays between sync phases within a single test */
  resetTracking(): void {
    this.connectCalls = [];
    this.disconnectCalls = [];
  }
}

// ============================================================
// Tests
// ============================================================

describe('McpClientPool.sync — config change detection', () => {
  let pool: TestablePool;

  beforeEach(() => {
    pool = new TestablePool();
  });

  it('reconnects when Authorization header changes (token refresh)', async () => {
    await pool.sync({ craft: httpConfig('old-token') });
    expect(pool.isConnected('craft')).toBe(true);
    pool.resetTracking();

    await pool.sync({ craft: httpConfig('new-token') });

    expect(pool.disconnectCalls).toEqual(['craft']);
    expect(pool.connectCalls).toHaveLength(1);
    expect(pool.connectCalls[0].config.headers?.Authorization).toBe('Bearer new-token');
    expect(pool.isConnected('craft')).toBe(true);
  });

  it('does not reconnect when config is unchanged', async () => {
    const config = httpConfig('token-1');
    await pool.sync({ craft: config });
    pool.resetTracking();

    await pool.sync({ craft: config });

    expect(pool.connectCalls).toHaveLength(0);
    expect(pool.disconnectCalls).toHaveLength(0);
  });

  it('reconnects when URL changes', async () => {
    await pool.sync({ craft: httpConfig('token', 'https://old.example.com') });
    pool.resetTracking();

    await pool.sync({ craft: httpConfig('token', 'https://new.example.com') });

    expect(pool.disconnectCalls).toEqual(['craft']);
    expect(pool.connectCalls).toHaveLength(1);
  });

  it('reconnects when custom headers change', async () => {
    // Custom headers may carry API keys or select a server protocol version.
    // Keep the transport aligned with the complete configured header set.
    const config1: SdkMcpServerConfig = {
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer same', 'X-Request-Id': 'aaa' },
    };
    const config2: SdkMcpServerConfig = {
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer same', 'X-Request-Id': 'bbb' },
    };

    await pool.sync({ craft: config1 });
    pool.resetTracking();

    await pool.sync({ craft: config2 });

    expect(pool.connectCalls).toHaveLength(1);
    expect(pool.disconnectCalls).toHaveLength(1);
  });

  it('disconnects sources removed from config', async () => {
    const config = httpConfig('token');
    await pool.sync({ craft: config, linear: config });
    pool.resetTracking();

    await pool.sync({ craft: config });

    expect(pool.disconnectCalls).toEqual(['linear']);
    expect(pool.isConnected('craft')).toBe(true);
    expect(pool.isConnected('linear')).toBe(false);
  });

  it('handles add + remove + refresh in a single sync', async () => {
    await pool.sync({
      craft: httpConfig('old-craft-token'),
      linear: httpConfig('linear-token', 'https://linear.example.com'),
    });
    pool.resetTracking();

    // craft: token refreshed, linear: removed, github: added
    await pool.sync({
      craft: httpConfig('new-craft-token'),
      github: httpConfig('gh-token', 'https://github.example.com'),
    });

    expect(pool.disconnectCalls).toContain('linear');
    expect(pool.disconnectCalls).toContain('craft');
    expect(pool.connectCalls.find(c => c.slug === 'craft')?.config.headers?.Authorization).toBe('Bearer new-craft-token');
    expect(pool.connectCalls.find(c => c.slug === 'github')).toBeDefined();
    expect(pool.isConnected('craft')).toBe(true);
    expect(pool.isConnected('linear')).toBe(false);
    expect(pool.isConnected('github')).toBe(true);
  });

  it('reports failure when reconnect fails after token refresh', async () => {
    const failPool = new TestablePool();

    await failPool.sync({ craft: httpConfig('old-token') });
    expect(failPool.isConnected('craft')).toBe(true);

    // Token refresh — disconnect succeeds but the new handshake fails
    failPool.failNext = true;
    const failures = await failPool.sync({ craft: httpConfig('new-token') });

    expect(failures).toContain('craft');
    expect(failPool.isConnected('craft')).toBe(false);
  });
});
