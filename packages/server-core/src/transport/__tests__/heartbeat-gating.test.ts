/**
 * Client heartbeat gating tests.
 *
 * New servers advertise `supportsAppPing` in handshake_ack. Clients must only
 * send app-level `ping` envelopes to servers that advertise support — older
 * server builds reject unknown envelope types and close the socket (4002),
 * which used to kill the connection every 30s.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { WebSocketServer } from 'ws'
import { WsRpcClient } from '../client.ts'

function ack(id: string, supportsAppPing?: boolean): string {
  return JSON.stringify({
    id,
    type: 'handshake_ack',
    protocolVersion: '1',
    clientId: 'test-client',
    registeredChannels: [],
    ...(supportsAppPing ? { supportsAppPing: true } : {}),
  })
}

async function connectClient(
  port: number,
  opts?: { heartbeatIntervalMs?: number; heartbeatTimeoutMs?: number },
): Promise<WsRpcClient> {
  const client = new WsRpcClient(`ws://127.0.0.1:${port}`, {
    token: 'test-token',
    autoReconnect: false,
    connectTimeout: 2_000,
    heartbeatIntervalMs: opts?.heartbeatIntervalMs ?? 100,
    heartbeatTimeoutMs: opts?.heartbeatTimeoutMs ?? 300,
  })
  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), 3_000)
    const unsub = client.onConnectionStateChanged((s) => {
      if (s.status === 'connected') {
        clearTimeout(timer)
        unsub()
        resolve()
      }
      if (s.status === 'failed') {
        clearTimeout(timer)
        unsub()
        reject(s.lastError ?? new Error('connect failed'))
      }
    })
  })
  client.connect()
  await connected
  return client
}

describe('client heartbeat gating', () => {
  let wss: WebSocketServer | null = null

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!wss) return resolve()
      wss.close(() => resolve())
    })
    wss = null
  })

  it('does not send ping when the server does not advertise supportsAppPing', async () => {
    let serverSawPing = false
    let handshakeReceived = false

    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const env = JSON.parse(raw.toString())
        if (env.type === 'handshake') {
          handshakeReceived = true
          ws.send(ack(env.id, false))
        } else if (env.type === 'ping') {
          serverSawPing = true
        }
      })
    })

    const port = (wss.address() as { port: number }).port
    const client = await connectClient(port, { heartbeatIntervalMs: 100 })
    expect(handshakeReceived).toBe(true)

    // Several heartbeat intervals with no ping — and the connection stays up.
    await Bun.sleep(500)
    expect(serverSawPing).toBe(false)
    expect(client.getConnectionState().status).toBe('connected')
    client.destroy()
  })

  it('sends ping and records pong round-trip when the server advertises support', async () => {
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const env = JSON.parse(raw.toString())
        if (env.type === 'handshake') {
          ws.send(ack(env.id, true))
        } else if (env.type === 'ping') {
          ws.send(JSON.stringify({ id: env.id, type: 'pong' }))
        }
      })
    })

    const port = (wss.address() as { port: number }).port
    const client = await connectClient(port, { heartbeatIntervalMs: 100 })
    await Bun.sleep(400)
    expect(client.getConnectionState().lastHeartbeatAt).toBeGreaterThan(0)
    expect(client.getConnectionState().status).toBe('connected')
    client.destroy()
  })

  it('closes with heartbeat timeout when the server never answers pong', async () => {
    wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const env = JSON.parse(raw.toString())
        if (env.type === 'handshake') {
          ws.send(ack(env.id, true))
        }
        // Deliberately never reply to ping.
      })
    })

    const port = (wss.address() as { port: number }).port
    const client = await connectClient(port, {
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 200,
    })

    const closed = new Promise<{ code?: number; reason?: string }>((resolve) => {
      const unsub = client.onConnectionStateChanged((s) => {
        // The watchdog first flips to 'reconnecting' before the socket close
        // lands — wait for the state that carries lastClose.
        if ((s.status === 'disconnected' || s.status === 'reconnecting') && s.lastClose) {
          unsub()
          resolve(s.lastClose)
        }
      })
    })
    const close = await closed
    // The peer echoes its own empty close frame, so the local close event
    // carries the code we sent but not necessarily the reason.
    expect(close.code).toBe(4000)
    client.destroy()
  })
})
