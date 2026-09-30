import { expect, test } from 'bun:test';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { registerSourcesHandlers } from '../sources.ts';
import type { RpcServer } from '../../../transport/types.ts';
import type { HandlerDeps } from '../../handler-deps.ts';

test('both source credential endpoints reject absent or mismatched connected workspaces before any lookup/write', async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const server = { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) } as unknown as RpcServer;
  registerSourcesHandlers(server, { platform: { logger: { info() {}, warn() {}, error() {} } } } as unknown as HandlerDeps);
  for (const context of [{ clientId: 'dummy' }, { clientId: 'dummy', workspaceId: 'other-workspace' }]) {
    await expect(handlers.get(RPC_CHANNELS.sources.SAVE_CREDENTIALS)!(context, 'dummy-workspace', 'dummy-source', 'dummy-token')).rejects.toThrow('connected workspace');
    await expect(handlers.get(RPC_CHANNELS.sources.SAVE_CREDENTIALS_BATCH)!(context, 'dummy-workspace', [{ sourceSlug: 'dummy-source', credential: 'dummy-token' }])).rejects.toThrow('connected workspace');
  }
});
