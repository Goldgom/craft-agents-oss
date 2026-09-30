import { describe, expect, test } from 'bun:test';
import { CraftMcpClient } from '../client.ts';

describe('MCP client lifecycle', () => {
  test('failed initialization closes the transport even before connected becomes true', async () => {
    const client = new CraftMcpClient({ transport: 'sse', url: 'http://127.0.0.1:1/sse' });
    let closes = 0;
    (client as any).transport = { close: async () => { closes++; } };
    (client as any).client = { connect: async () => { throw new Error('dummy initialization failure'); }, close: async () => {} };
    await expect(client.listTools()).rejects.toThrow('dummy initialization failure');
    expect(closes).toBe(1);
    await client.close();
    expect(closes).toBe(1);
    expect(client.isConnected()).toBe(false);
  });
  test('simultaneous callers share one handshake and closing during initialization stays closed', async () => {
    const client = new CraftMcpClient({ transport: 'http', url: 'http://127.0.0.1:1/mcp' });
    let connects = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    (client as any).transport = { close: async () => {} };
    (client as any).client = { connect: async () => { connects++; await gate; }, listTools: async () => ({ tools: [] }), close: async () => {} };
    const first = client.connect();
    const second = client.connect();
    const settled = Promise.allSettled([first, second]);
    await client.close();
    release();
    const results = await settled;
    expect(results.every(result => result.status === 'rejected' && result.reason.message.includes('closed during connection'))).toBe(true);
    expect(connects).toBe(1);
    expect(client.isConnected()).toBe(false);
  });

  test('SDK close notification makes the wrapper terminal without repeating transport cleanup', async () => {
    const client = new CraftMcpClient({ transport: 'http', url: 'http://127.0.0.1:1/mcp' });
    const sdk = (client as any).client;
    let closes = 0;
    let notifications = 0;
    sdk.connect = async () => {};
    sdk.listTools = async () => ({ tools: [] });
    sdk.close = async () => {};
    (client as any).transport = { close: async () => { closes++; } };
    client.onclose = () => { notifications++; };
    await client.connect();
    expect(client.isConnected()).toBe(true);
    sdk.onclose();
    expect(client.isConnected()).toBe(false);
    expect(notifications).toBe(1);
    await expect(client.connect()).rejects.toThrow('MCP client is closed');
    await expect(client.callTool('unused', {})).rejects.toThrow('MCP client is closed');
    await Promise.all([client.close(), client.close()]);
    expect(closes).toBe(1);
  });

  test('SDK close during initialization cannot publish a connected client', async () => {
    const client = new CraftMcpClient({ transport: 'http', url: 'http://127.0.0.1:1/mcp' });
    const sdk = (client as any).client;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let closes = 0;
    sdk.connect = async () => { await gate; };
    sdk.listTools = async () => ({ tools: [] });
    sdk.close = async () => {};
    (client as any).transport = { close: async () => { closes++; } };
    const pending = client.connect();
    sdk.onclose();
    release();
    await expect(pending).rejects.toThrow('closed during connection');
    expect(client.isConnected()).toBe(false);
    await client.close();
    expect(closes).toBe(1);
  });
});

test('silent transport startup is bounded and closed without waiting for SDK initialize', async () => {
  const client = new CraftMcpClient({ transport: 'sse', url: 'http://127.0.0.1:1/sse', connectTimeoutMs: 20 });
  let closes = 0;
  (client as any).transport = { close: async () => { closes++; } };
  (client as any).client = { connect: async () => new Promise(() => {}), close: async () => {} };
  await expect(client.connect()).rejects.toThrow('MCP connection timed out');
  expect(closes).toBe(1);
  expect(client.isConnected()).toBe(false);
});
