import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startCloudServer, type CloudServerOptions } from './server'
import { DEFAULT_LIMITS } from './limits'

const adminKey = 'admin-secret-' + 'a'.repeat(32)
const serviceKey = 'service-secret-' + 'b'.repeat(32)
const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })

function createCloud(overrides: Partial<CloudServerOptions> = {}) {
  const cloud = startCloudServer({ publicUrl: 'http://127.0.0.1:0', port: 0, databasePath: ':memory:', adminKey, serviceKey,
    authenticate: async token => ({ subject: token.startsWith('alpha') ? 'alpha' : 'beta', expiresAt: Date.now() + 3600_000 }),
    recordDevice: async () => {}, ...overrides,
  })
  cleanup.push(() => cloud.stop())
  const origin = `http://127.0.0.1:${cloud.server.port}`
  let cookie = '', csrf = ''
  async function admin(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return fetch(origin + '/admin/api/' + path, { method, headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  }
  async function state() { return await (await admin('state')).json() as any }
  async function login() {
    const response = await admin('session', 'POST', { key: adminKey })
    expect(response.status).toBe(200)
    cookie = response.headers.get('Set-Cookie')!.split(';')[0]
    csrf = (await state()).csrf
    return response
  }
  async function request(path: string, method = 'GET', body?: unknown, token = 'alpha') {
    return fetch(origin + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  }
  async function register(name = 'Host', deviceId = randomUUID(), token = 'alpha') {
    const device = { deviceId, deviceSecret: 'c'.repeat(64), name }
    const response = await request('/v1/devices/register', 'POST', device, token)
    expect(response.status).toBe(200)
    return { ...device, ...await response.json() as { tunnelUrl: string; tunnelToken: string } }
  }
  async function socket(url: string, token?: string) {
    const ws = new WebSocket(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
    cleanup.push(() => ws.terminate())
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    return ws
  }
  return { cloud, origin, admin, login, request, register, socket, state }
}

test('admin is disabled without an independent key; keys are validated', async () => {
  const cloud = createCloud({ adminKey: undefined })
  expect((await cloud.admin('state')).status).toBe(503)
  expect((await fetch(cloud.origin + '/admin')).status).toBe(200)
  expect(() => createCloud({ adminKey: serviceKey })).toThrow('differ')
  expect(() => createCloud({ adminKey: 'short' })).toThrow('32')
})

test('admin sessions protect mutations and never expose secrets', async () => {
  const cloud = createCloud()
  expect((await cloud.admin('state')).status).toBe(401)
  expect((await cloud.admin('state', 'GET', undefined, { Authorization: `Bearer ${serviceKey}` })).status).toBe(401)
  expect((await cloud.admin('session', 'POST', { key: adminKey }, { Origin: 'https://evil.example' })).status).toBe(403)
  expect((await cloud.admin('session', 'POST', { key: serviceKey })).status).toBe(401)
  const login = await cloud.login()
  expect(login.headers.get('Set-Cookie')).toContain('HttpOnly; SameSite=Strict')
  const device = await cloud.register('<script>alert(1)</script>')
  const state = await cloud.state()
  expect(state.devices[0].name).toBe(device.name)
  expect(state.devices[0].owner).toBe('alpha')
  expect(JSON.stringify(state)).not.toContain(device.deviceSecret)
  expect(JSON.stringify(state)).not.toContain(device.tunnelToken)
  expect(JSON.stringify(state)).not.toContain(adminKey)
  expect(JSON.stringify(state)).not.toContain(serviceKey)
  expect(state.devices[0].secret).toBeUndefined()
  expect((await cloud.admin('limits', 'PUT', DEFAULT_LIMITS, { 'X-CSRF-Token': '' })).status).toBe(403)
  expect((await cloud.admin('limits', 'PUT', DEFAULT_LIMITS, { Origin: 'https://evil.example' })).status).toBe(403)
  const page = await fetch(cloud.origin + '/admin')
  expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  expect(page.headers.get('Content-Security-Policy')).toContain("script-src 'nonce-")
  const html = await page.text()
  expect(html).not.toContain(device.name)
  expect(html).toContain('<h1>词元鸟 · 云端管理</h1>')
  expect(html).not.toContain('\\u8BCD')
  const search = await (await cloud.admin('state?search=' + encodeURIComponent('<script>'))).json() as any
  expect(search.total).toBe(1)
  expect((await cloud.admin('session', 'DELETE')).status).toBe(200)
  expect((await cloud.admin('state')).status).toBe(401)
})

test('admin login is throttled and secure cookies are used for HTTPS', async () => {
  const cloud = createCloud({ publicUrl: 'https://cloud.example' })
  for (let i = 0; i < 10; i++) expect((await cloud.admin('session', 'POST', { key: 'wrong' }, { Origin: 'https://cloud.example' })).status).toBe(401)
  expect((await cloud.admin('session', 'POST', { key: adminKey }, { Origin: 'https://cloud.example' })).status).toBe(429)
  const other = createCloud({ publicUrl: 'https://cloud.example' })
  const response = await other.admin('session', 'POST', { key: adminKey }, { Origin: 'https://cloud.example' })
  expect(response.headers.get('Set-Cookie')).toContain('; Secure')
})

test('limits persist, reject invalid updates, and apply by account across credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokenbird-admin-test-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const databasePath = join(directory, 'cloud.sqlite')
  const first = createCloud({ databasePath })
  await first.login()
  const { maxHosts: _omitted, ...missingHostLimit } = DEFAULT_LIMITS
  for (const body of [{ ...DEFAULT_LIMITS, maxHosts: 0 }, { ...DEFAULT_LIMITS, apiRequestsPerMinute: 1.5 }, { ...DEFAULT_LIMITS, extra: 1 }, { ...missingHostLimit, toString: 1 }, {}]) {
    expect((await first.admin('limits', 'PUT', body)).status).toBe(400)
  }
  expect((await first.admin('limits', 'PUT', { ...DEFAULT_LIMITS, apiRequestsPerMinute: 2 })).status).toBe(200)
  expect((await first.request('/v1/devices', 'GET', undefined, 'alpha-1')).status).toBe(200)
  expect((await first.request('/v1/devices', 'GET', undefined, 'alpha-2')).status).toBe(200)
  const limited = await first.request('/v1/devices', 'GET', undefined, 'alpha-3')
  expect(limited.status).toBe(429)
  expect(limited.headers.get('Retry-After')).toBe('60')
  expect((await first.request('/v1/devices', 'GET', undefined, 'beta')).status).toBe(200)
  expect((await first.admin('state')).status).toBe(200)
  expect((await fetch(first.origin + '/healthz')).status).toBe(200)
  expect((await first.state()).stats.rejectedRequests).toBe(1)
  first.cloud.stop()
  const second = createCloud({ databasePath })
  await second.login()
  expect((await second.state()).limits.apiRequestsPerMinute).toBe(2)
})

test('admin blocking survives restart and hosting devices cannot enable around it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tokenbird-block-test-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const databasePath = join(directory, 'cloud.sqlite')
  const first = createCloud({ databasePath })
  await first.login()
  const device = await first.register()
  expect((await first.admin('devices/' + device.deviceId + '/block', 'POST')).status).toBe(200)
  const body = { deviceId: device.deviceId, deviceSecret: device.deviceSecret, name: device.name, enable: true }
  expect((await first.request('/v1/devices/register', 'POST', body)).status).toBe(403)
  first.cloud.stop()
  const second = createCloud({ databasePath })
  await second.login()
  expect((await second.state()).devices[0].blocked).toBe(true)
  expect((await second.request('/v1/devices/register', 'POST', body)).status).toBe(403)
  expect((await second.admin('devices/' + device.deviceId + '/unblock', 'POST')).status).toBe(200)
  expect((await second.request('/v1/devices/register', 'POST', body)).status).toBe(200)
  expect((await second.admin('devices/' + device.deviceId + '/revoke', 'POST')).status).toBe(200)
  expect((await second.request('/v1/devices/register', 'POST', { ...body, enable: false })).status).toBe(403)
  expect((await second.request('/v1/devices/register', 'POST', body)).status).toBe(200)
})

test('connection limits cover pending clients, disconnect excess connections, and reject hosts', async () => {
  const cloud = createCloud()
  await cloud.login()
  const device = await cloud.register()
  const host = await cloud.socket(device.tunnelUrl, device.tunnelToken)
  const clientUrl = cloud.origin.replace('http', 'ws') + '/v1/connect/' + device.deviceId
  const first = await cloud.socket(clientUrl)
  const second = await cloud.socket(clientUrl)
  const secondClosed = new Promise<number>(resolve => second.once('close', resolve))
  expect((await cloud.admin('limits', 'PUT', { ...DEFAULT_LIMITS, maxClientsPerDevice: 1, maxHosts: 1 })).status).toBe(200)
  expect(await secondClosed).toBe(1000)
  expect((await cloud.request('/v1/connect/' + device.deviceId)).status).toBe(503)
  const other = await cloud.register('Other')
  expect((await cloud.request('/v1/tunnel/' + other.deviceId, 'GET', undefined, other.tunnelToken)).status).toBe(503)
  const state = await cloud.state()
  expect(state.connections.filter((c: any) => c.role === 'client')).toHaveLength(1)
  const firstClosed = new Promise<number>(resolve => first.once('close', resolve))
  const clientId = state.connections.find((c: any) => c.role === 'client').id
  expect((await cloud.admin('connections/' + clientId, 'DELETE')).status).toBe(200)
  expect(await firstClosed).toBe(1000)
  expect(host.readyState).toBe(WebSocket.OPEN)
  const hostClosed = new Promise<number>(resolve => host.once('close', resolve))
  expect((await cloud.admin('devices/' + device.deviceId + '/disconnect', 'POST')).status).toBe(200)
  expect(await hostClosed).toBe(1000)
  expect((await cloud.state()).stats.hosts).toBe(0)
})

test('transfer limits close authenticated over-limit connections and expose counters', async () => {
  const cloud = createCloud()
  await cloud.login()
  const device = await cloud.register()
  await cloud.socket(device.tunnelUrl, device.tunnelToken)
  const grant = await (await cloud.request('/v1/devices/' + device.deviceId + '/connect', 'POST')).json() as { url: string; token: string }
  const client = await cloud.socket(grant.url)
  const closed = new Promise<number>(resolve => client.once('close', resolve))
  expect((await cloud.admin('limits', 'PUT', { ...DEFAULT_LIMITS, relayBytesPerSecondPerDevice: 10 })).status).toBe(200)
  client.send(JSON.stringify({ type: 'handshake', token: grant.token }))
  expect(await closed).toBe(1013)
  expect((await cloud.state()).stats.rejectedFrames).toBe(1)
  // Invalid unauthenticated traffic must not consume the target device's quota.
  const bad = await cloud.socket(grant.url)
  const badClosed = new Promise<number>(resolve => bad.once('close', resolve))
  bad.send(JSON.stringify({ type: 'handshake', token: 'wrong' }))
  expect(await badClosed).toBe(1008)
  expect((await cloud.state()).stats.rejectedFrames).toBe(1)
})
