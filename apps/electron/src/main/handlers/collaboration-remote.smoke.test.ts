import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RPC_CHANNELS, type CollaborationGroup, type Session } from '@craft-agent/shared/protocol'
import { WsRpcServer, WsRpcClient } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '@craft-agent/server-core/handlers'
import { registerCollaborationHandlers } from '@craft-agent/server-core/handlers/rpc/collaborations'
import { CollaborationManager } from '../../../../../packages/server-core/src/collaboration/CollaborationManager'
import { registerRemoteCollaborationIpcHandlers, REMOTE_COLLABORATION_IPC, type CollaborationIpcRegistrar } from './collaboration-remote'
import { createNativeWindowAuthority } from '../native-window-authority'
import { connectToRemote } from './workspace'
import { registerLocalCollaborationIpcHandlers, LOCAL_COLLABORATION_IPC } from './collaboration-local'

function nativeFixture(id: number, workspaceId: string) {
  const sender = { id, mainFrame: { url: 'file:///app/index.html', processId: 1, routingId: id }, getURL: () => 'file:///app/index.html', isDestroyed: () => false }
  return { event: { sender, senderFrame: sender.mainFrame }, assertSender: createNativeWindowAuthority({ getWindowByWebContentsId: value => value === id ? { webContents: sender } : null, getWorkspaceForWindow: () => workspaceId }, ['file:///app/index.html']) }
}

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function startSyntheticServer(name: string, withOtherWorkspace = false) {
  const root = await mkdtemp(join(tmpdir(), 'tokenbird-collaboration-smoke-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const manager = new CollaborationManager(workspaceId => workspaceId === 'main' ? root : join(root, workspaceId))
  const session = (id: string): Session => ({ id, workspaceId: 'main', workspaceName: name, name: `${name} ${id}`, isProcessing: false, lastMessageAt: 0, messages: [{ id: 'goal', role: 'user', content: `Verify ${name}`, timestamp: 1 }] })
  const sessions = new Map([['primary', session('primary')], ['secondary', session('secondary')]])
  if (withOtherWorkspace) sessions.set('other-session', { ...session('other-session'), workspaceId: 'other' })
  const messages: string[] = []
  const deps = {
    sessionManager: {
      getCollaborationManager: () => manager,
      getWorkspaces: () => [{ id: 'main', name }, ...(withOtherWorkspace ? [{ id: 'other', name: 'Other' }] : [])],
      getSession: async (id: string) => sessions.get(id) ?? null,
      getSessions: (workspaceId?: string) => [...sessions.values()].filter(item => !workspaceId || item.workspaceId === workspaceId),
      createSession: async (workspaceId: string, options: { name?: string }) => {
        const result = { ...session(`new-${sessions.size}`), workspaceId, name: options.name, messages: [] }
        sessions.set(result.id, result)
        return result
      },
      deleteSession: async (id: string) => { sessions.delete(id) },
      setSessionCollaboration: async (id: string, membership: Session['collaboration']) => { sessions.get(id)!.collaboration = membership },
      sendMessage: async (_id: string, message: string) => { messages.push(message) },
    },
    platform: { logger: { warn: () => undefined } },
    windowManager: { getWorkspaceForWindow: (id: number) => id === 7 ? 'main' : null },
  } as unknown as HandlerDeps
  const token = `synthetic-${name}-token-for-local-smoke-only`
  const server = new WsRpcServer({ host: '127.0.0.1', port: 0, requireAuth: true, validateToken: async value => value === token, resolveWorkspaceId: id => id === 'main' ? id : null, serverId: name })
  registerCollaborationHandlers(server, deps)
  await server.listen()
  cleanup.push(() => server.close())
  return { root, manager, sessions, messages, deps, server, profile: { url: `ws://127.0.0.1:${server.port}`, token } }
}

describe('collaboration real-transport smoke with synthetic servers', () => {
  it('does not expose saved-profile IPC to an authenticated WebSocket client that spoofs a desktop window ID', async () => {
    const remote = await startSyntheticServer('spoof-target', true)
    const client = new WsRpcClient(remote.profile.url, {
      token: remote.profile.token, workspaceId: 'main', webContentsId: 7, autoReconnect: false,
    })
    cleanup.push(() => client.destroy())
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Handshake timeout')), 2000)
      const off = client.onConnectionStateChanged(state => {
        if (state.status === 'connected') { clearTimeout(timer); off(); resolve() }
        else if (state.status === 'failed') { clearTimeout(timer); off(); reject(new Error('Handshake failed')) }
      })
      client.connect()
    })
    for (const channel of [...Object.values(REMOTE_COLLABORATION_IPC), ...Object.values(LOCAL_COLLABORATION_IPC)]) {
      // Settle the nested RPC promise before Bun's matcher inspects it.
      const denied = await client.invoke(channel, 'saved-profile', 'main', 'primary', [{ createNew: true, workspaceId: 'main' }]).then(() => null, error => error)
      expect(denied).toBeInstanceOf(Error)
      expect(denied.code).toBe('CHANNEL_NOT_FOUND')
    }
    expect(await client.invoke(RPC_CHANNELS.collaborations.LIST_WORKSPACES)).toEqual([{ id: 'main', name: 'spoof-target' }])
    const visible = await client.invoke(RPC_CHANNELS.collaborations.LIST_CANDIDATES) as Session[]
    expect(visible.map(session => session.workspaceId)).toEqual(['main', 'main'])
    const crossWorkspace = await client.invoke(RPC_CHANNELS.collaborations.CREATE, 'primary', [{ createNew: true, workspaceId: 'other' }]).then(() => null, error => error)
    expect(crossWorkspace).toBeInstanceOf(Error)
    expect(crossWorkspace.message).toContain('trusted local desktop')
    expect(remote.messages).toEqual([])
    expect(remote.sessions.size).toBe(3)
    expect(await remote.manager.list('main')).toEqual([])
  })

  it('preserves cross-workspace creation through native IPC with server-derived workspace authority', async () => {
    const local = await startSyntheticServer('native-desktop', true)
    const handlers = new Map<string, Parameters<CollaborationIpcRegistrar['handle']>[1]>()
    const native = nativeFixture(7, 'main')
    registerLocalCollaborationIpcHandlers({ handle: (channel, fn) => { handlers.set(channel, fn) } }, local.server, local.deps, native.assertSender)
    const event = native.event
    expect(await handlers.get(LOCAL_COLLABORATION_IPC.WORKSPACES)!(event)).toEqual([{ id: 'main', name: 'native-desktop' }, { id: 'other', name: 'Other' }])
    const candidates = await handlers.get(LOCAL_COLLABORATION_IPC.CANDIDATES)!(event) as Session[]
    expect(candidates.some(session => session.workspaceId === 'other')).toBe(true)
    await expect(handlers.get(LOCAL_COLLABORATION_IPC.CREATE)!({ sender: { id: 999 } }, 'primary', [{ createNew: true, workspaceId: 'other' }])).rejects.toThrow('local workspace window')
    const group = await handlers.get(LOCAL_COLLABORATION_IPC.CREATE)!(event, 'primary', [{ createNew: true, workspaceId: 'other', name: 'Cross-workspace helper' }]) as CollaborationGroup
    expect(group.members.map(member => member.workspaceId)).toEqual(['main', 'other'])
    expect(local.sessions.get('new-3')?.name).toBe('Cross-workspace helper')
    expect(local.messages).toHaveLength(1)
  })

  it('selects the correct saved server despite overlapping IDs, creates durable new members and activates only its primary', async () => {
    const first = await startSyntheticServer('first')
    const second = await startSyntheticServer('second')
    const handlers = new Map<string, Parameters<CollaborationIpcRegistrar['handle']>[1]>()
    const native = nativeFixture(7, 'desktop-workspace')
    registerRemoteCollaborationIpcHandlers({ handle: (channel, fn) => { handlers.set(channel, fn) } }, {
      getProfile: id => id === 'first' ? first.profile : id === 'second' ? second.profile : undefined,
      connect: connectToRemote,
      assertSender: native.assertSender,
      openWorkspace: async () => ({ ok: true }),
    })
    const ctx = native.event
    const candidates = await handlers.get(REMOTE_COLLABORATION_IPC.CANDIDATES)!(ctx, 'second', 'main') as Session[]
    expect(candidates.map(item => item.name)).toEqual(['second primary', 'second secondary'])
    const group = await handlers.get(REMOTE_COLLABORATION_IPC.CREATE)!(ctx, 'second', 'main', 'primary', [
      { sessionId: 'secondary', workspaceId: 'main' },
      { createNew: true, workspaceId: 'main', name: 'Fresh collaborator' },
    ]) as CollaborationGroup
    expect(group.members).toHaveLength(3)
    expect(second.sessions.get('new-2')?.name).toBe('Fresh collaborator')
    expect(second.messages).toHaveLength(1)
    expect(first.messages).toEqual([])
    expect(first.sessions.get('primary')?.collaboration).toBeUndefined()
    expect(await first.manager.list('main')).toEqual([])
    // Re-open with a fresh coordinator to verify durable state, not just the RPC return.
    const restored = await new CollaborationManager(() => second.root).open(group.id, 'main')
    expect(restored.board['goal.current']?.value).toMatchObject({ text: 'Verify second' })
    expect(restored.members.map(item => item.sessionId)).toEqual(['primary', 'secondary', 'new-2'])
  })
})

it('local native collaboration rejects same-id impostor and iframe objects despite an otherwise registered window', async () => {
  const local = await startSyntheticServer('native-authority', true)
  const handlers = new Map<string, Parameters<CollaborationIpcRegistrar['handle']>[1]>()
  const native = nativeFixture(7, 'main')
  registerLocalCollaborationIpcHandlers({ handle: (channel, fn) => { handlers.set(channel, fn) } }, local.server, local.deps, native.assertSender)
  for (const event of [
    { sender: { ...native.event.sender }, senderFrame: native.event.senderFrame },
    { sender: native.event.sender, senderFrame: { ...native.event.senderFrame } },
  ]) await expect(handlers.get(LOCAL_COLLABORATION_IPC.CREATE)!(event, 'primary', [{ createNew: true, workspaceId: 'other' }])).rejects.toThrow('trusted local workspace')
  expect(local.sessions.size).toBe(3); expect(local.messages).toEqual([])
  expect(await handlers.get(LOCAL_COLLABORATION_IPC.WORKSPACES)!(native.event)).toEqual([{ id: 'main', name: 'native-authority' }, { id: 'other', name: 'Other' }])
})
