import { afterEach, describe, expect, it } from 'bun:test'
import { WebSocketServer, type WebSocket } from 'ws'
import { createServer } from 'node:http'
import { PROTOCOL_VERSION } from '@craft-agent/shared/protocol'
import { WsRpcClient, type TransportConnectionState, type WsRpcClientOptions } from '../client'
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => resolve = done); return { promise, resolve } }
function waitState(client: WsRpcClient, predicate: (state: TransportConnectionState) => boolean): Promise<TransportConnectionState> {
  return new Promise((resolve, reject) => {
    let off = () => {}
    const timer = setTimeout(() => { off(); reject(new Error('Expected transport event was not emitted')) }, 2000)
    off = client.onConnectionStateChanged(state => { if (predicate(state)) { clearTimeout(timer); queueMicrotask(() => off()); resolve(state) } })
  })
}
async function fixture(opts: WsRpcClientOptions = {}, handshake?: (ws: WebSocket, frame: any) => boolean, beforeMessage?: (ws: WebSocket) => void) {
  const httpServer = createServer()
  const server = new WebSocketServer({ server: httpServer })
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const peers: Array<{ ws: WebSocket; frames: any[] }> = []
  server.on('connection', ws => {
    const peer = { ws, frames: [] as any[] }; peers.push(peer)
    ws.on('message', raw => {
      const frame = JSON.parse(raw.toString()); peer.frames.push(frame)
      if (frame.type === 'handshake') {
        if (handshake && !handshake(ws, frame)) return
        ws.send(JSON.stringify({ id: frame.id, type: 'handshake_ack', protocolVersion: PROTOCOL_VERSION, clientId: `client-${peers.length}`, registeredChannels: ['echo'] }))
      } else if (frame.type === 'request') ws.send(JSON.stringify({ id: frame.id, type: 'response', channel: frame.channel, result: frame.args?.[0] }))
    })
    beforeMessage?.(ws)
  })
  cleanup.push(async () => {
    // Bun's HTTP close callback can remain pending if invoked in the same turn
    // as WebSocket teardown. First observe each owned socket's close event.
    await Promise.all(peers.map(peer => peer.ws.readyState === peer.ws.CLOSED ? Promise.resolve() : new Promise<void>(resolve => { peer.ws.once('close', () => resolve()); peer.ws.terminate() })))
    await new Promise<void>(resolve => server.close(() => resolve()))
    httpServer.closeAllConnections()
    httpServer.close()
  })
  const client = new WsRpcClient(`ws://127.0.0.1:${(server.address() as any).port}`, { token: 'dummy-test-token', connectTimeout: 1000, maxReconnectDelay: 20, useNodeWebSocket: true, tlsRejectUnauthorized: true, ...opts })
  cleanup.push(() => client.destroy())
  return { client, server, peers }
}
const closedAuth = (state: TransportConnectionState) => state.status === 'failed' && state.lastClose?.code === 4005
const frames = (peers: Array<{ frames: any[] }>) => peers.flatMap(peer => peer.frames)

describe('terminal auth with explicit retry', () => {
  it('AUTH_FAILED is terminal for auto reconnect and invoke; explicit reconnectNow can recover', async () => {
    let valid = false
    const f = await fixture({}, (ws, frame) => {
      if (valid) return true
      ws.send(JSON.stringify({ id: frame.id, type: 'error', error: { code: 'AUTH_FAILED', message: 'Invalid token' } })); ws.close(4005, 'Auth failed'); return false
    })
    const closed = waitState(f.client, closedAuth)
    await expect(f.client.invoke('echo', 'denied')).rejects.toThrow('Invalid token')
    const terminal = await closed
    expect(terminal.lastError?.kind).toBe('auth'); expect(terminal.nextRetryInMs).toBeUndefined(); expect((f.client as any).reconnectTimer).toBeNull()
    for (let n = 0; n < 3; n++) await expect(f.client.invoke('echo')).rejects.toThrow('Invalid token')
    await Bun.sleep(65) // Past three configured backoff intervals; no transient-state polling.
    expect(f.peers).toHaveLength(1)
    valid = true; const recovered = waitState(f.client, state => state.status === 'connected'); f.client.reconnectNow(); await recovered
    expect(await f.client.invoke('echo', 'recovered')).toBe('recovered'); expect(f.peers).toHaveLength(2)
  })
  it('close code 4005 without an error frame is terminal as well', async () => {
    const f = await fixture({}, undefined, ws => ws.close(4005, 'Auth failed'))
    const closed = waitState(f.client, closedAuth); await expect(f.client.invoke('echo')).rejects.toThrow('Auth failed'); await closed
    expect((f.client as any).reconnectTimer).toBeNull(); await Bun.sleep(45); expect(f.peers).toHaveLength(1)
  })
  it('an explicit retry from the terminal state event does not schedule a competing automatic retry', async () => {
    let valid = false, retried = false
    const f = await fixture({}, (ws, frame) => { if (valid) return true; ws.send(JSON.stringify({ id: frame.id, type: 'error', error: { code: 'AUTH_FAILED', message: 'Invalid token' } })); ws.close(4005); return false })
    f.client.onConnectionStateChanged(state => { if (closedAuth(state) && !retried) { retried = true; valid = true; f.client.reconnectNow() } })
    const recovered = waitState(f.client, state => state.status === 'connected'); await f.client.invoke('echo').catch(() => undefined); await recovered; await Bun.sleep(45)
    expect(f.peers).toHaveLength(2); expect((f.client as any).reconnectTimer).toBeNull(); expect(await f.client.invoke('echo', 'yes')).toBe('yes')
  })
})

describe('host pre-handshake guard', () => {
  it('waits before any token frame and ignores unsolicited admission before guard approval', async () => {
    const entered = gate(), release = gate()
    const f = await fixture({ beforeHandshake: async () => { entered.resolve(); await release.promise } }, undefined, ws => ws.send(JSON.stringify({ type: 'handshake_ack', clientId: 'unrequested', protocolVersion: PROTOCOL_VERSION })))
    const pending = f.client.invoke('echo', 'allowed'); await entered.promise; await Bun.sleep(0)
    expect(frames(f.peers)).toHaveLength(0); expect(f.client.isConnected).toBe(false)
    release.resolve(); expect(await pending).toBe('allowed'); expect(frames(f.peers).filter(frame => frame.type === 'handshake')).toHaveLength(1)
  })
  for (const mode of ['false', 'throw'] as const) it(`a ${mode} guard sends no credential and exposes only a fixed error`, async () => {
    const f = await fixture({ beforeHandshake: () => { if (mode === 'throw') throw new Error('dummy-sensitive-guard-detail'); return false } })
    const closed = waitState(f.client, closedAuth)
    const outcome = await f.client.invoke('echo').then(() => null, error => error)
    await closed; expect(String(outcome)).not.toContain('dummy-sensitive'); expect((outcome as any).code).toBe('HANDSHAKE_GUARD_REJECTED')
    expect(frames(f.peers)).toHaveLength(0); expect((f.client as any).pending.size).toBe(0); expect((f.client as any).reconnectTimer).toBeNull()
    expect(JSON.stringify(f.client.getConnectionState())).not.toContain('dummy-sensitive')
  })
  it('revalidates after a network reconnect and refuses a changed target before resending the token', async () => {
    let permitted = true, guards = 0
    const f = await fixture({ beforeHandshake: () => { guards++; return permitted } })
    expect(await f.client.invoke('echo', 'initial')).toBe('initial'); permitted = false
    const closed = waitState(f.client, state => closedAuth(state) && state.lastError?.code === 'HANDSHAKE_GUARD_REJECTED')
    f.peers[0]!.ws.terminate(); await closed
    expect(guards).toBe(2); expect(f.peers).toHaveLength(2); expect(f.peers[1]!.frames).toHaveLength(0); expect(frames(f.peers).filter(frame => frame.type === 'handshake')).toHaveLength(1)
  })
  it('keeps ordinary network reconnect working when the host guard permits it', async () => {
    let guards = 0
    const f = await fixture({ beforeHandshake: () => { guards++; return true } })
    expect(await f.client.invoke('echo', 'initial')).toBe('initial')
    const disconnected = waitState(f.client, state => state.status === 'reconnecting'); f.peers[0]!.ws.terminate(); await disconnected
    const restored = waitState(f.client, state => state.status === 'connected'); await restored
    expect(await f.client.invoke('echo', 'again')).toBe('again'); expect(guards).toBe(2)
  })
  it('destroy while awaiting a guard settles readiness and makes the late result inert', async () => {
    const entered = gate(), release = gate(), finished = gate()
    const f = await fixture({ beforeHandshake: async () => { entered.resolve(); await release.promise; finished.resolve(); return true } })
    const pending = f.client.invoke('echo').then(() => null, error => error); await entered.promise; f.client.destroy()
    expect(String(await pending)).toContain('Client destroyed'); release.resolve(); await finished.promise; await Bun.sleep(0)
    expect(frames(f.peers)).toHaveLength(0); expect((f.client as any).ws).toBeNull(); expect((f.client as any).readyPromise).toBeNull(); expect((f.client as any).pending.size).toBe(0)
  })
  it('the connection deadline includes guard waiting and a late approval cannot send', async () => {
    const entered = gate(), release = gate(), finished = gate()
    const f = await fixture({ autoReconnect: false, connectTimeout: 40, beforeHandshake: async () => { entered.resolve(); await release.promise; finished.resolve(); return true } })
    const closed = waitState(f.client, state => state.status === 'failed' && !!state.lastClose && state.lastError?.code === 'HANDSHAKE_TIMEOUT')
    const pending = f.client.invoke('echo').then(() => null, error => error); await entered.promise; await closed
    expect(String(await pending)).toContain('Connection timeout'); release.resolve(); await finished.promise; await Bun.sleep(0)
    expect(frames(f.peers)).toHaveLength(0); expect((f.client as any).connectTimer).toBeNull(); expect((f.client as any).readyPromise).toBeNull()
  })
  it('manual reconnect supersedes a pending guard without letting its old socket send later', async () => {
    const entered = gate(), release = gate(), finished = gate(); let guards = 0
    const f = await fixture({ beforeHandshake: async () => { if (++guards === 1) { entered.resolve(); await release.promise; finished.resolve() } } })
    const old = f.client.invoke('echo').then(() => null, error => error); await entered.promise
    const recovered = waitState(f.client, state => state.status === 'connected'); f.client.reconnectNow(); await recovered
    expect(String(await old)).toContain('Connection lost'); release.resolve(); await finished.promise; await Bun.sleep(0)
    expect(f.peers[0]!.frames).toHaveLength(0); expect(frames(f.peers).filter(frame => frame.type === 'handshake')).toHaveLength(1); expect(await f.client.invoke('echo', 'fresh')).toBe('fresh')
  })
  it('replacing a pending guard requires the newest guard, not the old approval', async () => {
    const entered = gate(), release = gate(); let latestChecks = 0
    const f = await fixture({ beforeHandshake: async () => { entered.resolve(); await release.promise; return true } })
    const closed = waitState(f.client, closedAuth); const pending = f.client.invoke('echo').then(() => null, error => error); await entered.promise
    f.client.setHandshakeGuard(() => { latestChecks++; return false }); release.resolve(); await closed
    expect((await pending as any).code).toBe('HANDSHAKE_GUARD_REJECTED'); expect(latestChecks).toBe(1); expect(frames(f.peers)).toHaveLength(0)
    f.client.setHandshakeGuard(() => true); const recovered = waitState(f.client, state => state.status === 'connected'); f.client.reconnectNow(); await recovered
    expect(await f.client.invoke('echo', 'new policy')).toBe('new policy')
  })
})


it('browser-compatible WebSocket also honors an installed guard', async () => {
  let checks = 0
  const f = await fixture({ useNodeWebSocket: false, beforeHandshake: () => { checks++; return true } })
  expect(await f.client.invoke('echo', 'browser')).toBe('browser'); expect(checks).toBe(1)
})

it('an explicit retry from a timeout event cannot be closed by the stale timeout callback', async () => {
  const entered = gate(), release = gate(); let guards = 0, retried = false
  const f = await fixture({ connectTimeout: 40, autoReconnect: false, beforeHandshake: async () => { if (++guards === 1) { entered.resolve(); await release.promise } } })
  f.client.onConnectionStateChanged(state => { if (!retried && state.status === 'failed' && state.lastError?.code === 'HANDSHAKE_TIMEOUT') { retried = true; f.client.reconnectNow() } })
  const restored = waitState(f.client, state => state.status === 'connected')
  const old = f.client.invoke('echo').then(() => null, error => error); await entered.promise; await restored
  expect(String(await old)).toContain('Connection timeout'); release.resolve(); await Bun.sleep(0)
  expect(await f.client.invoke('echo', 'fresh')).toBe('fresh'); expect(f.peers[0]!.frames).toHaveLength(0); expect(f.peers).toHaveLength(2)
})

it('a connected socket closed with 4005 becomes auth-terminal without automatic replay', async () => {
  const f = await fixture(); expect(await f.client.invoke('echo', 'ready')).toBe('ready')
  const denied = waitState(f.client, closedAuth); f.peers[0]!.ws.close(4005, 'Auth failed'); const state = await denied
  expect(state.lastError?.kind).toBe('auth'); expect(f.client.isConnected).toBe(false); expect((f.client as any).reconnectTimer).toBeNull()
  await expect(f.client.invoke('echo', 'must not reconnect')).rejects.toThrow('Auth failed'); expect(f.peers).toHaveLength(1)
})

it('heartbeat watchdog recovery still reconnects and revalidates before a fresh token handshake', async () => {
  let checks = 0, connections = 0
  const f = await fixture({ heartbeatIntervalMs: 25, heartbeatTimeoutMs: 35, beforeHandshake: () => { checks++; return true } }, (ws, frame) => {
    ws.send(JSON.stringify({ id: frame.id, type: 'handshake_ack', protocolVersion: PROTOCOL_VERSION, clientId: `heartbeat-${connections}`, registeredChannels: ['echo'], supportsAppPing: true })); return false
  }, ws => {
    const ordinal = ++connections
    ws.on('message', raw => { const frame = JSON.parse(raw.toString()); if (ordinal > 1 && frame.type === 'ping') ws.send(JSON.stringify({ type: 'pong', id: frame.id })) })
  })
  expect(await f.client.invoke('echo', 'initial')).toBe('initial')
  await waitState(f.client, state => state.status === 'reconnecting' && state.lastError?.code === 'HEARTBEAT_TIMEOUT')
  await waitState(f.client, state => state.status === 'connected')
  await waitState(f.client, state => state.status === 'connected' && !!state.lastHeartbeatAt)
  expect(checks).toBe(2); expect(await f.client.invoke('echo', 'alive')).toBe('alive'); expect(frames(f.peers).filter(frame => frame.type === 'handshake')).toHaveLength(2)
})
