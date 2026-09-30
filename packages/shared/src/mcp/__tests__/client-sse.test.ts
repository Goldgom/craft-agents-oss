import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CraftMcpClient } from '../client.ts';
import { validateMcpConnection } from '../validation.ts';

test('SSE transport sends dummy authentication on event stream and POST messages', async () => {
  const protocols: Server[] = [];
  const transports = new Map<string, SSEServerTransport>();
  const headers: Array<{ method?: string; auth?: string; accept?: string }> = [];
  const http = createServer(async (request, response) => {
    headers.push({ method: request.method, auth: request.headers.authorization, accept: request.headers.accept });
    if (request.method === 'GET' && request.url === '/sse') {
      // Validation and the runtime client open separate connections. Give each
      // its own protocol instead of racing a previous connection's close event.
      const protocol = new Server({ name: 'dummy-server', version: '1.0.0' }, { capabilities: { tools: {} } });
      protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'dummy_tool', inputSchema: { type: 'object' } }] }));
      const transport = new SSEServerTransport('/messages', response);
      protocols.push(protocol);
      transports.set(transport.sessionId, transport);
      await protocol.connect(transport);
    } else if (request.method === 'POST') {
      const sessionId = new URL(request.url ?? '/', 'http://localhost').searchParams.get('sessionId');
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (transport) await transport.handlePostMessage(request, response);
      else response.writeHead(404).end();
    } else { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing local test address');
  const client = new CraftMcpClient({ transport: 'sse', url: `http://127.0.0.1:${address.port}/sse`, headers: { Authorization: 'Bearer dummy-token', Accept: 'application/json' } });
  try {
    const validated = await validateMcpConnection({ mcpUrl: `http://127.0.0.1:${address.port}/sse`, mcpTransport: 'sse', mcpAccessToken: 'dummy-token' });
    expect(validated.success).toBe(true);
    expect(validated.tools).toEqual(['dummy_tool']);
    expect((await client.listTools()).map(tool => tool.name)).toEqual(['dummy_tool']);
    expect(client.transportType).toBe('sse');
    expect(headers.find(entry => entry.method === 'GET')?.accept).toBe('text/event-stream');
    expect(headers.some(entry => entry.method === 'POST')).toBe(true);
    expect(headers.every(entry => entry.auth === 'Bearer dummy-token')).toBe(true);
  } finally {
    await client.close();
    await Promise.all(protocols.map(protocol => protocol.close()));
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
});
