import { describe, expect, it } from 'bun:test'
import { createNativeWindowAuthority, advanceNativeWindowBinding } from '../native-window-authority'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { registerRemoteCollaborationIpcHandlers, REMOTE_COLLABORATION_IPC, type CollaborationIpcRegistrar } from './collaboration-remote'

function fixture(options?: { failConnect?: boolean; failInvoke?: boolean; echoToken?: boolean; response?: unknown }) {
  const sender = { id: 1, mainFrame: { url: 'file:///app/index.html', processId: 1, routingId: 1 }, getURL: () => 'file:///app/index.html', isDestroyed: () => false }
  const event = { sender, senderFrame: sender.mainFrame }
  const authority = createNativeWindowAuthority({ getWindowByWebContentsId: id => id === 1 ? { webContents: sender } : null, getWorkspaceForWindow: () => 'local-workspace' }, ['file:///app/index.html'])
  const profile = { url: 'wss://saved.example', token: 'synthetic-test-token', revision: 'one' }
  const hooks = { resolve: async () => {}, connect: async () => {}, invoke: async () => {} }
  const handlers = new Map<string, Parameters<CollaborationIpcRegistrar['handle']>[1]>()
  const connections: unknown[][] = []
  const calls: unknown[][] = []
  let destroyed = 0
  const server: CollaborationIpcRegistrar = { handle: (channel, handler) => { handlers.set(channel, handler) } }
  registerRemoteCollaborationIpcHandlers(server, {
    getProfile: async id => { await hooks.resolve(); return id === 'saved-profile' ? { ...profile } : undefined },
    assertSender: authority,
    openWorkspace: async () => ({ ok: true }),
    connect: async (...args) => {
      connections.push(args.slice(0, 3)); await hooks.connect(); await args[3].beforeHandshake()
      return options?.failConnect ? { client: null, error: options?.echoToken ? 'offline synthetic-test-token' : 'offline' } : {
        error: null,
        client: {
          invoke: async (...args: unknown[]) => { calls.push(args); await hooks.invoke(); if (options?.failInvoke) throw new Error(options?.echoToken ? 'remote rejected synthetic-test-token' : 'remote rejected'); return options?.response ?? (args[0] === RPC_CHANNELS.server.GET_WORKSPACES ? [{ id: 'main', name: 'Main', secret: 'must-not-leak' }, { id: 'stub', name: 'Stub', remoteServer: { token: 'must-not-leak' } }] : { ok: true }) },
          destroy: () => { destroyed++ },
        },
      }
    },
  })
  const invoke = (channel: string, args: unknown[], trusted = true) => Promise.resolve().then(() => handlers.get(channel)!(trusted ? event : { sender: { id: 999 } }, ...args))
  return { invoke, connections, calls, destroyed: () => destroyed, handlers, event, sender, profile, hooks, changeWindow: () => advanceNativeWindowBinding(sender) }
}

describe('saved-server collaboration routing', () => {
  it('limits discovery to hosted workspace names and never exposes remote config', async () => {
    const f = fixture()
    const result = await f.invoke(REMOTE_COLLABORATION_IPC.WORKSPACES, ['saved-profile'])
    expect(result).toEqual([{ id: 'main', name: 'Main' }])
    expect(f.connections).toEqual([['wss://saved.example', 'synthetic-test-token', undefined]])
    expect(f.destroyed()).toBe(1)
  })

  it('uses only saved credentials, binds the selected workspace, and closes discovery connections', async () => {
    const f = fixture()
    await f.invoke(REMOTE_COLLABORATION_IPC.CANDIDATES, ['saved-profile', 'remote-workspace'])
    expect(f.connections).toEqual([['wss://saved.example', 'synthetic-test-token', 'remote-workspace']])
    expect(f.calls).toEqual([[RPC_CHANNELS.collaborations.LIST_CANDIDATES]])
    expect(f.destroyed()).toBe(1)
  })

  it('routes creation with an explicit primary on the selected server and no caller token or URL', async () => {
    const f = fixture()
    const secondaries = [{ createNew: true, workspaceId: 'remote-workspace', name: 'Research' }]
    await f.invoke(REMOTE_COLLABORATION_IPC.CREATE, ['saved-profile', 'remote-workspace', 'remote-primary', secondaries])
    expect(f.calls).toEqual([[RPC_CHANNELS.collaborations.CREATE, 'remote-primary', secondaries]])
    expect(f.destroyed()).toBe(1)
  })

  it('rejects arbitrary URLs, untrusted callers and mixed-server/workspace members before connecting', async () => {
    const f = fixture()
    await expect(f.invoke(REMOTE_COLLABORATION_IPC.CANDIDATES, ['wss://arbitrary.example', 'remote-workspace'])).rejects.toThrow('profile not found')
    await expect(f.invoke(REMOTE_COLLABORATION_IPC.CANDIDATES, ['saved-profile', 'remote-workspace'], false)).rejects.toThrow('trusted local desktop')
    for (const item of [{ sessionId: 'other', workspaceId: 'wrong' }, { createNew: true, workspaceId: 'remote-workspace', serverUrl: 'wss://elsewhere.example' }]) {
      await expect(f.invoke(REMOTE_COLLABORATION_IPC.CREATE, ['saved-profile', 'remote-workspace', 'remote-primary', [item]])).rejects.toThrow('selected server and workspace')
    }
    expect(f.connections).toEqual([])
  })

  it('redacts saved credentials from connection and remote-handler errors', async () => {
    for (const options of [{ failConnect: true, echoToken: true }, { failInvoke: true, echoToken: true }]) {
      const f = fixture(options)
      try {
        await f.invoke(REMOTE_COLLABORATION_IPC.CANDIDATES, ['saved-profile', 'remote-workspace'])
        throw new Error('Expected a synthetic connection failure')
      } catch (error) {
        expect(String(error)).toContain('[redacted]')
        expect(String(error)).not.toContain('synthetic-test-token')
        expect((error as Error).cause).toBeUndefined()
      }
    }
  })

  it('surfaces offline and remote errors and closes failed RPC connections', async () => {
    const offline = fixture({ failConnect: true })
    await expect(offline.invoke(REMOTE_COLLABORATION_IPC.CANDIDATES, ['saved-profile', 'remote-workspace'])).rejects.toThrow('offline')
    const failed = fixture({ failInvoke: true })
    await expect(failed.invoke(REMOTE_COLLABORATION_IPC.CANDIDATES, ['saved-profile', 'remote-workspace'])).rejects.toThrow('remote rejected')
    expect(failed.destroyed()).toBe(1)
  })
})

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => resolve = done); return { promise, resolve } }

describe('saved-profile native generation authority', () => {
  it('rejects same-id impostors, iframes and non-app documents before credential resolution', async () => {
    const f = fixture(); let resolutions = 0
    f.hooks.resolve = async () => { resolutions++ }
    for (const event of [
      { sender: { ...f.sender }, senderFrame: f.sender.mainFrame },
      { sender: f.sender, senderFrame: { ...f.sender.mainFrame } },
    ]) await expect(f.handlers.get(REMOTE_COLLABORATION_IPC.CANDIDATES)!(event, 'saved-profile', 'main')).rejects.toThrow('trusted local desktop')
    f.sender.mainFrame.url = 'file:///app/untrusted.html'
    await expect(f.invoke(REMOTE_COLLABORATION_IPC.CANDIDATES, ['saved-profile', 'main'])).rejects.toThrow('trusted local desktop')
    expect(resolutions).toBe(0); expect(f.connections).toEqual([])
  })

  it('does not connect if native authority expires during initial saved-profile resolution', async () => {
    const f = fixture(); const entered = gate(); const release = gate(); let calls = 0
    f.hooks.resolve = async () => { if (++calls === 1) { entered.resolve(); await release.promise } }
    const pending = f.invoke(REMOTE_COLLABORATION_IPC.CANDIDATES, ['saved-profile', 'main']).then(() => '', error => String(error))
    await entered.promise; f.changeWindow(); release.resolve(); expect(await pending).toContain('workspace changed')
    expect(f.connections).toEqual([])
  })

  it('the connector handshake guard rejects a changed profile before any remote RPC', async () => {
    const f = fixture(); const entered = gate(); const release = gate()
    f.hooks.connect = async () => { entered.resolve(); await release.promise }
    const pending = f.invoke(REMOTE_COLLABORATION_IPC.CREATE, ['saved-profile', 'main', 'primary', [{ createNew: true, workspaceId: 'main' }]]).then(() => '', error => String(error))
    await entered.promise; f.profile.revision = 'new-revision'; f.profile.token = 'dummy-new-token'; release.resolve(); expect(await pending).toContain('Saved server')
    expect(f.calls).toEqual([])
  })

  for (const changed of ['window', 'profile'] as const) it(`discards late remote data after ${changed} changed and closes the exact client`, async () => {
    const f = fixture(); const entered = gate(); const release = gate()
    f.hooks.invoke = async () => { entered.resolve(); await release.promise }
    const pending = f.invoke(REMOTE_COLLABORATION_IPC.CANDIDATES, ['saved-profile', 'main']).then(() => '', error => String(error))
    await entered.promise
    if (changed === 'window') f.changeWindow(); else f.profile.revision = 'new-revision'
    release.resolve(); expect(await pending).toContain('changed')
    expect(f.destroyed()).toBe(1); expect(f.calls).toHaveLength(1)
  })

  it('redacts known saved-token echoes in returned data and arbitrary object keys', async () => {
    const f = fixture({ response: [{ id: 'one', name: 'synthetic-test-token', 'prefix-synthetic-test-token': 'value' }] })
    const result = await f.invoke(REMOTE_COLLABORATION_IPC.CANDIDATES, ['saved-profile', 'main'])
    expect(result).toEqual([{ id: 'one', name: '[redacted]', 'prefix-[redacted]': 'value' }])
    expect(JSON.stringify(result)).not.toContain('synthetic-test-token')
  })
})
