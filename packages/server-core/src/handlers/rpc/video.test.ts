import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as config from '@tokenbird/shared/config'
import { RPC_CHANNELS } from '@tokenbird/shared/protocol'
import type { HandlerFn, RpcServer } from '@tokenbird/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { registerVideoHandlers } from './video'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'tokenbird-video-rpc-')) })
afterEach(async () => { mock.restore(); await rm(directory, { recursive: true, force: true }) })
function harness() {
  const workspaceId = randomUUID()
  spyOn(config, 'getWorkspaceByNameOrId').mockImplementation(value => value === workspaceId || value === 'alias' ? { id: workspaceId, rootPath: directory } as never : null)
  const handlers = new Map<string, HandlerFn>()
  registerVideoHandlers({ handle: (channel: string, handler: HandlerFn) => { handlers.set(channel, handler) } } as unknown as RpcServer, { sessionManager: {} } as HandlerDeps)
  const invoke = handlers.get(RPC_CHANNELS.video.EXECUTE)!
  return { workspaceId, invoke }
}
describe('Video RPC workspace boundary', () => {
  it('uses the bound workspace and rejects a stale or foreign requested workspace', async () => {
    const { workspaceId, invoke } = harness()
    const ctx = { clientId: 'client', workspaceId, webContentsId: null }
    await expect(invoke(ctx, { action: 'state', args: { workspaceId } })).resolves.toMatchObject({ version: 1, projects: [], memories: [] })
    await expect(invoke(ctx, { action: 'state', args: { workspaceId: 'foreign' } })).rejects.toThrow('其他工作区')
  })
  it('does not accept a user supplied workspace when the connection has no bound workspace', async () => {
    const { workspaceId, invoke } = harness()
    await expect(invoke({ clientId: 'client', workspaceId: null, webContentsId: null }, { action: 'state', args: { workspaceId } })).rejects.toThrow('连接工作区')
  })
})
