import { describe, expect, it } from 'bun:test';
import { NativeCodexAppServerClient } from './native-app-server-client.ts';

describe('NativeCodexAppServerClient routing', () => {
  it('routes notifications and server requests separately', () => {
    const client = new NativeCodexAppServerClient({ codexPath: 'unused', workDir: process.cwd() });
    const notifications: Array<[string, unknown]> = [];
    const requests: Array<{ id: string | number; method: string; params: unknown }> = [];
    client.on('notification', (method, params) => notifications.push([method, params]));
    client.on('serverRequest', request => requests.push(request));

    client.routeIncomingForTest({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 't1' } });
    client.routeIncomingForTest({ jsonrpc: '2.0', id: '7', method: 'item/tool/call', params: { tool: 'demo' } });

    expect(notifications).toEqual([['turn/started', { threadId: 't1' }]]);
    expect(requests).toEqual([{ id: '7', method: 'item/tool/call', params: { tool: 'demo' } }]);
  });
});
