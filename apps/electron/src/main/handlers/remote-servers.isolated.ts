import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HandlerFn, RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from './handler-deps'

// Import configuration consumers only after isolating all profile writes.
const previousConfig = process.env.TOKENBIRD_CONFIG_DIR
const directory = mkdtempSync(join(tmpdir(), 'tokenbird-profile-probe-'))
process.env.TOKENBIRD_CONFIG_DIR = directory
const { WsRpcServer } = await import('@craft-agent/server-core/transport')
const { RPC_CHANNELS } = await import('@craft-agent/shared/protocol')
const { upsertRemoteServerProfile, getRemoteServerProfile } = await import('@craft-agent/shared/config/remote-servers')
const { registerRemoteServersGuiHandlers } = await import('./remote-servers')

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })
afterAll(() => {
  if (previousConfig === undefined) delete process.env.TOKENBIRD_CONFIG_DIR
  else process.env.TOKENBIRD_CONFIG_DIR = previousConfig
  rmSync(directory, { recursive: true, force: true })
})

async function fixture(serverVersion = 'fixture-v6') {
  const token = 'dummy-profile-probe-secret'
  const peer = new WsRpcServer({ host: '127.0.0.1', port: 0, serverVersion, requireAuth: true, validateToken: async value => value === token })
  await peer.listen()
  cleanup.push(() => peer.close())
  const profile = upsertRemoteServerProfile({ name: 'Fixture', url: `ws://127.0.0.1:${peer.port}`, token })
  const handlers = new Map<string, HandlerFn>()
  const registry = { handle: (channel: string, handler: HandlerFn) => { handlers.set(channel, handler) } }
  registerRemoteServersGuiHandlers(registry as RpcServer, {} as HandlerDeps)
  return { peer, profile, testConnection: (input: unknown) => handlers.get(RPC_CHANNELS.remoteServers.TEST)!({ clientId: 'probe', workspaceId: null, webContentsId: null }, input) }
}

test('saved-server probe reports the version and marks only a successful current profile', async () => {
  const f = await fixture()
  expect(await f.testConnection({ id: f.profile.id })).toEqual({ ok: true, serverVersion: 'fixture-v6' })
  expect(getRemoteServerProfile(f.profile.id)?.lastConnectedAt).toBeGreaterThan(0)
})

test('saved-server probe never exposes a credential echoed in the version field', async () => {
  const f = await fixture('dummy-profile-probe-secret')
  const result = await f.testConnection({ id: f.profile.id })
  expect(result).toEqual({ ok: true, serverVersion: undefined })
  expect(JSON.stringify(result)).not.toContain(f.profile.token)
})

test('saved-server probe sends no stale bearer after a profile edit before handshake', async () => {
  const f = await fixture()
  let receivedBearer = false
  const accept = (f.peer as any).onConnection.bind(f.peer)
  ;(f.peer as any).onConnection = (socket: any, cookie: unknown) => {
    // Native WebSocket open happens after this server-side acceptance.
    upsertRemoteServerProfile({ id: f.profile.id, name: f.profile.name, url: f.profile.url, token: 'dummy-rotated-secret' })
    socket.on('message', (raw: any) => { if (JSON.parse(raw.toString()).token) receivedBearer = true })
    accept(socket, cookie)
  }
  const result = await f.testConnection({ id: f.profile.id })
  expect(result.ok).toBe(false)
  expect(receivedBearer).toBe(false)
  expect(getRemoteServerProfile(f.profile.id)?.lastConnectedAt).toBeUndefined()
})

test('ad hoc probe rejects non-loopback plaintext endpoints before connection', async () => {
  const f = await fixture()
  const denied = await f.testConnection({ url: 'ws://example.invalid', token: f.profile.token }).then(() => null, (error: unknown) => error)
  expect(denied).toBeInstanceOf(Error)
  expect(denied.message).toContain('verified WSS')
})
