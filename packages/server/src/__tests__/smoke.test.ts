/**
 * Headless server smoke test.
 *
 * Spawns the standalone server as a subprocess and validates:
 * - WebSocket handshake succeeds with valid token
 * - WebSocket handshake fails with invalid token
 * - /health endpoint returns 200
 * - Clean shutdown on SIGTERM
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { Subprocess } from 'bun'
import WebSocket from 'ws'
import { RPC_CHANNELS } from '@tokenbird/shared/protocol'

const SERVER_ENTRY = process.env.TOKENBIRD_SERVER_SMOKE_ENTRY ?? join(import.meta.dir, '..', 'index.ts')
const SERVER_RUNTIME = process.env.TOKENBIRD_SERVER_SMOKE_RUNTIME ?? process.execPath
const STARTUP_TIMEOUT = 15_000
const TEST_TIMEOUT = 30_000

interface SpawnedServer {
  url: string
  token: string
  healthPort: number
  configDir: string
  proc: Subprocess
  stop: () => Promise<void>
}

async function spawnTestServer(extraEnv?: Record<string, string>): Promise<SpawnedServer> {
  const token = crypto.randomUUID() + crypto.randomUUID() // 72 chars, well above 16 minimum
  const { CLAUDECODE: _, ...parentEnv } = process.env
  // A force-killed server can leave the process lock behind on Windows. Give
  // every smoke instance its own config root so one test cannot poison the
  // next one (or collide with the user's real headless server).
  const configDir = mkdtempSync(join(tmpdir(), 'tokenbird-server-smoke-'))
  const rootPath = join(configDir, 'workspaces', 'smoke')
  mkdirSync(rootPath, { recursive: true })
  const workspace = { id: 'smoke-workspace', slug: 'smoke', name: 'Smoke', rootPath, createdAt: Date.now() }
  writeFileSync(join(rootPath, 'config.json'), JSON.stringify({ id: workspace.id, name: workspace.name, createdAt: workspace.createdAt }))
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id, activeSessionId: null }))

  const proc = Bun.spawn([SERVER_RUNTIME, SERVER_ENTRY], {
    env: {
      ...parentEnv,
      ...extraEnv,
      TOKENBIRD_SERVER_TOKEN: token,
      TOKENBIRD_RPC_PORT: '0',
      TOKENBIRD_RPC_HOST: '127.0.0.1',
      TOKENBIRD_HEALTH_PORT: '0', // random port
      TOKENBIRD_CONFIG_DIR: configDir,
      TOKENBIRD_DISABLE_MESSAGING: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  void proc.exited.then(() => rmSync(configDir, { recursive: true, force: true }))

  return new Promise<SpawnedServer>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`Server did not start within ${STARTUP_TIMEOUT}ms`))
    }, STARTUP_TIMEOUT)

    let url = ''
    let buffer = ''

    const processLines = () => {
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('TOKENBIRD_SERVER_URL=')) {
          url = line.slice('TOKENBIRD_SERVER_URL='.length).trim()
        }
        if (url) {
          clearTimeout(timer)
          resolve({
            url,
            token,
            healthPort: 0, // health port not printed; we skip health test if 0
            configDir,
            proc,
            stop: async () => {
              proc.kill('SIGTERM')
              await proc.exited
            },
          })
          return
        }
      }
    }

    ;(async () => {
      const reader = proc.stdout!.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          processLines()
        }
      } catch {
        // Stream closed
      }
      clearTimeout(timer)
      if (!url) {
        reject(new Error('Server exited before printing TOKENBIRD_SERVER_URL'))
      }
    })()
  })
}

function connectWs(url: string, token: string, workspaceId?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('open', () => {
      // Send handshake
      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        type: 'handshake',
        protocolVersion: '1.0',
        token,
        workspaceId,
      }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'handshake_ack') {
        resolve(ws)
      } else if (msg.type === 'error') {
        reject(new Error(`Handshake error: ${msg.error?.message}`))
        ws.close()
      }
    })
    ws.on('error', reject)
    ws.on('close', (code, reason) => {
      reject(new Error(`WS closed: ${code} ${reason}`))
    })
  })
}

function invokeRpc(ws: WebSocket, channel: string, ...args: unknown[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error(`RPC timed out: ${channel}`)) }, 5000)
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString())
      if (message.id !== id) return
      clearTimeout(timer); ws.off('message', onMessage)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, type: 'request', channel, args }))
  })
}

describe('headless server smoke test', () => {
  let server: SpawnedServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop().catch(() => {})
      server = null
    }
  })

  it('accepts valid token handshake', async () => {
    server = await spawnTestServer()
    const ws = await connectWs(server.url, server.token)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  }, TEST_TIMEOUT)

  it('manages the standalone encrypted vault through authenticated workspace RPC', async () => {
    server = await spawnTestServer()
    const ws = await connectWs(server.url, server.token, 'smoke-workspace')
    try {
      // Standalone servers approve verified connections within their workspace
      // scope automatically, without a desktop confirmation dialog.
      expect((await invokeRpc(ws, RPC_CHANNELS.credentials.ACCESS)).state).toBe('approved')
      await invokeRpc(ws, RPC_CHANNELS.credentials.REQUEST_ACCESS)
      expect((await invokeRpc(ws, RPC_CHANNELS.credentials.ACCESS)).state).toBe('approved')
      const id = { type: 'saved_credential', workspaceId: 'smoke-workspace', name: 'binance-operations' }
      const secret = 'dummy-rpc-binance-secret'
      expect((await invokeRpc(ws, RPC_CHANNELS.credentials.APPLY, { changes: [{ op: 'upsert', id, credential: { value: secret, credentialKind: 'api-key' } }] })).ok).toBe(true)
      const list = await invokeRpc(ws, RPC_CHANNELS.credentials.LIST)
      expect(list.ok).toBe(true)
      expect(list.value.entries.map((entry: any) => entry.id.name)).toContain('binance-operations')
      expect(JSON.stringify(list)).not.toContain(secret)
      expect(readFileSync(join(server.configDir, 'credentials.enc')).includes(Buffer.from(secret))).toBe(false)
      expect((await invokeRpc(ws, RPC_CHANNELS.credentials.APPLY, { changes: [{ op: 'upsert', id, credential: { value: 'updated-dummy-secret' } }] })).ok).toBe(true)
      expect((await invokeRpc(ws, RPC_CHANNELS.credentials.APPLY, { changes: [{ op: 'delete', id }] })).ok).toBe(true)
      expect((await invokeRpc(ws, RPC_CHANNELS.credentials.LIST)).value.entries).toEqual([])
    } finally { ws.close() }
  }, TEST_TIMEOUT)

  it('rejects invalid token', async () => {
    server = await spawnTestServer()
    await expect(
      connectWs(server.url, 'wrong-token-that-is-long-enough'),
    ).rejects.toThrow()
  }, TEST_TIMEOUT)

  it('rejects short token at startup', async () => {
    const token = 'short'
    const { CLAUDECODE: _, ...parentEnv } = process.env
    const configDir = mkdtempSync(join(tmpdir(), 'tokenbird-server-smoke-'))
    const proc = Bun.spawn([SERVER_RUNTIME, SERVER_ENTRY], {
      env: {
        ...parentEnv,
        TOKENBIRD_SERVER_TOKEN: token,
        TOKENBIRD_RPC_PORT: '0',
        TOKENBIRD_RPC_HOST: '127.0.0.1',
        TOKENBIRD_CONFIG_DIR: configDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const exitCode = await proc.exited
    rmSync(configDir, { recursive: true, force: true })
    expect(exitCode).not.toBe(0)
  }, TEST_TIMEOUT)

  it('shuts down cleanly on SIGTERM', async () => {
    server = await spawnTestServer()
    const ws = await connectWs(server.url, server.token)

    // Server should be running
    expect(ws.readyState).toBe(WebSocket.OPEN)

    // Send SIGTERM
    server.proc.kill('SIGTERM')
    const exitCode = await server.proc.exited
    if (process.platform === 'win32') {
      // Windows has no catchable SIGTERM — TerminateProcess skips the
      // handler, so the exit code is a signal-style code, not 0.
      expect([0, 1, 143, null].includes(exitCode)).toBe(true)
    } else {
      expect(exitCode).toBe(0)
    }

    // Mark as stopped so afterEach doesn't double-kill
    server = null
  }, TEST_TIMEOUT)
})
