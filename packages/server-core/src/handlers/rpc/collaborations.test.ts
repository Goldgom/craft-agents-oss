import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import { CollaborationManager } from '../../collaboration/CollaborationManager'
import type { HandlerDeps } from '../handler-deps'
import { registerCollaborationHandlers } from './collaborations'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(options?: { failSecondaryDelivery?: boolean; failMetadataSessionId?: string }) {
  const mainRoot = await mkdtemp(join(tmpdir(), 'craft-collaboration-rpc-'))
  const otherRoot = `${mainRoot}-other`
  roots.push(mainRoot, otherRoot)
  const manager = new CollaborationManager(workspaceId => workspaceId === 'main' ? mainRoot : otherRoot)
  const sessions = new Map<string, any>([
    ['primary-session', {
      id: 'primary-session',
      workspaceId: 'main',
      name: 'Primary',
      messages: [{ id: 'user-1', role: 'user', content: 'Build the release', timestamp: 123 }],
      isProcessing: false,
    }],
    ['secondary-session', {
      id: 'secondary-session',
      workspaceId: 'other',
      name: 'Secondary',
      messages: [],
      isProcessing: false,
    }],
  ])
  let failSecondaryDelivery = options?.failSecondaryDelivery ?? false
  const deliveries: Array<{ sessionId: string; message: string; options?: unknown }> = []
  const handlers = new Map<string, HandlerFn>()
  const pushes: Array<{ channel: string; target: unknown; args: unknown[] }> = []
  const server: RpcServer = {
    handle: (channel, handler) => { handlers.set(channel, handler) },
    push: (channel, target, ...args) => { pushes.push({ channel, target, args }) },
    invokeClient: async () => undefined,
    hasClientCapability: () => false,
    findClientsWithCapability: () => [],
  }
  const sessionManager = {
    getCollaborationManager: () => manager,
    getSession: async (sessionId: string) => sessions.get(sessionId) ?? null,
    getSessions: (workspaceId?: string) => [...sessions.values()].filter(session => !workspaceId || session.workspaceId === workspaceId),
    setSessionCollaboration: async (sessionId: string, collaboration: unknown) => {
      const session = sessions.get(sessionId)
      if (!session) throw new Error('missing session')
      session.collaboration = collaboration ?? undefined
      if (collaboration && sessionId === options?.failMetadataSessionId) throw new Error('metadata write failed')
    },
    sendMessage: async (sessionId: string, message: string, _files?: unknown, _mode?: unknown, sendOptions?: unknown) => {
      if (sessionId === 'secondary-session' && failSecondaryDelivery) throw new Error('temporary transport failure')
      deliveries.push({ sessionId, message, options: sendOptions })
    },
  }
  const deps = {
    sessionManager,
    platform: { logger: { warn: () => undefined } },
    windowManager: {
      getWorkspaceForWindow: (webContentsId: number) => ({ 1: 'main', 2: 'other', 3: 'outsider' })[webContentsId] ?? null,
    },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerCollaborationHandlers(server, deps)

  const invoke = async (channel: string, ctx: RequestContext, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`Handler not registered: ${channel}`)
    return handler(ctx, ...args)
  }
  const mainCtx: RequestContext = { clientId: 'main-client', workspaceId: 'main', webContentsId: 1 }
  const otherCtx: RequestContext = { clientId: 'other-client', workspaceId: 'other', webContentsId: 2 }
  const create = () => invoke(
    RPC_CHANNELS.collaborations.CREATE,
    mainCtx,
    'primary-session',
    [{ sessionId: 'secondary-session', workspaceId: 'other', name: 'Secondary' }],
  )

  return {
    manager,
    otherRoot,
    sessions,
    deliveries,
    pushes,
    invoke,
    create,
    mainCtx,
    otherCtx,
    setFailSecondaryDelivery: (value: boolean) => { failSecondaryDelivery = value },
  }
}

describe('collaboration RPC handlers', () => {
  it('seeds the current goal, activates the primary, indexes both workspaces, and ends cleanly', async () => {
    const f = await fixture()
    const group = await f.create()
    expect(group.board['goal.current']?.value).toMatchObject({ text: 'Build the release', status: 'active' })
    expect(f.deliveries).toHaveLength(1)
    expect(f.deliveries[0]).toMatchObject({ sessionId: 'primary-session', options: { hidden: true, collaborationDispatch: true } })
    expect((await f.manager.list('other')).map(item => item.id)).toEqual([group.id])
    await rm(join(f.otherRoot, '.craft-agent', 'collaborations', 'index', `${group.id}.json`))
    expect(await f.manager.list('other')).toEqual([])
    expect((await f.invoke(RPC_CHANNELS.collaborations.LIST, f.otherCtx, 'other')).map((item: { id: string }) => item.id)).toEqual([group.id])
    expect((await f.manager.list('other')).map(item => item.id)).toEqual([group.id])
    await expect(f.create()).rejects.toThrow('already belongs to a collaboration')

    const ended = await f.invoke(
      RPC_CHANNELS.collaborations.END,
      f.mainCtx,
      group.id,
      'main',
    )
    expect(ended.status).toBe('ended')
    expect(f.sessions.get('primary-session').collaboration).toBeUndefined()
    expect(f.sessions.get('secondary-session').collaboration).toBeUndefined()
  })

  it('limits reads to member workspaces and rejects stale actor metadata', async () => {
    const f = await fixture()
    const group = await f.create()
    const outsiderCtx: RequestContext = { clientId: 'outsider', workspaceId: 'outsider', webContentsId: 3 }
    await expect(f.invoke(RPC_CHANNELS.collaborations.GET, outsiderCtx, group.id, 'main'))
      .rejects.toThrow('not a member')

    f.sessions.get('primary-session').collaboration = undefined
    await expect(f.invoke(RPC_CHANNELS.collaborations.UPDATE_BOARD, f.mainCtx, {
      groupId: group.id,
      coordinatorWorkspaceId: 'main',
      actorMemberId: 'primary',
      itemId: 'status.primary',
      value: 'working',
      operationId: 'board-rpc-1',
      expectedRevision: group.revision,
    })).rejects.toThrow('stale or invalid')
  })

  it('rolls back the group and prior membership when creation is only partially persisted', async () => {
    const f = await fixture({ failMetadataSessionId: 'secondary-session' })
    await expect(f.create()).rejects.toThrow('metadata write failed')
    expect(f.sessions.get('primary-session').collaboration).toBeUndefined()
    expect(await f.manager.list('main')).toEqual([])
    expect(await f.manager.list('other')).toEqual([])
  })

  it('retries the same persisted request after delivery fails', async () => {
    const f = await fixture({ failSecondaryDelivery: true })
    const group = await f.create()
    const input = {
      groupId: group.id,
      coordinatorWorkspaceId: 'main',
      actorMemberId: 'primary',
      targetMemberId: 'secondary_1',
      message: 'Inspect the API',
      operationId: 'request-rpc-1',
      expectedRevision: group.revision,
    }
    await expect(f.invoke(RPC_CHANNELS.collaborations.REQUEST, f.mainCtx, input))
      .rejects.toThrow('temporary transport failure')
    const failed = await f.manager.open(group.id, 'main')
    expect(failed.events.find(event => event.operationId === input.operationId)?.delivery)
      .toMatchObject({ status: 'failed', attempts: 1 })

    f.setFailSecondaryDelivery(false)
    const retried = await f.invoke(RPC_CHANNELS.collaborations.REQUEST, f.mainCtx, input)
    expect(retried).toMatchObject({ applied: false, delivery: 'delivered' })
    expect(retried.group.events.find((event: any) => event.operationId === input.operationId)?.delivery)
      .toMatchObject({ status: 'delivered', attempts: 2 })
    expect(f.deliveries.filter(item => item.sessionId === 'secondary-session')).toHaveLength(1)
  })

  it('serializes concurrent creates so a session cannot enter overlapping groups', async () => {
    const f = await fixture()
    const results = await Promise.allSettled([f.create(), f.create()])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await f.manager.list('main')).toHaveLength(1)
  })

  it('rejects remote members until an authenticated relay exists', async () => {
    const f = await fixture()
    await expect(f.invoke(
      RPC_CHANNELS.collaborations.CREATE,
      f.mainCtx,
      'primary-session',
      [{ sessionId: 'remote-session', workspaceId: 'remote', serverUrl: 'wss://remote.example' }],
    )).rejects.toThrow('authenticated relay')
    expect(await f.manager.list('main')).toEqual([])
  })

  it('keeps headless candidate discovery and creation inside the connected workspace', async () => {
    const f = await fixture()
    const headlessCtx: RequestContext = { clientId: 'headless', workspaceId: 'main', webContentsId: null }
    const candidates = await f.invoke(RPC_CHANNELS.collaborations.LIST_CANDIDATES, headlessCtx)
    expect(candidates.map((session: { workspaceId: string }) => session.workspaceId)).toEqual(['main'])
    await expect(f.invoke(
      RPC_CHANNELS.collaborations.CREATE,
      headlessCtx,
      'primary-session',
      [{ sessionId: 'secondary-session', workspaceId: 'other' }],
    )).rejects.toThrow('trusted local desktop client')
  })
})
