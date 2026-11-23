import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import {
  RPC_CHANNELS,
  REQUEST_TIMEOUT_MS,
  FILE_DIALOG_TIMEOUT_MS,
  STUDIO_IMAGE_HANDLER_TIMEOUT_MS,
  STUDIO_IMAGE_REQUEST_TIMEOUT_MS,
} from '@tokenbird/shared/protocol'
import { WsRpcClient } from '../client'
import { WsRpcServer } from '../server'
import { CLIENT_OPEN_FILE_DIALOG, requestClientOpenFileDialog } from '../capabilities'

const originalSetTimeout = globalThis.setTimeout
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const action of cleanup.splice(0).reverse()) action()
  mock.restore()
})

async function fixture(requestTimeout = REQUEST_TIMEOUT_MS) {
  const server = new WsRpcServer({ host: '127.0.0.1', port: 0 })
  await server.listen()
  cleanup.push(() => server.close())
  const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, { autoReconnect: false, requestTimeout, clientCapabilities: [CLIENT_OPEN_FILE_DIALOG] })
  cleanup.push(() => client.destroy())
  server.handle('test:ready', () => true)
  await client.invoke('test:ready')
  return { server, client }
}

// Accelerate only RPC deadlines. Sockets, heartbeats and the test runner keep real time.
function accelerateDeadlines() {
  const delays: number[] = []
  const deadlines = new Set([REQUEST_TIMEOUT_MS, 60_000, 300_000, 330_000, 360_000,
    STUDIO_IMAGE_HANDLER_TIMEOUT_MS, STUDIO_IMAGE_REQUEST_TIMEOUT_MS, 600_000])
  spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    if (typeof delay === 'number' && deadlines.has(delay)) {
      delays.push(delay)
      return originalSetTimeout(callback, delay / 1000, ...args)
    }
    return originalSetTimeout(callback, delay, ...args)
  }) as typeof setTimeout)
  return delays
}

describe('Studio RPC deadlines over real WebSockets', () => {
  for (const channel of [
    RPC_CHANNELS.file.OPEN_DIALOG,
    RPC_CHANNELS.dialog.OPEN_FOLDER,
    RPC_CHANNELS.gitbash.BROWSE,
    RPC_CHANNELS.resources.IMPORT_FROM_FILE,
    RPC_CHANNELS.settings.IMPORT_ALL_DATA,
  ]) {
    it(`allows five minutes through every file picker layer: ${channel}`, async () => {
      const { server, client } = await fixture()
      client.handleCapability(CLIENT_OPEN_FILE_DIALOG, async () => {
        await Bun.sleep(120)
        return { canceled: false, filePaths: ['chosen.txt'] }
      })
      server.handle(channel, ctx => requestClientOpenFileDialog(server, ctx.clientId, { properties: ['openFile'] }))
      const delays = accelerateDeadlines()
      await expect(client.invoke(channel)).resolves.toEqual({ canceled: false, filePaths: ['chosen.txt'] })
      expect(delays).toEqual([FILE_DIALOG_TIMEOUT_MS, FILE_DIALOG_TIMEOUT_MS, FILE_DIALOG_TIMEOUT_MS])
    })
  }

  it('expires a file picker request after five minutes', async () => {
    const { server, client } = await fixture()
    client.handleCapability(CLIENT_OPEN_FILE_DIALOG, () => new Promise(() => {}))
    server.handle(RPC_CHANNELS.file.OPEN_DIALOG, ctx => requestClientOpenFileDialog(server, ctx.clientId, {}))
    accelerateDeadlines()
    await expect(client.invoke(RPC_CHANNELS.file.OPEN_DIALOG)).rejects.toThrow('Request timeout: file:openDialog (300000ms)')
  })

  for (const [label, channel, input] of [
    ['mind map generation', RPC_CHANNELS.studio.GENERATE_MIND_MAP, { mode: 'execute' }],
    ['mind map questions', RPC_CHANNELS.studio.GENERATE_MIND_MAP, { mode: 'ask' }],
    ['canvas assistance', RPC_CHANNELS.studio.ASSIST_CANVAS, {}],
  ] as const) {
    it(`delivers ${label} after both ordinary RPC deadlines`, async () => {
      const { server, client } = await fixture()
      server.handle(channel, async (_ctx, request) => {
        await Bun.sleep(120)
        return { summary: '完成', ...request }
      })
      const delays = accelerateDeadlines()
      await expect(client.invoke(channel, input)).resolves.toEqual({ summary: '完成', ...input })
      expect(delays).toEqual([])
      expect((client as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
      expect((server as unknown as { activeHandlerTimeouts: Set<unknown> }).activeHandlerTimeouts.size).toBe(0)
    })
  }

  it('rejects an unlimited request and aborts its handler when the socket disconnects', async () => {
    const { server, client } = await fixture()
    let signal: AbortSignal | undefined
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    server.handle(RPC_CHANNELS.studio.GENERATE_MIND_MAP, ctx => {
      signal = ctx.signal
      entered()
      return new Promise(() => {})
    })
    const pending = client.invoke(RPC_CHANNELS.studio.GENERATE_MIND_MAP).then(() => null, error => error)
    await started
    client.destroy()
    expect(String(await pending)).toMatch(/destroyed|Connection/i)
    await Bun.sleep(30)
    expect(signal?.aborted).toBe(true)
    expect((server as unknown as { activeHandlerTimeouts: Set<unknown> }).activeHandlerTimeouts.size).toBe(0)
  })

  it('preserves image generation deadlines', async () => {
    const { server, client } = await fixture()
    server.handle(RPC_CHANNELS.studio.GENERATE_IMAGE, async () => { await Bun.sleep(120); return 'image' })
    const delays = accelerateDeadlines()
    await expect(client.invoke(RPC_CHANNELS.studio.GENERATE_IMAGE)).resolves.toBe('image')
    expect(delays).toContain(STUDIO_IMAGE_REQUEST_TIMEOUT_MS)
    expect(delays).toContain(STUDIO_IMAGE_HANDLER_TIMEOUT_MS)
  })

  it('waits without a timer even when a client request timeout is configured', async () => {
    const { server, client } = await fixture(600_000)
    server.handle(RPC_CHANNELS.studio.GENERATE_MIND_MAP, () => 'map')
    const delays = accelerateDeadlines()
    await expect(client.invoke(RPC_CHANNELS.studio.GENERATE_MIND_MAP)).resolves.toBe('map')
    expect(delays).toEqual([])
  })

  it('keeps the ordinary client request timeout', async () => {
    const { server, client } = await fixture()
    server.handle('test:slow', () => new Promise(() => {}))
    accelerateDeadlines()
    await expect(client.invoke('test:slow')).rejects.toThrow('Request timeout: test:slow (30000ms)')
  })

  it('keeps the ordinary server handler timeout', async () => {
    const { server, client } = await fixture(600_000)
    server.handle('test:slow', () => new Promise(() => {}))
    accelerateDeadlines()
    await expect(client.invoke('test:slow')).rejects.toThrow('Handler timeout: test:slow (60000ms)')
  })
})
