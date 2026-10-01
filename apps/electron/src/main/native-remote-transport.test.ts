import { afterEach, describe, expect, test } from 'bun:test'
import { WsRpcClient, WsRpcServer, CLIENT_OPEN_EXTERNAL, CLIENT_SFTP_TRANSFER } from '@craft-agent/server-core/transport'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { createNativeWindowAuthority, advanceNativeWindowBinding, type NativeAuthorityEvent } from './native-window-authority'
import { registerNativeRemoteTransport, type MainRemoteTarget, type NativeRemoteTransportDependencies } from './native-remote-transport'
import { NativeRemoteClient } from '../preload/native-remote-client'
import { NATIVE_REMOTE_TRANSPORT as IPC, type NativeRemotePacket } from '../shared/native-remote-transport'

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await delay() } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function fixture(options: { auth?: boolean; thin?: boolean; maxHandles?: number; capabilityTimeoutMs?: number; token?: string; transferSftp?: NativeRemoteTransportDependencies['transferSftp'] } = {}) {
  const token = options.token ?? 'dummy-main-only-remote-bearer-secret'
  let authAttempts = 0
  const server = new WsRpcServer({ host: '127.0.0.1', port: 0, requireAuth: true, validateToken: async value => { authAttempts++; return options.auth !== false && value === token } })
  server.handle(RPC_CHANNELS.sessions.GET, async ctx => ({ workspace: ctx.workspaceId, echo: token, bytes: new Uint8Array([1, 2, 3]) }))
  server.handle(RPC_CHANNELS.workspaces.GET, async () => [{ id: 'main', name: 'Dummy' }])
  await server.listen(); cleanup.push(() => server.close())
  const target: MainRemoteTarget = { mode: options.thin ? 'thin' : 'workspace', url: `ws://127.0.0.1:${server.port}`, token, revision: 'revision-one', ...(options.thin ? {} : { remoteWorkspaceId: 'remote-main' }) }
  const handlers = new Map<string, (event: NativeAuthorityEvent, ...args: any[]) => Promise<any>>()
  const windows = new Map<number, any>(); const workspaces = new Map<number, string>()
  const receivers = new Map<object, Set<(event: unknown, packet: NativeRemotePacket) => void>>()
  const invalidations = new Map<object, Set<() => void>>()
  const snapshots: unknown[] = []
  const clients: WsRpcClient[] = []
  let resolveHook = async () => {}
  const assertSender = createNativeWindowAuthority({ getWindowByWebContentsId: id => windows.get(id), getWorkspaceForWindow: id => workspaces.get(id) }, ['file:///app/index.html'], { allowUnboundWorkspace: true })
  const bridge = registerNativeRemoteTransport({ handle: (channel, handler) => { handlers.set(channel, handler) } }, {
    assertSender, resolveTarget: async () => { await resolveHook(); return { ...target } },
    createClient: (resolved, capabilities, authority) => {
      const client = new WsRpcClient(resolved.url, { token: resolved.token, workspaceId: resolved.remoteWorkspaceId, webContentsId: authority.webContentsId, clientCapabilities: [...capabilities], autoReconnect: true, connectTimeout: 500, requestTimeout: 1000, maxReconnectDelay: 30, useNodeWebSocket: true })
      clients.push(client); return client
    },
    sendToSender: (sender, packet) => { snapshots.push(structuredClone(packet)); for (const receive of receivers.get(sender) ?? []) receive({}, packet) },
    attachInvalidation: (sender, callback) => { let callbacks = invalidations.get(sender); if (!callbacks) { callbacks = new Set(); invalidations.set(sender, callbacks) }; callbacks.add(callback); return () => { callbacks!.delete(callback) } },
    maxHandles: options.maxHandles, capabilityTimeoutMs: options.capabilityTimeoutMs,
    transferSftp: options.transferSftp,
  })
  cleanup.push(() => bridge.dispose())
  function window(id: number) {
    const sender = { id, mainFrame: { url: 'file:///app/index.html', processId: id, routingId: 1 }, getURL() { return this.mainFrame.url }, isDestroyed: () => false }
    windows.set(id, { webContents: sender, isDestroyed: () => false }); workspaces.set(id, options.thin ? '' : `local-${id}`)
    const event: NativeAuthorityEvent = { sender, senderFrame: sender.mainFrame }
    function ipcFor(frameEvent = event) {
      return {
        invoke: async (channel: string, ...args: unknown[]) => { snapshots.push({ direction: 'request', channel, args }); const result = await handlers.get(channel)!(frameEvent, ...args); snapshots.push({ direction: 'response', channel, result }); return result },
        on: (_channel: string, listener: (event: unknown, packet: NativeRemotePacket) => void) => { let set = receivers.get(sender); if (!set) { set = new Set(); receivers.set(sender, set) }; set.add(listener) },
        removeListener: (_channel: string, listener: (event: unknown, packet: NativeRemotePacket) => void) => receivers.get(sender)?.delete(listener),
      }
    }
    const ipc = ipcFor(); const adapter = new NativeRemoteClient(ipc); cleanup.push(() => adapter.destroy())
    const navigate = (workspace = workspaces.get(id)!) => { for (const invalidate of [...invalidations.get(sender) ?? []]) invalidate(); advanceNativeWindowBinding(sender); sender.mainFrame = { ...sender.mainFrame, routingId: sender.mainFrame.routingId + 1 }; workspaces.set(id, workspace) }
    return { sender, event, ipc, ipcFor, adapter, navigate }
  }
  return { server, token, target, bridge, handlers, snapshots, clients, window, authAttempts: () => authAttempts, setResolveHook: (hook: () => Promise<void>) => { resolveHook = hook } }
}

describe('main-owned remote transport boundary with real WebSocket peers', () => {
  test('routes known workspace calls/pushes without exposing tokens and preserves binary values', async () => {
    const f = await fixture(); const w = f.window(1); const pushes: unknown[] = []
    w.adapter.on(RPC_CHANNELS.sessions.EVENT, (...args) => { pushes.push(args) }); w.adapter.connect()
    const result = await w.adapter.invoke(RPC_CHANNELS.sessions.GET)
    expect(result).toEqual({ workspace: 'remote-main', echo: '[redacted]', bytes: new Uint8Array([1, 2, 3]) })
    f.server.push(RPC_CHANNELS.sessions.EVENT, { to: 'all' }, { echo: f.token })
    await until(() => pushes.length === 1)
    expect(pushes).toEqual([[{ echo: '[redacted]' }]])
    expect(JSON.stringify(f.snapshots)).not.toContain(f.token)
    await expect(w.adapter.invoke(RPC_CHANNELS.workspaces.GET)).rejects.toThrow('not allowed')
    expect((await w.ipc.invoke(IPC.INVOKE, (w.adapter as any).handle, '__credentials:list', [])).ok).toBe(false)
    expect((await w.ipc.invoke(IPC.OPEN, { url: 'ws://attacker.invalid', token: 'caller-token' })).ok).toBe(false)
  })
  test('rejects wrong sender, same-id impostor, iframe, untrusted document and expired handle', async () => {
    const f = await fixture(); const one = f.window(1); const two = f.window(2)
    await one.adapter.invoke(RPC_CHANNELS.sessions.GET)
    const handle = (one.adapter as any).handle
    for (const event of [two.event, { sender: { ...one.sender }, senderFrame: one.sender.mainFrame }, { sender: one.sender, senderFrame: { ...one.sender.mainFrame } }]) {
      expect((await f.handlers.get(IPC.INVOKE)!(event as any, handle, RPC_CHANNELS.sessions.GET, [])).ok).toBe(false)
    }
    one.sender.mainFrame.url = 'file:///app/evil.html'
    expect((await one.ipc.invoke(IPC.INVOKE, handle, RPC_CHANNELS.sessions.GET, [])).ok).toBe(false)
    one.sender.mainFrame.url = 'file:///app/index.html'; one.navigate()
    expect((await one.ipc.invoke(IPC.DESTROY, handle)).ok).toBe(false)
    expect(f.bridge.getStats().handles).toBe(0)
  })
  test('initial thin picker allows existing known thin-client channels and switching requires a new native generation', async () => {
    const f = await fixture({ thin: true }); const w = f.window(1)
    expect(await w.adapter.invoke(RPC_CHANNELS.workspaces.GET)).toEqual([{ id: 'main', name: 'Dummy' }])
    expect((await w.adapter.invoke(RPC_CHANNELS.sessions.GET)).workspace).toBeNull()
    f.target.remoteWorkspaceId = 'remote-selected'; f.target.revision = 'revision-two'
    await expect(w.adapter.invoke(RPC_CHANNELS.sessions.GET)).rejects.toThrow('changed')
    w.navigate('local-selected'); const freshEvent = { sender: w.sender, senderFrame: w.sender.mainFrame }
    const next = new NativeRemoteClient(w.ipcFor(freshEvent)); cleanup.push(() => next.destroy())
    expect((await next.invoke(RPC_CHANNELS.sessions.GET)).workspace).toBe('remote-selected')
    expect(JSON.stringify(f.snapshots)).not.toContain(f.token)
  })
  test('correlates capabilities per window, rejects forged results, and times out abandoned capabilities', async () => {
    const f = await fixture({ capabilityTimeoutMs: 100 }); const one = f.window(1); const two = f.window(2)
    const gate = deferred<string>(); one.adapter.handleCapability(CLIENT_OPEN_EXTERNAL, async () => gate.promise)
    await one.adapter.invoke(RPC_CHANNELS.sessions.GET); await two.adapter.invoke(RPC_CHANNELS.sessions.GET)
    const id = f.server.findClientsWithCapability(CLIENT_OPEN_EXTERNAL)[0]!
    const pending = f.server.invokeClient(id, CLIENT_OPEN_EXTERNAL, `https://example.invalid/${f.token}`)
    await until(() => f.snapshots.some((value: any) => value.kind === 'capability'))
    const packet = f.snapshots.find((value: any) => value.kind === 'capability') as any
    expect((await two.ipc.invoke(IPC.CAPABILITY_RESULT, packet.handle, packet.callId, { ok: true, value: 'forged' })).ok).toBe(false)
    expect((await two.ipc.invoke(IPC.CAPABILITY_RESULT, (two.adapter as any).handle, packet.callId, { ok: true, value: 'forged' })).ok).toBe(false)
    gate.resolve('approved'); expect(await pending).toBe('approved')
    one.adapter.handleCapability(CLIENT_OPEN_EXTERNAL, async () => new Promise(() => {}))
    // Await settlement before asserting: Bun's promise matcher can stall this
    // nested IPC/WebSocket rejection on Windows.
    const abandoned = await f.server.invokeClient(id, CLIENT_OPEN_EXTERNAL, 'https://example.invalid').then(() => null, error => error)
    expect(abandoned).toBeInstanceOf(Error)
    expect(abandoned.code).toBe('HANDLER_ERROR')
    expect(f.bridge.getStats().capabilities).toBe(0)
    expect(JSON.stringify(f.snapshots)).not.toContain(f.token)
  })
  test('replacement handles survive stale closes, and repeated reconnects keep one live socket', async () => {
    const f = await fixture(); const w = f.window(1)
    await w.adapter.invoke(RPC_CHANNELS.sessions.GET); const oldHandle = (w.adapter as any).handle
    const next = new NativeRemoteClient(w.ipc); cleanup.push(() => next.destroy())
    await next.invoke(RPC_CHANNELS.sessions.GET)
    expect((await w.ipc.invoke(IPC.DESTROY, oldHandle)).ok).toBe(false)
    expect(f.bridge.getStats().handles).toBe(1)
    next.reconnectNow(); next.reconnectNow(); next.reconnectNow()
    await until(() => next.isConnected && f.server.getConnectedClientCount() === 1)
    expect((await next.invoke(RPC_CHANNELS.sessions.GET)).workspace).toBe('remote-main')
    w.navigate(); expect(f.bridge.getStats().handles).toBe(0)
  })
  test('auth failure remains retryable and IPC state never echoes the saved credential', async () => {
    const f = await fixture({ auth: false }); const w = f.window(1); w.adapter.connect()
    await until(() => w.adapter.getConnectionState().status === 'failed')
    expect(w.adapter.getConnectionState().lastError?.kind).toBe('auth')
    w.adapter.reconnectNow(); await delay(30)
    expect(JSON.stringify(f.snapshots)).not.toContain(f.token)
    expect(f.bridge.getStats().handles).toBe(1)
  })
  test('handle limits deny additional windows without destroying the existing connection', async () => {
    const f = await fixture({ maxHandles: 1 }); const one = f.window(1); const two = f.window(2)
    await one.adapter.invoke(RPC_CHANNELS.sessions.GET)
    await expect(two.adapter.invoke(RPC_CHANNELS.sessions.GET)).rejects.toThrow('Too many')
    expect((await one.adapter.invoke(RPC_CHANNELS.sessions.GET)).workspace).toBe('remote-main')
  })
})


test('navigation during credential resolution admits no stale connection, and a stale open cannot replace a newer handle', async () => {
  const f = await fixture(); const w = f.window(1); const gate = deferred<void>(); let calls = 0
  f.setResolveHook(async () => { if (++calls === 1) await gate.promise })
  const stale = w.ipc.invoke(IPC.OPEN)
  await delay(); w.navigate()
  const freshEvent = { sender: w.sender, senderFrame: w.sender.mainFrame }
  const current = await w.ipcFor(freshEvent).invoke(IPC.OPEN)
  expect(current.ok).toBe(true)
  gate.resolve(); expect((await stale).ok).toBe(false)
  expect(f.bridge.getStats().handles).toBe(1)
  expect(f.clients).toHaveLength(1)
})

test('navigation settles in-flight RPC and capability requests and discards late results', async () => {
  const f = await fixture(); const w = f.window(1); const rpcGate = deferred<void>(); const capGate = deferred<void>()
  let entered = false
  f.server.handle(RPC_CHANNELS.sessions.GET_MESSAGES, async () => { entered = true; await rpcGate.promise; return 'old-result' })
  w.adapter.handleCapability(CLIENT_OPEN_EXTERNAL, async () => { await capGate.promise; return 'old-capability' })
  await w.adapter.invoke(RPC_CHANNELS.sessions.GET)
  const pendingRpc = w.adapter.invoke(RPC_CHANNELS.sessions.GET_MESSAGES).then(value => value, () => 'expired')
  const id = f.server.findClientsWithCapability(CLIENT_OPEN_EXTERNAL)[0]!
  const pendingCapability = f.server.invokeClient(id, CLIENT_OPEN_EXTERNAL, 'https://example.invalid').then(value => value, () => 'expired')
  await until(() => entered && f.bridge.getStats().capabilities === 1)
  w.navigate()
  expect(await pendingRpc).toBe('expired'); expect(await pendingCapability).toBe('expired')
  rpcGate.resolve(); capGate.resolve(); await delay()
  expect(f.bridge.getStats()).toEqual({ handles: 0, capabilities: 0 })
})

test('failed subscription setup releases its admitted main handle', async () => {
  const f = await fixture(); const w = f.window(1)
  w.adapter.on(RPC_CHANNELS.sessions.GET, () => {}) // known RPC, not a push channel
  await expect(w.adapter.invoke(RPC_CHANNELS.sessions.GET)).rejects.toThrow('not allowed')
  expect(f.bridge.getStats().handles).toBe(0)
})

test('stable thin adapter rebind preserves handlers and subscriptions while retiring only its old handle', async () => {
  const f = await fixture({ thin: true }); const w = f.window(1)
  const pushes: string[] = []
  w.adapter.on(RPC_CHANNELS.sessions.EVENT, value => pushes.push(value))
  w.adapter.handleCapability(CLIENT_OPEN_EXTERNAL, async () => 'still-registered')
  await w.adapter.invoke(RPC_CHANNELS.sessions.GET)
  const oldHandle = (w.adapter as any).handle
  // An explicit native switch advances authority; the IPC stub mimics Electron
  // delivering subsequent invocations from the current top-level frame.
  advanceNativeWindowBinding(w.sender); f.target.remoteWorkspaceId = 'selected'; f.target.revision = 'revision-next'
  await w.adapter.rebind()
  expect((await w.adapter.invoke(RPC_CHANNELS.sessions.GET)).workspace).toBe('selected')
  expect((await w.ipc.invoke(IPC.DESTROY, oldHandle)).ok).toBe(false)
  f.server.push(RPC_CHANNELS.sessions.EVENT, { to: 'all' }, 'new-push')
  await until(() => pushes.length === 1)
  expect(pushes).toEqual(['new-push'])
  const id = f.server.findClientsWithCapability(CLIENT_OPEN_EXTERNAL)[0]!
  expect(await f.server.invokeClient(id, CLIENT_OPEN_EXTERNAL, 'https://example.invalid')).toBe('still-registered')
})

test('late old OPEN after rebind or destroy cannot clear a newer adapter handle or send an invocation to the new target', async () => {
  const f = await fixture(); const w = f.window(1); const gate = deferred<void>(); let calls = 0
  f.setResolveHook(async () => { if (++calls === 1) await gate.promise })
  const oldInvoke = w.adapter.invoke(RPC_CHANNELS.sessions.GET).then(() => 'wrong', () => 'expired')
  await delay(); advanceNativeWindowBinding(w.sender)
  await w.adapter.rebind()
  const currentHandle = (w.adapter as any).handle
  gate.resolve(); expect(await oldInvoke).toBe('expired')
  expect((w.adapter as any).handle).toBe(currentHandle)
  expect((await w.adapter.invoke(RPC_CHANNELS.sessions.GET)).workspace).toBe('remote-main')
  const two = f.window(2); const secondGate = deferred<void>(); calls = 0
  f.setResolveHook(async () => { if (++calls === 1) await secondGate.promise })
  const destroyed = two.adapter.invoke(RPC_CHANNELS.sessions.GET).then(() => 'wrong', () => 'expired')
  await delay(); two.adapter.destroy(); secondGate.resolve()
  expect(await destroyed).toBe('expired')
  expect(f.bridge.getStats().handles).toBe(1)
})


test('short legacy auth tokens never alter handles or protocol names', async () => {
  const f = await fixture({ token: 'a' }); const w = f.window(1)
  const result = await w.adapter.invoke(RPC_CHANNELS.sessions.GET)
  expect(result.workspace).toBe('remote-main')
  expect(result.echo).toBe('[redacted]')
  expect(f.bridge.getStats().handles).toBe(1)
})

test('startup network failure remains distinguishable from version incompatibility', async () => {
  const f = await fixture({ thin: true })
  f.target.url = 'ws://127.0.0.1:1'
  const w = f.window(1)
  const error = await w.adapter.invoke(RPC_CHANNELS.server.GET_WORKSPACES).catch(error => error)
  expect(error.code).toBe('NETWORK')
  expect(error.message).toContain('Cannot connect')
  expect(w.adapter.getConnectionState().lastError?.kind).toBe('network')
  expect(JSON.stringify(f.snapshots)).not.toContain(f.token)
})

test('incompatible handshake reports a protocol error without forwarding peer text', async () => {
  const f = await fixture({ thin: true })
  ;(f.server as any).onConnection = (socket: any) => {
    socket.once('message', (raw: any) => {
      const handshake = JSON.parse(raw.toString())
      socket.send(JSON.stringify({ id: handshake.id, type: 'error', error: {
        code: 'PROTOCOL_VERSION_UNSUPPORTED', message: `Peer rejected ${f.token}`,
      } }))
      socket.close(4004, 'Protocol mismatch')
    })
  }
  const w = f.window(1)
  const error = await w.adapter.invoke(RPC_CHANNELS.server.GET_WORKSPACES).catch(error => error)
  expect(error.code).toBe('PROTOCOL')
  expect(error.message).toContain('protocol versions are incompatible')
  expect(w.adapter.getConnectionState().lastError?.kind).toBe('protocol')
  expect(error.message).not.toContain(f.token)
  expect(JSON.stringify(f.snapshots)).not.toContain(f.token)
})

test('missing older-server interface reports an unsupported operation without forwarding peer text', async () => {
  const f = await fixture({ thin: true }); const w = f.window(1)
  const error = await w.adapter.invoke(RPC_CHANNELS.server.GET_WORKSPACES).catch(error => error)
  expect(error.code).toBe('UNSUPPORTED')
  expect(error.message).toContain('Update the server')
  expect(w.adapter.isConnected).toBe(true)
  expect(JSON.stringify(f.snapshots)).not.toContain(f.token)
})

test('adapter drops an already-produced IPC result after rebind or destroy', async () => {
  for (const action of ['rebind', 'destroy'] as const) {
    const f = await fixture(); const w = f.window(action === 'rebind' ? 1 : 2)
    const gate = deferred<void>(); let produced = false; let delayNext = false
    const adapter = new NativeRemoteClient({ ...w.ipc, invoke: async (channel, ...args) => {
      const result = await w.ipc.invoke(channel, ...args)
      if (channel === IPC.INVOKE && delayNext) { delayNext = false; produced = true; await gate.promise }
      return result
    } })
    cleanup.push(() => adapter.destroy())
    await adapter.invoke(RPC_CHANNELS.sessions.GET)
    delayNext = true
    const stale = adapter.invoke(RPC_CHANNELS.sessions.GET).then(() => 'leaked', () => 'expired')
    await until(() => produced)
    if (action === 'rebind') {
      advanceNativeWindowBinding(w.sender)
      f.target.remoteWorkspaceId = 'new-workspace'; f.target.revision = 'new-revision'
      await adapter.rebind()
    } else adapter.destroy()
    gate.resolve()
    expect(await stale).toBe('expired')
    if (action === 'rebind') expect((await adapter.invoke(RPC_CHANNELS.sessions.GET)).workspace).toBe('new-workspace')
  }
})

test('idle target changes invalidate automatic reconnect before the old bearer can be resent', async () => {
  const f = await fixture(); const w = f.window(1)
  await w.adapter.invoke(RPC_CHANNELS.sessions.GET)
  expect(f.authAttempts()).toBe(1)
  f.target.token = 'dummy-replacement-secret'; f.target.revision = 'replacement'
  for (const peer of (f.server as any).clients.values()) peer.ws.terminate()
  await until(() => f.bridge.getStats().handles === 0)
  expect(f.authAttempts()).toBe(1)
  expect(w.adapter.getConnectionState().lastError?.code).toBe('TARGET_CHANGED')
  await expect(w.adapter.invoke(RPC_CHANNELS.sessions.GET)).rejects.toThrow()
  expect(f.bridge.getStats()).toEqual({ handles: 0, capabilities: 0 })
})

test('target change while the initial handshake guard is awaiting resolution sends no bearer', async () => {
  const f = await fixture(); const w = f.window(1); const entered = deferred<void>(); const gate = deferred<void>(); let calls = 0
  f.setResolveHook(async () => { if (++calls === 3) { entered.resolve(); await gate.promise } })
  const pending = w.adapter.invoke(RPC_CHANNELS.sessions.GET).then(() => 'admitted', () => 'denied')
  await entered.promise
  f.target.revision = 'changed-before-handshake'; gate.resolve()
  expect(await pending).toBe('denied')
  expect(f.authAttempts()).toBe(0)
  expect(f.bridge.getStats().handles).toBe(0)
})

test('arbitrary response and push payload keys redact token substrings without changing protocol envelopes', async () => {
  const f = await fixture(); const w = f.window(1); const pushes: unknown[] = []
  f.server.handle(RPC_CHANNELS.sessions.GET_MESSAGES, async () => ({ [`echo-${f.token}-suffix`]: { [f.token]: f.token } }))
  w.adapter.on(RPC_CHANNELS.sessions.EVENT, value => pushes.push(value))
  const result = await w.adapter.invoke(RPC_CHANNELS.sessions.GET_MESSAGES)
  expect(result).toEqual({ 'echo-[redacted]-suffix': { '[redacted]': '[redacted]' } })
  f.server.push(RPC_CHANNELS.sessions.EVENT, { to: 'all' }, { [`push-${f.token}`]: true })
  await until(() => pushes.length === 1)
  expect(pushes).toEqual([{ 'push-[redacted]': true }])
  expect(JSON.stringify(f.snapshots)).not.toContain(f.token)
})

test('SFTP executes only through the pinned main hook and never forwards its capability to preload', async () => {
  const calls: Array<{ profileId?: string; revision?: string; request: unknown }> = []
  const f = await fixture({ transferSftp: async (target, request, assertCurrent) => {
    await assertCurrent()
    calls.push({ profileId: target.profileId, revision: target.profileRevision, request })
    return { success: true }
  } }); const w = f.window(1)
  f.target.profileId = 'owned-profile'; f.target.profileRevision = 'owned-revision'
  let rendererCalls = 0
  w.adapter.handleCapability(CLIENT_SFTP_TRANSFER, () => { rendererCalls++; throw new Error('Must not forward') })
  await w.adapter.invoke(RPC_CHANNELS.sessions.GET)
  const id = f.server.findClientsWithCapability(CLIENT_SFTP_TRANSFER)[0]!
  const request = { direction: 'upload', localPath: '/owned/dummy', remotePath: '/dummy' }
  expect(await f.server.invokeClient(id, CLIENT_SFTP_TRANSFER, request)).toEqual({ success: true })
  expect(calls).toEqual([{ profileId: 'owned-profile', revision: 'owned-revision', request }])
  expect(rendererCalls).toBe(0)
  expect(f.snapshots.some((packet: any) => packet.kind === 'capability' && packet.channel === CLIENT_SFTP_TRANSFER)).toBe(false)
  expect(JSON.stringify(f.snapshots)).not.toContain(f.token)
})

test('SFTP fails closed without a main hook or a profile pin', async () => {
  for (const missing of ['hook', 'pin'] as const) {
    let mainCalls = 0; let rendererCalls = 0
    const f = await fixture({ ...(missing === 'pin' ? { transferSftp: async () => { mainCalls++; return {} } } : {}) }); const w = f.window(1)
    if (missing === 'hook') { f.target.profileId = 'owned-profile'; f.target.profileRevision = 'owned-revision' }
    w.adapter.handleCapability(CLIENT_SFTP_TRANSFER, async () => { rendererCalls++; return {} })
    await w.adapter.invoke(RPC_CHANNELS.sessions.GET)
    const id = f.server.findClientsWithCapability(CLIENT_SFTP_TRANSFER)[0]!
    const denied = await f.server.invokeClient(id, CLIENT_SFTP_TRANSFER, { direction: 'upload', localPath: '/dummy', remotePath: '/dummy' }).then(() => null, error => error)
    expect(denied).toBeInstanceOf(Error)
    expect(denied.message).toBe('This remote transport action is not allowed.')
    expect(mainCalls).toBe(0); expect(rendererCalls).toBe(0)
    expect((await w.adapter.invoke(RPC_CHANNELS.sessions.GET)).workspace).toBe('remote-main')
  }
})

test('queued main SFTP cannot transfer after its native target is replaced', async () => {
  const entered = deferred<void>(); const gate = deferred<void>(); let transfers = 0
  const f = await fixture({ transferSftp: async (_target, _request, assertCurrent) => {
    entered.resolve(); await gate.promise; await assertCurrent(); transfers++; return { success: true }
  } }); const w = f.window(1)
  f.target.profileId = 'owned-profile'; f.target.profileRevision = 'owned-revision'
  await w.adapter.invoke(RPC_CHANNELS.sessions.GET)
  const id = f.server.findClientsWithCapability(CLIENT_SFTP_TRANSFER)[0]!
  const pending = f.server.invokeClient(id, CLIENT_SFTP_TRANSFER, { direction: 'download', localPath: '/dummy', remotePath: '/dummy' }).then(() => 'transferred', () => 'denied')
  await entered.promise
  f.target.profileId = 'different-profile'; f.target.profileRevision = 'different-revision'; gate.resolve()
  expect(await pending).toBe('denied'); expect(transfers).toBe(0)
  expect(f.bridge.getStats().handles).toBe(0)
})

test('a mutation attempted before socket loss is never replayed on guarded network recovery', async () => {
  const f = await fixture(); const w = f.window(1); let mutations = 0
  f.server.handle(RPC_CHANNELS.sessions.CREATE, async ctx => {
    mutations++
    if (mutations === 1) (f.server as any).clients.get(ctx.clientId).ws.terminate()
    return { mutations }
  })
  await w.adapter.invoke(RPC_CHANNELS.sessions.GET)
  await expect(w.adapter.invoke(RPC_CHANNELS.sessions.CREATE)).rejects.toThrow()
  await until(() => w.adapter.isConnected && f.authAttempts() === 2)
  expect(mutations).toBe(1)
  expect(await w.adapter.invoke(RPC_CHANNELS.sessions.CREATE)).toEqual({ mutations: 2 })
  expect(f.bridge.getStats().handles).toBe(1)
})
