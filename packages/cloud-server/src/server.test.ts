import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { startCloudServer } from './server'
import { WsRpcServer } from '../../server-core/src/transport/server'
import { WsRpcClient } from '../../server-core/src/transport/client'
import { CloudClient } from '../../server-core/src/cloud/client'
import { CLIENT_REMOTE_ACCESS, CLIENT_REQUEST_FILES } from '../../server-core/src/transport/capabilities'
import { TurnClientContexts } from '../../server-core/src/sessions/turn-client-context'
import { saveClientFiles } from '../../server-core/src/sessions/client-files'
import { saveCloudConfig } from '../../server-core/src/cloud/storage'
import type { CloudConfig } from '../../shared/src/cloud/types'

const cleanup: Array<() => void> = []
const serviceKey = 'test-service-key-at-least-32-characters'
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
function createCloud(databasePath = ':memory:') {
  const records: Array<{ owner: string; online: boolean }> = []
  const cloud = startCloudServer({ publicUrl: 'http://127.0.0.1:0', port: 0, databasePath, serviceKey,
    authenticate: async token => { if (!['alpha', 'beta'].includes(token)) throw new Error('Authentication required'); return { subject: token, expiresAt: Date.now() + 3600_000 } },
    recordDevice: async (owner, device) => { records.push({ owner, online: device.online }) },
  })
  cleanup.push(() => cloud.stop())
  const origin = `http://127.0.0.1:${cloud.server.port}`
  async function request(path: string, method = 'GET', body?: unknown, token = 'alpha') {
    return fetch(origin + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  }
  return { cloud, request, origin, records }
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 5000
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await Bun.sleep(10) }
}

describe('cloud relay and chat snapshots', () => {
  test('service authentication requires a Bearer key and revoked ownership survives restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tokenbird-cloud-restart-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const database = join(directory, 'cloud.sqlite')
    const first = createCloud(database)
    const device = { deviceId: randomUUID(), deviceSecret: 'c'.repeat(64), name: 'Persistent host' }
    const registered = await (await first.request('/v1/devices/register', 'POST', device)).json() as { tunnelToken: string }
    const endpoint = `/v1/internal/devices/${device.deviceId}/revoke`
    expect((await first.request(endpoint, 'POST', { subject: 'alpha' }, 'alpha')).status).toBe(401)
    expect((await fetch(first.origin + endpoint, { method: 'POST', headers: { Authorization: serviceKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: 'alpha' }) })).status).toBe(401)
    expect((await first.request(endpoint, 'POST', { subject: 'beta' }, serviceKey)).status).toBe(404)
    expect((await first.request(endpoint, 'POST', { subject: 'alpha' }, serviceKey)).status).toBe(200)
    expect((await first.request(`/v1/devices/${device.deviceId}/heartbeat`, 'POST', { deviceSecret: device.deviceSecret })).status).toBe(403)
    first.cloud.stop(); cleanup.pop()
    const second = createCloud(database)
    expect((await second.request('/v1/devices/register', 'POST', device)).status).toBe(403)
    expect((await second.request('/v1/devices/register', 'POST', { ...device, enable: true }, 'beta')).status).toBe(403)
    expect((await second.request('/v1/devices/register', 'POST', { ...device, enable: true })).status).toBe(200)
    expect((await second.request(`/v1/tunnel/${device.deviceId}`, 'GET', undefined, registered.tunnelToken)).status).toBe(401)
  })

  test('host grants expire and hostile browser origins cannot upgrade a tunnel', async () => {
    const cloud = createCloud()
    const device = { deviceId: randomUUID(), deviceSecret: 'd'.repeat(64), name: 'Host' }
    const registered = await (await cloud.request('/v1/devices/register', 'POST', device)).json() as { tunnelToken: string }
    const path = `/v1/tunnel/${device.deviceId}`
    expect((await fetch(cloud.origin + path, { headers: { Origin: 'https://evil.example', Authorization: `Bearer ${registered.tunnelToken}` } })).status).toBe(403)
    const now = Date.now()
    const clock = spyOn(Date, 'now').mockReturnValue(now + 10 * 60_000 + 1)
    try { expect((await cloud.request(path, 'GET', undefined, registered.tunnelToken)).status).toBe(401) } finally { clock.mockRestore() }
  })

  test('shares persist, escape scripts, isolate owners and revoke public copies', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tokenbird-cloud-test-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const database = join(directory, 'cloud.sqlite')
    const first = createCloud(database)
    const response = await first.request('/v1/shares', 'POST', { title: '<script>title</script>', messages: [{ role: 'user', content: '<script>alert(1)</script>' }, { role: 'assistant', content: 'hello' }] })
    expect(response.status).toBe(201)
    const share = await response.json() as { id: string; url: string }
    const page = await fetch(share.url)
    const html = await page.text()
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(page.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    expect(await (await first.request('/v1/shares', 'GET', undefined, 'beta')).json()).toEqual([])
    await first.request(`/v1/shares/${share.id}`, 'DELETE', undefined, 'beta')
    expect((await fetch(share.url)).status).toBe(200)
    first.cloud.stop(); cleanup.pop()
    const second = createCloud(database)
    expect((await second.request(`/s/${share.id}`)).status).toBe(200)
    await second.request(`/v1/shares/${share.id}`, 'DELETE')
    expect((await second.request(`/s/${share.id}`)).status).toBe(404)
  })

  test('real RPC travels through an outbound tunnel; unauthorized accounts fail and website revocation persists', async () => {
    const originalConfig = process.env.TOKENBIRD_CONFIG_DIR
    const directory = mkdtempSync(join(tmpdir(), 'tokenbird-cloud-device-'))
    process.env.TOKENBIRD_CONFIG_DIR = directory
    cleanup.push(() => { if (originalConfig === undefined) delete process.env.TOKENBIRD_CONFIG_DIR; else process.env.TOKENBIRD_CONFIG_DIR = originalConfig; rmSync(directory, { recursive: true, force: true }) })
    const cloud = createCloud()
    const localSecret = 'local-secret-never-sent-to-cloud'
    const rpc = new WsRpcServer({ host: '127.0.0.1', port: 0, requireAuth: true, validateToken: async value => value === localSecret })
    const turnClients = new TurnClientContexts()
    rpc.handle('test:files', async (ctx) => {
      turnClients.bind('test-session', turnClients.capture(rpc, { callerClientId: ctx.clientId }))
      const clientId = turnClients.requireClient(rpc, 'test-session', 'default', CLIENT_REQUEST_FILES)
      const selected = await rpc.invokeClientWithTimeout(clientId, CLIENT_REQUEST_FILES, 5000, { reason: 'Read the selected report' })
      return { reminder: turnClients.reminder(rpc, 'test-session'), result: await saveClientFiles(join(directory, 'files'), selected) }
    })
    rpc.handle('test:echo', async (_ctx, input: string) => ({ echo: input }))
    await rpc.listen()
    cleanup.push(() => rpc.close())
    const host = new CloudClient({ url: `ws://127.0.0.1:${rpc.port}`, token: localSecret })
    cleanup.push(() => host.stop())
    // Test identity provider stands in for the documented TokenNest integration.
    host.request = async <T>(path: string, method = 'GET', body?: unknown, _config?: CloudConfig, signal?: AbortSignal) => {
      const response = await fetch(cloud.origin + path, { method, signal, headers: { Authorization: 'Bearer alpha', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json() as T
    }
    saveCloudConfig({ serverUrl: cloud.origin, connectionSlug: 'test', deviceName: 'Host computer', remoteEnabled: true })
    host.start()
    await until(() => host.status.connected)
    const id = host.status.deviceId
    expect(cloud.records.some(record => record.owner === 'alpha')).toBe(true)
    expect(await (await cloud.request('/v1/devices', 'GET', undefined, 'beta')).json()).toEqual([])
    expect((await cloud.request(`/v1/devices/${id}/connect`, 'POST', undefined, 'beta')).status).toBe(404)
    const grant = await (await cloud.request(`/v1/devices/${id}/connect`, 'POST')).json() as { url: string; token: string }
    expect(JSON.stringify(grant)).not.toContain(localSecret)
    const peer = new WsRpcClient(grant.url, { token: grant.token, autoReconnect: false, workspaceId: 'default', clientCapabilities: [CLIENT_REMOTE_ACCESS, CLIENT_REQUEST_FILES] })
    cleanup.push(() => peer.destroy())
    peer.handleCapability(CLIENT_REQUEST_FILES, async () => ({ canceled: false, files: [{ name: 'report.txt', base64: Buffer.from('client report').toString('base64') }] }))
    await peer.connect()
    expect(await peer.invoke('test:echo', 'cloud works')).toEqual({ echo: 'cloud works' })
    const fileRequest = await peer.invoke('test:files') as { reminder: string; result: { files: Array<{ path: string }> } }
    expect(fileRequest.reminder).toContain('REMOTE ACCESS')
    expect(await Bun.file(fileRequest.result.files[0]!.path).text()).toBe('client report')

    const badPeer = new WebSocket(grant.url)
    cleanup.push(() => badPeer.terminate())
    const closeCode = new Promise<number>(resolve => badPeer.on('close', resolve))
    badPeer.on('open', () => badPeer.send(JSON.stringify({ type: 'handshake', token: 'wrong-token' })))
    expect(await closeCode).toBe(1008)
    expect((await cloud.request(`/v1/internal/devices/${id}/connect`, 'POST', { subject: 'beta' }, serviceKey)).status).toBe(404)
    const website = await cloud.request(`/v1/internal/devices/${id}/connect`, 'POST', { subject: 'alpha' }, serviceKey)
    expect(website.status).toBe(200)
    expect((await website.json() as { browserUrl: string }).browserUrl).toContain('#ticket=')
    await cloud.request(`/v1/internal/devices/${id}/revoke`, 'POST', { subject: 'alpha' }, serviceKey)
    await until(() => !host.status.connected)
    await until(() => peer.getConnectionState().status === 'disconnected')
    await expect(host.request('/v1/devices/register', 'POST', { deviceId: id, deviceSecret: JSON.parse(await Bun.file(join(directory, 'cloud-server.json')).text()).deviceSecret, name: 'Host computer' })).rejects.toThrow('HTTP 403')
    expect((await cloud.request(`/v1/devices/${id}/connect`, 'POST')).status).toBe(409)
  })

  test('device ownership and proof cannot be replaced by another account', async () => {
    const cloud = createCloud()
    const device = { deviceId: randomUUID(), deviceSecret: 'a'.repeat(64), name: 'Device' }
    expect((await cloud.request('/v1/devices/register', 'POST', device)).status).toBe(200)
    expect((await cloud.request('/v1/devices/register', 'POST', device, 'beta')).status).toBe(403)
    expect((await cloud.request('/v1/devices/register', 'POST', { ...device, deviceSecret: 'b'.repeat(64) })).status).toBe(403)
    expect((await cloud.request(`/v1/devices/${device.deviceId}/heartbeat`, 'POST', { deviceSecret: 'b'.repeat(64) })).status).toBe(403)
    expect((await cloud.request('/v1/devices', 'GET', undefined, 'invalid')).status).not.toBe(200)
  })
})
