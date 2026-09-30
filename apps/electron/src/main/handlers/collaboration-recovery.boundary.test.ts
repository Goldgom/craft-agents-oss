import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebSocket } from 'ws'
import { RPC_CHANNELS, type CollaborationCreateResult, type Session } from '@craft-agent/shared/protocol'
import { WsRpcClient, WsRpcServer, type RequestContext, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '@craft-agent/server-core/handlers'
import { registerCollaborationHandlers } from '@craft-agent/server-core/handlers/rpc/collaborations'
import { CollaborationManager } from '../../../../../packages/server-core/src/collaboration/CollaborationManager'
import { registerRemoteCollaborationIpcHandlers, REMOTE_COLLABORATION_IPC, type CollaborationIpcRegistrar } from './collaboration-remote'
import { createNativeWindowAuthority } from '../native-window-authority'
import { connectToRemote } from './workspace'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 2_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tokenbird-collaboration-recovery-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const manager = new CollaborationManager(() => root)
  cleanup.push(() => manager.cleanup())
  const session = (id: string): Session => ({
    id, workspaceId: 'main', workspaceName: 'Synthetic recovery', name: id,
    isProcessing: false, lastMessageAt: 0, messages: [],
  })
  const sessions = new Map(['primary', 'secondary'].map(id => [id, session(id)]))
  const deliveries: string[] = []
  const deleted: string[] = []
  const warnings: unknown[][] = []
  let nextSessionId = 0
  const hooks = {
    beforeResponse: undefined as ((channel: string, ctx: RequestContext, result: unknown) => Promise<void>) | undefined,
    metadata: undefined as ((id: string, membership: Session['collaboration'] | null) => Promise<void>) | undefined,
    send: undefined as ((id: string) => Promise<void>) | undefined,
    delete: undefined as ((id: string) => Promise<void>) | undefined,
  }
  const deps = {
    sessionManager: {
      getCollaborationManager: () => manager,
      getWorkspaces: () => [{ id: 'main', name: 'Synthetic recovery' }],
      getSession: async (id: string) => sessions.get(id) ?? null,
      getSessions: () => [...sessions.values()],
      createSession: async (_workspaceId: string, options: { name?: string }) => {
        const created = { ...session(`new-${++nextSessionId}`), name: options.name }
        sessions.set(created.id, created)
        return created
      },
      setSessionCollaboration: async (id: string, membership: Session['collaboration'] | null) => {
        sessions.get(id)!.collaboration = membership ?? undefined
        await hooks.metadata?.(id, membership)
      },
      deleteSession: async (id: string) => {
        deleted.push(id)
        await hooks.delete?.(id)
        sessions.delete(id)
      },
      sendMessage: async (id: string) => {
        await hooks.send?.(id)
        deliveries.push(id)
      },
    },
    platform: { logger: { warn: (...args: unknown[]) => warnings.push(args) } },
  } as unknown as HandlerDeps
  const token = 'synthetic-loopback-recovery-token'
  const server = new WsRpcServer({
    host: '127.0.0.1', port: 0, requireAuth: true,
    validateToken: async value => value === token,
    resolveWorkspaceId: value => value === 'main' ? value : null,
  })
  const wrapped: RpcServer = {
    handle: (channel, handler) => server.handle(channel, async (ctx, ...args) => {
      const result = await handler(ctx, ...args)
      await hooks.beforeResponse?.(channel, ctx, result)
      return result
    }),
    push: server.push.bind(server),
    invokeClient: server.invokeClient.bind(server),
    hasClientCapability: server.hasClientCapability.bind(server),
    findClientsWithCapability: server.findClientsWithCapability.bind(server),
  }
  registerCollaborationHandlers(wrapped, deps)
  await server.listen()
  cleanup.push(() => server.close())
  const profile = { url: `ws://127.0.0.1:${server.port}`, token }
  const clients: WsRpcClient[] = []
  async function connect(_url?: string, _token?: string, _workspaceId?: string, options?: { beforeHandshake: () => Promise<void> }) {
    const result = await connectToRemote(profile.url, profile.token, 'main', { requestTimeout: 2_000, beforeHandshake: options?.beforeHandshake })
    if (!result.client) throw new Error(result.error ?? 'Synthetic server connection failed')
    clients.push(result.client)
    cleanup.push(() => result.client!.destroy())
    return result
  }
  const handlers = new Map<string, Parameters<CollaborationIpcRegistrar['handle']>[1]>()
  const sender = { id: 7, mainFrame: { url: 'file:///app/index.html', processId: 1, routingId: 7 }, getURL: () => 'file:///app/index.html', isDestroyed: () => false }
  const event = { sender, senderFrame: sender.mainFrame }
  const assertSender = createNativeWindowAuthority({ getWindowByWebContentsId: id => id === 7 ? { webContents: sender } : null, getWorkspaceForWindow: () => 'local' }, ['file:///app/index.html'])
  registerRemoteCollaborationIpcHandlers({ handle: (channel, handler) => { handlers.set(channel, handler) } }, {
    getProfile: id => id === 'saved-profile' ? profile : undefined,
    assertSender,
    connect,
    openWorkspace: async () => ({ ok: true }),
  })
  const invokeNative = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, 'saved-profile', 'main', ...args)
  const create = () => invokeNative(REMOTE_COLLABORATION_IPC.CREATE, 'primary', [{ sessionId: 'secondary', workspaceId: 'main' }]) as Promise<CollaborationCreateResult>
  // Fault injection only: terminate one real server socket before its response
  // can reach the requesting client, without shutting down unrelated clients.
  function drop(ctx: RequestContext) {
    const sockets = (server as unknown as { clients: Map<string, { ws: WebSocket }> }).clients
    sockets.get(ctx.clientId)!.ws.terminate()
  }
  return { root, manager, server, profile, sessions, deliveries, deleted, warnings, hooks, clients, connect, invokeNative, create, drop }
}

describe('collaboration interruption and retry boundaries over real loopback WebSockets', () => {
  it('isolates a dropped saved-profile discovery from another in-flight call and reconnects on retry', async () => {
    const f = await fixture()
    const entered = deferred()
    const release = deferred()
    let calls = 0
    f.hooks.beforeResponse = async (channel, ctx) => {
      if (channel === RPC_CHANNELS.collaborations.LIST_CANDIDATES && ++calls === 1) {
        entered.resolve()
        await release.promise
        f.drop(ctx)
      }
    }
    const first = f.invokeNative(REMOTE_COLLABORATION_IPC.CANDIDATES).then(() => null, error => error)
    await entered.promise
    const second = await f.invokeNative(REMOTE_COLLABORATION_IPC.CANDIDATES) as Session[]
    expect(second.map(item => item.id)).toEqual(['primary', 'secondary'])
    release.resolve()
    expect(String(await first)).toContain('Connection lost')
    expect(await f.invokeNative(REMOTE_COLLABORATION_IPC.CANDIDATES)).toHaveLength(2)
    await until(() => f.server.getConnectedClientCount() === 0, 'one-shot clients to close')
    expect(f.clients).toHaveLength(3)
    expect(f.clients.every(client => client.getConnectionState().lastError?.code === 'CLIENT_DESTROYED')).toBe(true)
  })

  it('does not duplicate a committed collaboration after its creation acknowledgment is lost', async () => {
    const f = await fixture()
    let lost = false
    f.hooks.beforeResponse = async (channel, ctx) => {
      if (channel === RPC_CHANNELS.collaborations.CREATE && !lost) { lost = true; f.drop(ctx) }
    }
    await expect(f.create()).rejects.toThrow('Connection lost')
    const groups = await new CollaborationManager(() => f.root).list('main')
    expect(groups).toHaveLength(1)
    await expect(f.create()).rejects.toThrow('already belongs to a collaboration')
    expect(await f.manager.list('main')).toHaveLength(1)
    expect(f.deliveries).toEqual(['primary'])
    const candidates = await f.invokeNative(REMOTE_COLLABORATION_IPC.CANDIDATES) as Session[]
    expect(candidates.find(item => item.id === 'primary')?.collaboration?.groupId).toBe(groups[0]!.id)
  })

  it('replays a delivered request with the same operation ID after losing its acknowledgment without redelivery', async () => {
    const f = await fixture()
    const group = await f.create()
    expect(group.activationStatus).toBe('started')
    const input = {
      groupId: group.id, coordinatorWorkspaceId: 'main', actorMemberId: 'primary',
      targetMemberId: 'secondary_1', message: 'Check only the synthetic fixture',
      operationId: 'lost-request-ack', expectedRevision: group.revision,
    }
    let lost = false
    f.hooks.beforeResponse = async (channel, ctx) => {
      if (channel === RPC_CHANNELS.collaborations.REQUEST && !lost) { lost = true; f.drop(ctx) }
    }
    const first = (await f.connect()).client!
    await expect(first.invoke(RPC_CHANNELS.collaborations.REQUEST, input)).rejects.toThrow('Connection lost')
    first.destroy()
    const second = (await f.connect()).client!
    const retried = await second.invoke(RPC_CHANNELS.collaborations.REQUEST, input)
    expect(retried).toMatchObject({ applied: false, delivery: 'delivered' })
    expect(retried.group.events.filter((event: { operationId: string }) => event.operationId === input.operationId)).toHaveLength(1)
    expect(retried.group.events.find((event: { operationId: string }) => event.operationId === input.operationId).delivery).toMatchObject({ status: 'delivered', attempts: 1 })
    await expect(second.invoke(RPC_CHANNELS.collaborations.RETRY_DELIVERY, group.id, 'main', input.operationId)).resolves.toMatchObject({ delivery: 'delivered' })
    expect(f.deliveries).toEqual(['primary', 'secondary'])
  })

  it('keeps one delivery in flight when the client is destroyed and a new client retries', async () => {
    const f = await fixture()
    const group = await f.create()
    const entered = deferred()
    const release = deferred()
    cleanup.push(release.resolve)
    f.hooks.send = async id => { if (id === 'secondary') { entered.resolve(); await release.promise } }
    const input = {
      groupId: group.id, coordinatorWorkspaceId: 'main', actorMemberId: 'primary',
      targetMemberId: 'secondary_1', message: 'Hold until explicitly released',
      operationId: 'interrupted-request', expectedRevision: group.revision,
    }
    const first = (await f.connect()).client!
    const original = first.invoke(RPC_CHANNELS.collaborations.REQUEST, input).then(() => null, error => error)
    await entered.promise
    first.destroy()
    expect(String(await original)).toContain('Client destroyed')
    const second = (await f.connect()).client!
    const whilePending = await second.invoke(RPC_CHANNELS.collaborations.REQUEST, input)
    expect(whilePending).toMatchObject({ applied: false, delivery: 'delivering' })
    expect(f.deliveries).toEqual(['primary'])
    release.resolve()
    await until(async () => (await f.manager.open(group.id, 'main')).events.find(event => event.operationId === input.operationId)?.delivery?.status === 'delivered', 'the server-side operation to settle')
    await expect(second.invoke(RPC_CHANNELS.collaborations.RETRY_DELIVERY, group.id, 'main', input.operationId)).resolves.toMatchObject({ delivery: 'delivered' })
    expect(f.deliveries).toEqual(['primary', 'secondary'])
    expect(first.getConnectionState().lastError?.code).toBe('CLIENT_DESTROYED')
  })

  it('rolls back an interrupted partial creation before allowing an already queued retry', async () => {
    const f = await fixture()
    const entered = deferred()
    const release = deferred()
    cleanup.push(release.resolve)
    let failed = false
    f.hooks.metadata = async (id, membership) => {
      if (id === 'new-1' && membership && !failed) {
        failed = true
        entered.resolve()
        await release.promise
        throw new Error('Injected partial metadata write failure')
      }
    }
    const first = (await f.connect()).client!
    const original = first.invoke(RPC_CHANNELS.collaborations.CREATE, 'primary', [{ createNew: true, workspaceId: 'main' }]).then(() => null, error => error)
    await entered.promise
    first.destroy()
    expect(String(await original)).toContain('Client destroyed')
    const retry = f.create()
    release.resolve()
    const group = await retry
    expect(group.members.map(member => member.sessionId)).toEqual(['primary', 'secondary'])
    expect(f.deleted).toEqual(['new-1'])
    expect(f.sessions.has('new-1')).toBe(false)
    expect(f.sessions.get('primary')?.collaboration?.groupId).toBe(group.id)
    expect((await new CollaborationManager(() => f.root).list('main')).map(item => item.id)).toEqual([group.id])
    expect(f.deliveries).toEqual(['primary'])
  })

  it('keeps a successfully persisted creation when primary activation fails and does not recreate it on retry', async () => {
    const f = await fixture()
    f.hooks.send = async () => { throw new Error('Injected activation failure: dummy-provider-secret') }
    const group = await f.create()
    expect(group.activationStatus).toBe('failed')
    const restored = await new CollaborationManager(() => f.root).list('main')
    expect(restored.map(item => item.id)).toEqual([group.id])
    expect(restored[0]).not.toHaveProperty('activationStatus')
    expect(JSON.stringify(group)).not.toContain('Injected activation failure')
    expect(JSON.stringify(f.warnings)).not.toContain('dummy-provider-secret')
    expect(f.warnings[0]?.[1]).toEqual({ groupId: group.id, primarySessionId: 'primary' })
    expect(f.warnings.map(args => args[0])).toEqual(['Collaboration created but the primary activation message could not be delivered'])
    await expect(f.create()).rejects.toThrow('already belongs to a collaboration')
    expect(f.deleted).toEqual([])
    expect(f.sessions.get('secondary')?.collaboration?.groupId).toBe(group.id)
  })

  it('continues independent cleanup after a deletion fails and preserves the original creation error', async () => {
    const f = await fixture()
    f.hooks.metadata = async (id, membership) => {
      if (id === 'new-2' && membership) throw new Error('Original metadata failure')
    }
    f.hooks.delete = async id => { if (id === 'new-1') throw new Error('Injected cleanup failure') }
    await expect(f.invokeNative(REMOTE_COLLABORATION_IPC.CREATE, 'primary', [
      { createNew: true, workspaceId: 'main' }, { createNew: true, workspaceId: 'main' },
    ])).rejects.toThrow('Original metadata failure')
    expect(f.deleted.sort()).toEqual(['new-1', 'new-2'])
    expect(f.sessions.has('new-2')).toBe(false)
    expect(f.sessions.get('new-1')?.collaboration).toBeUndefined()
    expect(f.sessions.get('primary')?.collaboration).toBeUndefined()
    expect(await f.manager.list('main')).toEqual([])
    expect(f.warnings.map(args => args[0])).toEqual(['Collaboration creation cleanup failed'])
    // A failed deletion leaves an unattached session and a warning; it does not
    // poison the per-manager creation queue or attach it to the next attempt.
    const retried = await f.create()
    expect(retried.members.map(member => member.sessionId)).toEqual(['primary', 'secondary'])
  })
})
