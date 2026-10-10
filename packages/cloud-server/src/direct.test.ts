import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startCloudServer } from './server'
import { WsRpcServer } from '../../server-core/src/transport/server'
import { WsRpcClient } from '../../server-core/src/transport/client'
import { CloudClient } from '../../server-core/src/cloud/client'
import { createNodeCloudPeer } from '../../server-core/src/cloud/peer-node'
import { saveCloudConfig } from '../../server-core/src/cloud/storage'
import type { CloudPeerFactory } from '../../server-core/src/cloud/peer'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
async function until(predicate: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await Bun.sleep(10) }
}
async function fixture(options: { directEnabled?: boolean; factory?: CloudPeerFactory; expiresIn?: number } = {}) {
  const previous = process.env.TOKENBIRD_CONFIG_DIR
  const directory = mkdtempSync(join(tmpdir(), 'tokenbird-direct-'))
  process.env.TOKENBIRD_CONFIG_DIR = directory
  cleanup.push(() => { if (previous === undefined) delete process.env.TOKENBIRD_CONFIG_DIR; else process.env.TOKENBIRD_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
  const adminKey = 'direct-test-admin-key-at-least-32-characters'
  const cloud = startCloudServer({ publicUrl: 'http://127.0.0.1:0', port: 0, databasePath: ':memory:', adminKey,
    iceServers: [], directEnabled: options.directEnabled,
    authenticate: async token => { if (token !== 'owner') throw new Error('Authentication required'); return { subject: token, expiresAt: Date.now() + (options.expiresIn ?? 3600_000) } },
    recordDevice: async () => {},
  })
  cleanup.push(() => cloud.stop())
  const origin = `http://127.0.0.1:${cloud.server.port}`
  let calls = 0
  const rpc = new WsRpcServer({ host: '127.0.0.1', port: 0, requireAuth: true, validateToken: async token => token === 'host-only-secret' })
  rpc.handle('echo', async (_ctx, input: string) => { calls++; return input })
  rpc.handle('capability', ctx => rpc.invokeClientWithTimeout(ctx.clientId, 'client:echo', 5000, 'host request'))
  await rpc.listen()
  cleanup.push(() => rpc.close())
  const host = new CloudClient({ url: `ws://127.0.0.1:${rpc.port}`, token: 'host-only-secret' })
  cleanup.push(() => host.stop())
  host.request = async <T>(path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(origin + path, { method, headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json() as T
  }
  saveCloudConfig({ serverUrl: origin, connectionSlug: 'test', deviceName: 'Direct host', remoteEnabled: true })
  host.start()
  await until(() => host.status.connected)
  // Host capability announcement precedes subsequent cloud REST/WS admission.
  const grant = await host.request<{ url: string; token: string }>(`/v1/devices/${host.status.deviceId}/connect`, 'POST')
  const client = new WsRpcClient(grant.url, { token: grant.token, autoReconnect: false, cloudPeerFactory: options.factory ?? createNodeCloudPeer,
    useNodeWebSocket: true, clientCapabilities: ['client:echo'], requestTimeout: 15_000 })
  client.handleCapability('client:echo', input => ({ input }))
  cleanup.push(() => client.destroy())
  const login = await fetch(origin + '/admin/api/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: adminKey }) })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  async function state() { return await (await fetch(origin + '/admin/api/state', { headers: { Cookie: cookie } })).json() as { stats: { relayedBytes: number; directClients: number; signalingBytes: number }; connections: Array<{ role: string; id: string }>; csrf: string } }
  return { client, host, rpc, origin, state, cookie, get calls() { return calls } }
}

test('real WebRTC RPC bypasses relay bytes, carries large Unicode data and capabilities, and revocation closes access', async () => {
  const f = await fixture()
  f.client.connect()
  expect(await f.client.invoke('echo', 'direct works')).toBe('direct works')
  expect(f.client.getConnectionState().dataPath).toBe('direct')
  const before = await f.state()
  expect(before.stats.directClients).toBe(1)
  expect(before.stats.signalingBytes).toBeGreaterThan(0)
  const large = '中文🙂"\\'.repeat(80_000)
  expect(await f.client.invoke('echo', large)).toBe(large)
  expect(await f.client.invoke('capability')).toEqual({ input: 'host request' })
  expect((await f.state()).stats.relayedBytes).toBe(before.stats.relayedBytes)
  expect(f.calls).toBe(2)
  await f.host.request(`/v1/devices/${f.host.status.deviceId}`, 'DELETE')
  await until(() => f.client.getConnectionState().status === 'disconnected')
  await expect(f.client.invoke('echo', 'revoked')).rejects.toThrow()
}, 30_000)

test('unavailable peer automatically falls back before executing RPC, without duplicate calls', async () => {
  const f = await fixture({ factory: async () => { throw new Error('UDP transport unavailable') } })
  f.client.connect()
  expect(await f.client.invoke('echo', 'fallback')).toBe('fallback')
  expect(f.client.getConnectionState().dataPath).toBe('relay')
  expect(f.calls).toBe(1)
  expect((await f.state()).stats.relayedBytes).toBeGreaterThan(0)
}, 15_000)

test('cloud direct switch off preserves existing relay clients', async () => {
  const f = await fixture({ directEnabled: false })
  f.client.connect()
  expect(await f.client.invoke('echo', 'relay')).toBe('relay')
  expect(f.client.getConnectionState().dataPath).toBe('relay')
  expect(f.calls).toBe(1)
})

test('administrator disconnect closes an established direct peer', async () => {
  const f = await fixture()
  f.client.connect()
  await f.client.invoke('echo', 'admitted')
  expect(f.client.getConnectionState().dataPath).toBe('direct')
  const state = await f.state()
  const connection = state.connections.find(row => row.role === 'client')!
  const response = await fetch(f.origin + '/admin/api/connections/' + connection.id, { method: 'DELETE', headers: { Origin: f.origin, Cookie: f.cookie, 'X-CSRF-Token': state.csrf } })
  expect(response.status).toBe(200)
  await until(() => f.client.getConnectionState().status === 'disconnected')
  expect((await f.state()).stats.directClients).toBe(0)
  expect(f.calls).toBe(1)
  // Disconnect permits a new admission; revocation (tested above) does not.
  expect(await f.client.invoke('echo', 'reconnected')).toBe('reconnected')
}, 15_000)

test('short-lived authorization closes an established direct connection', async () => {
  const f = await fixture({ expiresIn: 6500 })
  f.client.connect()
  await f.client.invoke('echo', 'admitted')
  expect(f.client.getConnectionState().dataPath).toBe('direct')
  await until(() => f.client.getConnectionState().status === 'disconnected', 8000)
  expect((await f.state()).stats.directClients).toBe(0)
  await expect(f.client.invoke('echo', 'expired')).rejects.toThrow()
  expect(f.calls).toBe(1)
}, 15_000)

test('invalid tickets and rejected host guards cannot start direct negotiation', async () => {
  const f = await fixture()
  const url = `ws://127.0.0.1:${new URL(f.origin).port}/v1/connect/${f.host.status.deviceId}`
  const unauthorized = new WsRpcClient(url, { token: 'invalid-ticket', cloudPeerFactory: createNodeCloudPeer, autoReconnect: false })
  cleanup.push(() => unauthorized.destroy())
  await expect(unauthorized.invoke('echo', 'unauthorized')).rejects.toThrow()
  f.client.setHandshakeGuard(() => false)
  await expect(f.client.invoke('echo', 'guarded')).rejects.toThrow()
  expect((await f.state()).stats.signalingBytes).toBe(0)
  expect(f.calls).toBe(0)
})

test('loss of a selected direct channel reconnects by relay without replaying business calls', async () => {
  let failPeer: (() => void) | undefined
  let creations = 0
  const f = await fixture({ factory: async events => {
    creations++
    const peer = await createNodeCloudPeer(events)
    failPeer = () => { peer.close(); events.onClose() }
    return peer
  } })
  f.client.connect()
  expect(await f.client.invoke('echo', 'first')).toBe('first')
  expect(f.client.getConnectionState().dataPath).toBe('direct')
  failPeer!()
  await until(() => f.client.getConnectionState().status === 'disconnected')
  expect(await f.client.invoke('echo', 'second')).toBe('second')
  expect(f.client.getConnectionState().dataPath).toBe('relay')
  expect(creations).toBe(1)
  expect(f.calls).toBe(2)
}, 15_000)
