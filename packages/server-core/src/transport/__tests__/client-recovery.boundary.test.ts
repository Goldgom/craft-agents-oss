import { afterEach, describe, expect, it } from 'bun:test'
import type { WebSocket } from 'ws'
import { WsRpcClient } from '../client'
import { WsRpcServer } from '../server'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const action of cleanup.splice(0).reverse()) action()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 2_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

async function fixture(validateToken?: () => Promise<boolean>, autoReconnect = false, connectTimeout = 2_000) {
  const server = new WsRpcServer({
    host: '127.0.0.1', port: 0, requireAuth: true,
    validateToken: validateToken ?? (async () => true),
  })
  await server.listen()
  cleanup.push(() => server.close())
  const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
    token: 'synthetic-recovery-token', workspaceId: 'main', autoReconnect,
    requestTimeout: 2_000, connectTimeout, maxReconnectDelay: 100,
  })
  cleanup.push(() => client.destroy())
  server.handle('synthetic:echo', async (_ctx, value: string) => value)
  return { server, client }
}

function expectTerminalCleanup(client: WsRpcClient) {
  const state = client as unknown as Record<string, unknown>
  for (const key of ['ws', 'reconnectTimer', 'connectTimer', 'backoffResetTimer', 'heartbeatTimer', 'heartbeatPendingTimer', 'ackTimer', 'readyPromise']) {
    expect(state[key]).toBeNull()
  }
  expect((state.pending as Map<string, unknown>).size).toBe(0)
  expect((state.connectionStateListeners as Set<unknown>).size).toBe(0)
  expect(client.getConnectionState().lastError?.code).toBe('CLIENT_DESTROYED')
}

describe('real client cancellation and reconnect races', () => {
  it('allows explicit connection from idle and bypasses a scheduled backoff with no active socket', async () => {
    let attempts = 0
    const { client, server } = await fixture(async () => { attempts++; return true }, true)
    client.reconnectNow()
    await until(() => client.isConnected, 'manual idle connection')
    const connections = (server as unknown as { clients: Map<string, { ws: WebSocket }> }).clients
    for (const connection of connections.values()) connection.ws.terminate()
    await until(() => client.getConnectionState().nextRetryInMs === 100, 'automatic backoff')
    client.reconnectNow()
    expect(client.getConnectionState().nextRetryInMs).toBeUndefined()
    await expect(client.invoke('synthetic:echo', 'manual recovery')).resolves.toBe('manual recovery')
    expect(attempts).toBe(2)
  })

  it('settles a pre-handshake invoke on destroy and ignores late successful authentication', async () => {
    const entered = deferred()
    const release = deferred()
    const completed = deferred()
    cleanup.push(release.resolve)
    const { client, server } = await fixture(async () => {
      entered.resolve()
      await release.promise
      completed.resolve()
      return true
    })
    const pending = client.invoke('synthetic:echo', 'must not execute').then(() => null, error => error)
    await entered.promise
    client.destroy()
    expect(String(await pending)).toContain('Client destroyed')
    release.resolve()
    await completed.promise
    await Bun.sleep(10)
    expect(server.getConnectedClientCount()).toBe(0)
    expectTerminalCleanup(client)
    client.connect()
    client.reconnectNow()
    await expect(client.invoke('synthetic:echo', 'after destroy')).rejects.toThrow('Client destroyed')
    expectTerminalCleanup(client)
  })

  it('reconnects during delayed authentication without admitting the stale socket or stranding its invoke', async () => {
    const entered = deferred()
    const release = deferred()
    cleanup.push(release.resolve)
    let attempts = 0
    const { client, server } = await fixture(async () => {
      if (++attempts === 1) { entered.resolve(); await release.promise }
      return true
    })
    const old = client.invoke('synthetic:echo', 'old').then(() => null, error => error)
    await entered.promise
    client.reconnectNow()
    expect(String(await old)).toContain('Connection lost before handshake')
    await until(() => client.isConnected, 'replacement handshake')
    await expect(client.invoke('synthetic:echo', 'fresh')).resolves.toBe('fresh')
    release.resolve()
    await Bun.sleep(10)
    expect(attempts).toBe(2)
    expect(server.getConnectedClientCount()).toBe(1)
    client.destroy()
    expectTerminalCleanup(client)
  })

  it('rejects an interrupted invocation once and ignores its late response after repeated reconnect clicks', async () => {
    const { client, server } = await fixture()
    const entered = deferred()
    const release = deferred()
    cleanup.push(release.resolve)
    let settlements = 0
    server.handle('synthetic:hold', async () => { entered.resolve(); await release.promise; return 'old response' })
    await expect(client.invoke('synthetic:echo', 'connected')).resolves.toBe('connected')
    const pending = client.invoke('synthetic:hold').then(value => { settlements++; return value }, error => { settlements++; return error })
    await entered.promise
    client.reconnectNow()
    client.reconnectNow()
    expect(String(await pending)).toContain('Connection lost')
    await until(() => client.isConnected, 'manual reconnect')
    await expect(client.invoke('synthetic:echo', 'new response')).resolves.toBe('new response')
    release.resolve()
    const internal = server as unknown as { activeHandlerTimeouts: Set<unknown> }
    await until(() => internal.activeHandlerTimeouts.size === 0, 'old handler to release its timeout')
    expect(settlements).toBe(1)
    expect(server.getConnectedClientCount()).toBe(1)
    expect((client as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
  })

  it('cancels a scheduled reconnect on destroy and releases every client timer', async () => {
    let attempts = 0
    const { client, server } = await fixture(async () => { attempts++; return true }, true)
    await expect(client.invoke('synthetic:echo', 'connected')).resolves.toBe('connected')
    const connections = (server as unknown as { clients: Map<string, { ws: WebSocket }> }).clients
    for (const connection of connections.values()) connection.ws.terminate()
    await until(() => client.getConnectionState().status === 'reconnecting', 'scheduled reconnect')
    expect(client.getConnectionState().nextRetryInMs).toBe(100)
    client.destroy()
    await Bun.sleep(150)
    expect(attempts).toBe(1)
    expect(server.getConnectedClientCount()).toBe(0)
    expectTerminalCleanup(client)
  })

  it('allows manual recovery after a handshake timeout without admitting the late first authentication', async () => {
    const release = deferred()
    cleanup.push(release.resolve)
    let attempts = 0
    const { client, server } = await fixture(async () => {
      if (++attempts === 1) await release.promise
      return true
    }, false, 75)
    await expect(client.invoke('synthetic:echo', 'timed out')).rejects.toThrow('Connection timeout')
    expect(client.getConnectionState().status).toBe('failed')
    client.reconnectNow()
    await expect(client.invoke('synthetic:echo', 'recovered')).resolves.toBe('recovered')
    release.resolve()
    await Bun.sleep(10)
    expect(attempts).toBe(2)
    expect(server.getConnectedClientCount()).toBe(1)
  })

  it('does not suppress Retry when a failed state still owns a stale CONNECTING socket', async () => {
    const { client, server } = await fixture()
    client.connect()
    const internal = client as unknown as {
      ws: WebSocket
      connectionState: ReturnType<WsRpcClient['getConnectionState']>
      connectError: Error
    }
    expect(internal.ws.readyState).toBe(internal.ws.CONNECTING)
    // Inject the native-runtime ordering where timeout/error is published
    // before a CONNECTING socket reports close. Recovery must replace it.
    internal.connectionState = {
      ...client.getConnectionState(), status: 'failed',
      lastError: { kind: 'timeout', code: 'HANDSHAKE_TIMEOUT', message: 'Synthetic timeout before close' },
    }
    internal.connectError = new Error('Synthetic timeout before close')
    client.reconnectNow()
    await expect(client.invoke('synthetic:echo', 'recovered from stale socket')).resolves.toBe('recovered from stale socket')
    expect(client.getConnectionState().status).toBe('connected')
    expect(server.getConnectedClientCount()).toBe(1)
  })

  it('destroys a replacement connection during authentication without reviving it later', async () => {
    const entered = deferred()
    const release = deferred()
    cleanup.push(release.resolve)
    let attempts = 0
    const { client, server } = await fixture(async () => {
      if (++attempts === 2) { entered.resolve(); await release.promise }
      return true
    })
    await expect(client.invoke('synthetic:echo', 'connected')).resolves.toBe('connected')
    client.reconnectNow()
    await entered.promise
    const pending = client.invoke('synthetic:echo', 'replacement').then(() => null, error => error)
    client.destroy()
    expect(String(await pending)).toContain('Client destroyed')
    release.resolve()
    await until(() => server.getConnectedClientCount() === 0, 'canceled replacement to disappear')
    await Bun.sleep(10)
    expect(server.getConnectedClientCount()).toBe(0)
    expect(attempts).toBe(2)
    expectTerminalCleanup(client)
  })
})
