import { Database } from 'bun:sqlite'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import type { ServerWebSocket } from 'bun'
import type { CloudDevice, CloudShare, TunnelFrame } from '../../shared/src/cloud/types'
import { normalizeCloudUrl } from '../../shared/src/cloud/types'

export interface CloudIdentity { subject: string; expiresAt: number }
export interface CloudServerOptions {
  publicUrl: string
  databasePath: string
  hostname?: string
  port?: number
  webuiDir?: string
  serviceKey?: string
  authenticate: (token: string) => Promise<CloudIdentity>
  recordDevice: (owner: string, device: CloudDevice) => Promise<void>
}
interface DeviceRow { id: string; owner: string; secret: string; name: string; lastSeen: number; revoked: number }
interface SocketData { role: 'host' | 'client'; deviceId: string; owner?: string; expiresAt: number; authenticated: boolean; streamId?: string; openedAt: number }
interface Ticket { role: 'host' | 'client'; owner: string; deviceId: string; expiresAt: number; identityExpiresAt: number }
const MAX_FRAME = 16 * 1024 * 1024
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const credentialMatches = (value: string, expected: string) => timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(digest(expected), 'hex'))
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })

/** Cloud relay has no agent credentials or execution engine. */
export function startCloudServer(options: CloudServerOptions) {
  if (options.serviceKey && options.serviceKey.length < 32) throw new Error('Cloud service key must contain at least 32 characters')
  if (options.databasePath !== ':memory:') mkdirSync(dirname(options.databasePath), { recursive: true })
  const db = new Database(options.databasePath, { create: true })
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, owner TEXT NOT NULL, secret TEXT NOT NULL, name TEXT NOT NULL, lastSeen INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, messages TEXT NOT NULL, createdAt INTEGER NOT NULL);')
  const columns = db.query<{ name: string }, []>('PRAGMA table_info(devices)').all()
  if (!columns.some(column => column.name === 'revoked')) db.exec('ALTER TABLE devices ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0')
  const hosts = new Map<string, ServerWebSocket<SocketData>>()
  const streams = new Map<string, ServerWebSocket<SocketData>>()
  const tickets = new Map<string, Ticket>()
  const sockets = new Set<ServerWebSocket<SocketData>>()
  const hostLeases = new Map<string, ReturnType<typeof setTimeout>>()
  const clientLeases = new Map<ServerWebSocket<SocketData>, ReturnType<typeof setTimeout>>()
  const registryWrites = new Map<string, Promise<void>>()
  let stopping = false
  let publicUrl = normalizeCloudUrl(options.publicUrl)
  let wsOrigin = publicUrl.replace(/^http/, 'ws')
  const lookup = (id: string) => db.query<DeviceRow, [string]>('SELECT * FROM devices WHERE id=?').get(id)
  const describe = (row: DeviceRow): CloudDevice => ({ id: row.id, name: row.name, lastSeen: row.lastSeen, online: !row.revoked && hosts.has(row.id) && row.lastSeen > Date.now() - 90_000, wsUrl: `${wsOrigin}/v1/connect/${row.id}` })
  function ticket(role: Ticket['role'], identity: CloudIdentity, deviceId: string): string {
    if (tickets.size >= 100_000) throw new Error('Cloud connection capacity reached')
    const value = randomBytes(32).toString('base64url')
    tickets.set(digest(value), { role, owner: identity.subject, deviceId, expiresAt: Math.min(identity.expiresAt, Date.now() + 10 * 60_000), identityExpiresAt: identity.expiresAt })
    return value
  }
  async function identity(req: Request): Promise<CloudIdentity> {
    const token = req.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1]
    if (!token) throw new Error('Authentication required')
    const user = await options.authenticate(token)
    if (!user.subject || !Number.isFinite(user.expiresAt) || user.expiresAt <= Date.now()) throw new Error('TokenNest login expired')
    return user
  }
  function send(ws: ServerWebSocket<SocketData>, payload: unknown): boolean {
    if (ws.readyState !== 1) return false
    if (ws.send(JSON.stringify(payload)) === -1) { ws.close(1013, 'Slow connection'); return false }
    return true
  }
  function disconnectDevice(id: string): void {
    clearTimeout(hostLeases.get(id))
    hostLeases.delete(id)
    const host = hosts.get(id)
    hosts.delete(id)
    if (host && !stopping) db.query('UPDATE devices SET lastSeen=? WHERE id=?').run(Date.now(), id)
    host?.close(1000, 'Remote access disabled')
    for (const [streamId, client] of streams) if (client.data.deviceId === id) { streams.delete(streamId); client.close(1000, 'Device disconnected') }
  }
  async function record(id: string): Promise<void> {
    if (stopping) return
    const row = lookup(id)
    if (!row) return
    // Order snapshots so a slow heartbeat cannot overwrite a later disconnect.
    const device = describe(row)
    const previous = registryWrites.get(id) ?? Promise.resolve()
    const write = previous.catch(() => {}).then(() => options.recordDevice(row.owner, device))
    registryWrites.set(id, write)
    try { await write } finally { if (registryWrites.get(id) === write) registryWrites.delete(id) }
  }
  function renewHostLease(ws: ServerWebSocket<SocketData>): void {
    clearTimeout(hostLeases.get(ws.data.deviceId))
    const row = lookup(ws.data.deviceId)
    const deadline = Math.min((row?.lastSeen ?? 0) + 90_000, ws.data.expiresAt)
    const lease = setTimeout(() => {
      if (hosts.get(ws.data.deviceId) !== ws) return
      disconnectDevice(ws.data.deviceId)
      void record(ws.data.deviceId).catch(() => {})
    }, Math.max(0, deadline - Date.now()))
    lease.unref()
    hostLeases.set(ws.data.deviceId, lease)
  }
  function renewClientLease(ws: ServerWebSocket<SocketData>): void {
    clearTimeout(clientLeases.get(ws))
    const lease = setTimeout(() => ws.close(1008, 'Connection expired'), Math.max(0, ws.data.expiresAt - Date.now()))
    lease.unref()
    clientLeases.set(ws, lease)
  }

  const server = Bun.serve<SocketData>({
    hostname: options.hostname ?? '127.0.0.1', port: options.port ?? 8080,
    maxRequestBodySize: 5 * 1024 * 1024,
    async fetch(req, bunServer) {
      const url = new URL(req.url)
      try {
        if (url.pathname === '/healthz') return json({ status: 'ok', service: 'tokenbird-cloud' })
        const internalMatch = url.pathname.match(/^\/v1\/internal\/devices\/([a-f0-9-]{36})\/(connect|revoke)$/)
        if (internalMatch && req.method === 'POST') {
          const serviceCredential = req.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1]
          if (!options.serviceKey || !serviceCredential || !credentialMatches(serviceCredential, options.serviceKey)) return json({ error: 'Service authentication required' }, 401)
          const body = await req.json() as { subject: string }
          const row = lookup(internalMatch[1])
          if (!row || row.owner !== body.subject) return json({ error: 'Device not found' }, 404)
          if (internalMatch[2] === 'revoke') {
            db.query('UPDATE devices SET revoked=1 WHERE id=?').run(row.id)
            disconnectDevice(row.id)
            for (const [key, grant] of tickets) if (grant.deviceId === row.id) tickets.delete(key)
            await record(row.id)
            return json({ ok: true })
          }
          if (!describe(row).online) return json({ error: 'Device offline' }, 409)
          const token = ticket('client', { subject: row.owner, expiresAt: Date.now() + 60 * 60_000 }, row.id)
          return json({ url: describe(row).wsUrl, token, browserUrl: `${publicUrl}/connect/${row.id}#ticket=${encodeURIComponent(token)}`, expiresAt: Date.now() + 10 * 60_000 })
        }
        const hostMatch = url.pathname.match(/^\/v1\/tunnel\/([a-f0-9-]{36})$/)
        const clientMatch = url.pathname.match(/^\/v1\/connect\/([a-f0-9-]{36})$/)
        if ((hostMatch || clientMatch) && req.headers.has('Origin') && req.headers.get('Origin') !== publicUrl) return json({ error: 'WebSocket origin is not allowed' }, 403)
        if (hostMatch) {
          const key = digest(req.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '')
          const grant = tickets.get(key)
          if (!grant || grant.role !== 'host' || grant.deviceId !== hostMatch[1] || grant.expiresAt <= Date.now()) return json({ error: 'Invalid tunnel grant' }, 401)
          if (lookup(grant.deviceId)?.revoked) return json({ error: 'Device access revoked' }, 403)
          tickets.delete(key)
          if (bunServer.upgrade(req, { data: { role: 'host', deviceId: grant.deviceId, owner: grant.owner, expiresAt: grant.identityExpiresAt, authenticated: true, openedAt: Date.now() } })) return
          return json({ error: 'WebSocket required' }, 400)
        }
        if (clientMatch) {
          // Ticket is in the first RPC handshake, never in a public URL or logs.
          if (bunServer.pendingWebSockets > 10_000) return json({ error: 'Connection capacity reached' }, 503)
          if (bunServer.upgrade(req, { data: { role: 'client', deviceId: clientMatch[1], expiresAt: Date.now() + 10_000, authenticated: false, openedAt: Date.now() } })) return
          return json({ error: 'WebSocket required' }, 400)
        }
        if (url.pathname === '/v1/devices/register' && req.method === 'POST') {
          const user = await identity(req)
          const body = await req.json() as { deviceId: string; deviceSecret: string; name: string; enable?: boolean }
          if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.deviceId) || body.deviceId === '00000000-0000-0000-0000-000000000000' || !/^[a-f0-9]{64}$/.test(body.deviceSecret) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120) return json({ error: 'Invalid device' }, 400)
          const existing = lookup(body.deviceId)
          if (existing && (existing.owner !== user.subject || !timingSafeEqual(Buffer.from(existing.secret, 'hex'), Buffer.from(digest(body.deviceSecret), 'hex')))) return json({ error: 'Device belongs to another account' }, 403)
          if (existing?.revoked && body.enable !== true) return json({ error: 'Remote access revoked; enable it again on the hosting device' }, 403)
          db.query('INSERT INTO devices (id,owner,secret,name,lastSeen,revoked) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET name=excluded.name,lastSeen=excluded.lastSeen,revoked=0').run(body.deviceId, user.subject, digest(body.deviceSecret), body.name, Date.now())
          await record(body.deviceId)
          return json({ device: describe(lookup(body.deviceId)!), tunnelToken: ticket('host', user, body.deviceId), tunnelUrl: `${wsOrigin}/v1/tunnel/${body.deviceId}` })
        }
        if (url.pathname === '/v1/devices' && req.method === 'GET') {
          const user = await identity(req)
          return json(db.query<DeviceRow, [string]>('SELECT * FROM devices WHERE owner=? ORDER BY lastSeen DESC LIMIT 1000').all(user.subject).map(describe))
        }
        const deviceMatch = url.pathname.match(/^\/v1\/devices\/([a-f0-9-]{36})(\/connect|\/heartbeat)?$/)
        if (deviceMatch) {
          const user = await identity(req)
          const row = lookup(deviceMatch[1])
          if (!row || row.owner !== user.subject) return json({ error: 'Device not found' }, 404)
          if (deviceMatch[2] === '/connect' && req.method === 'POST') {
            if (!describe(row).online) return json({ error: 'Device offline' }, 409)
            return json({ url: describe(row).wsUrl, token: ticket('client', user, row.id), expiresAt: Math.min(user.expiresAt, Date.now() + 10 * 60_000) })
          }
          if (deviceMatch[2] === '/heartbeat' && req.method === 'POST') {
            if (row.revoked) return json({ error: 'Device access revoked' }, 403)
            const body = await req.json() as { deviceSecret: string }
            if (typeof body.deviceSecret !== 'string' || !timingSafeEqual(Buffer.from(digest(body.deviceSecret), 'hex'), Buffer.from(row.secret, 'hex'))) return json({ error: 'Invalid device proof' }, 403)
            db.query('UPDATE devices SET lastSeen=? WHERE id=?').run(Date.now(), row.id)
            const host = hosts.get(row.id)
            if (host) { host.data.expiresAt = user.expiresAt; renewHostLease(host) }
            await record(row.id)
            return json({ ok: true })
          }
          if (!deviceMatch[2] && req.method === 'DELETE') {
            db.query('UPDATE devices SET revoked=1 WHERE id=?').run(row.id)
            // Account owner may revoke even when the hosting device is lost.
            disconnectDevice(row.id)
            for (const [key, grant] of tickets) if (grant.deviceId === row.id) tickets.delete(key)
            await record(row.id)
            return json({ ok: true })
          }
        }
        if (url.pathname === '/v1/shares') {
          const user = await identity(req)
          if (req.method === 'GET') return json(db.query<CloudShare, [string]>('SELECT id,title,createdAt FROM shares WHERE owner=? ORDER BY createdAt DESC LIMIT 1000').all(user.subject).map(row => ({ ...row, url: `${publicUrl}/s/${row.id}` })))
          if (req.method === 'POST') {
            const count = db.query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM shares WHERE owner=?').get(user.subject)!.count
            if (count >= 100) return json({ error: 'Revoke older chat shares before creating more' }, 429)
            const body = await req.json() as { title: string; messages: Array<{ role: string; content: string }> }
            if (typeof body.title !== 'string' || body.title.length > 300 || !Array.isArray(body.messages) || body.messages.length > 10_000 || body.messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) return json({ error: 'Invalid chat snapshot' }, 400)
            const id = randomBytes(24).toString('base64url'), createdAt = Date.now()
            db.query('INSERT INTO shares VALUES (?, ?, ?, ?, ?)').run(id, user.subject, body.title, JSON.stringify(body.messages), createdAt)
            return json({ id, title: body.title, createdAt, url: `${publicUrl}/s/${id}` }, 201)
          }
        }
        const shareApi = url.pathname.match(/^\/v1\/shares\/([A-Za-z0-9_-]{32})$/)
        if (shareApi && req.method === 'DELETE') {
          const user = await identity(req)
          db.query('DELETE FROM shares WHERE id=? AND owner=?').run(shareApi[1], user.subject)
          return json({ ok: true })
        }
        const shareView = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{32})$/)
        if (shareView && req.method === 'GET') {
          const row = db.query<{ title: string; messages: string }, [string]>('SELECT title,messages FROM shares WHERE id=?').get(shareView[1])
          if (!row) return json({ error: 'Share unavailable' }, 404)
          const messages = JSON.parse(row.messages) as Array<{ role: string; content: string }>
          return new Response(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(row.title)}</title><style>body{font:16px system-ui;max-width:850px;margin:auto;padding:24px;color:#222;background:#fafafa}article{padding:20px;margin:16px 0;border:1px solid #ddd;border-radius:12px;background:white}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}small{color:#666}</style><h1>${escapeHtml(row.title)}</h1><small>TokenBird · 共享聊天记录 · 只读快照</small>${messages.map(m => `<article><strong>${m.role === 'user' ? '用户' : '助手'}</strong><pre>${escapeHtml(m.content)}</pre></article>`).join('')}</html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
        }
        // Browser device access uses the same built WebUI as the headless host.
        if (options.webuiDir && req.method === 'GET' && !url.pathname.startsWith('/v1/')) {
          const root = resolve(options.webuiDir)
          let filePath = resolve(root, '.' + decodeURIComponent(url.pathname))
          if (filePath !== root && !filePath.startsWith(root + sep)) return json({ error: 'Invalid path' }, 400)
          if (url.pathname === '/' || !await Bun.file(filePath).exists()) filePath = resolve(root, 'index.html')
          return new Response(Bun.file(filePath), { headers: { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } })
        }
        return json({ error: 'Not found' }, 404)
      } catch (error) {
        // Never serialize upstream errors that may contain OAuth tokens.
        const authFailed = error instanceof Error && /Authentication|expired/.test(error.message)
        return json({ error: authFailed ? 'TokenNest authentication required' : 'Cloud request failed; check TokenNest integration' }, authFailed ? 401 : 503)
      }
    },
    websocket: {
      maxPayloadLength: MAX_FRAME, idleTimeout: 70, sendPings: true,
      open(ws) {
        sockets.add(ws)
        if (ws.data.role === 'host') {
          if (lookup(ws.data.deviceId)?.revoked) { ws.close(1008, 'Device access revoked'); return }
          disconnectDevice(ws.data.deviceId)
          hosts.set(ws.data.deviceId, ws)
          renewHostLease(ws)
          void record(ws.data.deviceId).catch(() => ws.close(1011, 'Device registry unavailable'))
        } else renewClientLease(ws)
      },
      message(ws, message) {
        try {
          if (ws.data.expiresAt <= Date.now()) { ws.close(1008, 'Authorization expired'); return }
          const text = typeof message === 'string' ? message : message.toString()
          if (ws.data.role === 'host') {
            const frame = JSON.parse(text) as TunnelFrame
            const client = streams.get(frame.streamId)
            if (!client || client.data.deviceId !== ws.data.deviceId || hosts.get(ws.data.deviceId) !== ws) return
            if (client.data.expiresAt <= Date.now()) { client.close(1008, 'Connection expired'); return }
            if (frame.type === 'data' && typeof frame.data === 'string') {
              if (client.send(frame.data) === -1) client.close(1013, 'Slow connection')
            } else if (frame.type === 'close') client.close(1000, 'Device stream closed')
            return
          }
          const host = hosts.get(ws.data.deviceId)
          if (!host) { ws.close(1008, 'Device offline'); return }
          let data = text
          if (!ws.data.authenticated) {
            const handshake = JSON.parse(text)
            if (handshake.type !== 'handshake' || typeof handshake.token !== 'string') { ws.close(1008, 'Handshake required'); return }
            const grant = tickets.get(digest(handshake.token))
            if (!grant || grant.role !== 'client' || grant.deviceId !== ws.data.deviceId || grant.owner !== host.data.owner || grant.expiresAt <= Date.now()) { ws.close(1008, 'Invalid connection grant'); return }
            if ([...streams.values()].filter(c => c.data.deviceId === ws.data.deviceId).length >= 64) { ws.close(1013, 'Device busy'); return }
            ws.data.authenticated = true
            ws.data.owner = grant.owner
            ws.data.expiresAt = Math.min(grant.identityExpiresAt, Date.now() + 60 * 60_000)
            renewClientLease(ws)
            ws.data.streamId = randomUUID()
            streams.set(ws.data.streamId, ws)
            delete handshake.token
            // Do not let a remote client impersonate a local Electron window.
            delete handshake.webContentsId
            delete handshake.reconnectClientId
            data = JSON.stringify(handshake)
            if (!send(host, { type: 'open', streamId: ws.data.streamId })) { ws.close(1011, 'Tunnel unavailable'); return }
          }
          send(host, { type: 'data', streamId: ws.data.streamId!, data })
        } catch { ws.close(1008, 'Invalid tunnel message') }
      },
      close(ws) {
        sockets.delete(ws)
        clearTimeout(clientLeases.get(ws))
        clientLeases.delete(ws)
        if (ws.data.role === 'host' && hosts.get(ws.data.deviceId) === ws) { disconnectDevice(ws.data.deviceId); if (!stopping) void record(ws.data.deviceId).catch(() => {}) }
        if (ws.data.streamId) { streams.delete(ws.data.streamId); const host = hosts.get(ws.data.deviceId); if (host) send(host, { type: 'close', streamId: ws.data.streamId }) }
      },
    },
  })
  if (new URL(publicUrl).port === '0') {
    const actual = new URL(publicUrl)
    actual.port = String(server.port)
    publicUrl = actual.origin
    wsOrigin = publicUrl.replace(/^http/, 'ws')
  }
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [key, value] of tickets) if (value.expiresAt <= now) tickets.delete(key)
    for (const ws of sockets) if (!ws.data.authenticated && ws.data.expiresAt <= now) ws.close(1008, 'Handshake timeout')
    // A failed heartbeat must close existing access, even for otherwise valid tokens.
    for (const ws of hosts.values()) {
      const row = lookup(ws.data.deviceId)
      if (!row || row.lastSeen < now - 90_000 || ws.data.expiresAt <= now) ws.close(1008, 'Device authorization expired')
    }
    for (const ws of streams.values()) if (ws.data.expiresAt <= now) ws.close(1008, 'Connection expired')
  }, 5_000)
  timer.unref()
  return { server, stop() { if (stopping) return; stopping = true; clearInterval(timer); for (const id of hosts.keys()) disconnectDevice(id); for (const lease of clientLeases.values()) clearTimeout(lease); clientLeases.clear(); server.stop(true); db.close() } }
}
