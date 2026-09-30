import { afterEach, beforeEach, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CraftMcpClient } from '../client.ts'
import { McpClientPool } from '../mcp-pool.ts'
import { mcpRuntimeLimiter } from '../runtime-limiter.ts'
import { config, ControllablePool, deferred } from './fixtures/pool-race-harness.ts'

const cleanups: Array<() => Promise<void>> = []
const originalLimits = mcpRuntimeLimiter.getLimits()
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 2))
async function until(check: () => boolean) {
  const deadline = performance.now() + 5000
  while (!check()) {
    if (performance.now() > deadline) throw new Error('Owned MCP fixture observation timed out')
    await tick()
  }
}
beforeEach(() => { mcpRuntimeLimiter.configure({ hardLimit: 8, softLimit: 8 }) })
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    await mcpRuntimeLimiter.enforceLimits()
    expect(mcpRuntimeLimiter.getActiveCount()).toBe(0)
    expect(mcpRuntimeLimiter.getQueuedCount()).toBe(0)
  } finally { mcpRuntimeLimiter.configure(originalLimits) }
})

interface Event { event: string; pid: number; code?: number; method?: string; token?: string }
function stdioFixture(createPool = () => new McpClientPool()) {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-terminal-close-'))
  const script = join(directory, 'server.mjs')
  copyFileSync(new URL('./fixtures/terminal-stdio-server.mjs', import.meta.url), script)
  const pool = createPool()
  const logs = new Set<string>()
  const events = (slug: string): Event[] => {
    try { return readFileSync(join(directory, `${slug}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  cleanups.push(async () => {
    try {
      await pool.disconnectAll()
      for (const slug of logs) {
        await until(() => events(slug).filter(event => event.event === 'spawn').every(spawn =>
          events(slug).some(event => event.event === 'exit' && event.pid === spawn.pid)))
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  return {
    pool, events,
    config: (slug: string, mode = 'normal') => {
      logs.add(slug)
      return { type: 'stdio' as const, command: process.execPath, args: [script, join(directory, `${slug}.jsonl`), join(directory, `${slug}.exit`), mode] }
    },
    exit: (slug: string) => writeFileSync(join(directory, `${slug}.exit`), 'exit'),
    client: (slug: string) => (pool as any).clients.get(slug) as CraftMcpClient,
    calls: (slug: string) => events(slug).filter(event => event.method === 'tools/call').map(event => event.token),
    spawns: (slug: string) => events(slug).filter(event => event.event === 'spawn').length,
  }
}

test('real stdio in-flight death retires one slot, never replays, and shares later lazy recovery', async () => {
  const item = stdioFixture()
  const source = item.config('source')
  await item.pool.sync({ source, sibling: item.config('sibling') })
  const old = item.client('source')
  const sibling = item.client('sibling')
  let closes = 0
  const close = old.close.bind(old)
  old.close = async () => { closes++; await close() }
  const failed = await item.pool.callTool('mcp__source__act', { token: 'mutation-once', action: 'crash' })
  expect(failed.isError).toBe(true)
  expect(failed.content).toContain('outcome may be unknown')
  await until(() => mcpRuntimeLimiter.getActiveCount() === 1)
  expect(old.isConnected()).toBe(false)
  expect(item.pool.isConnected('source')).toBe(false)
  expect(item.pool.getConnectedSlugs()).toEqual(['sibling'])
  expect(item.pool.getTools('source').map(tool => tool.name)).toEqual(['act'])
  expect(item.pool.getProxyToolDefs().map(tool => tool.name)).toContain('mcp__source__act')
  expect(item.spawns('source')).toBe(1)
  expect(item.calls('source')).toEqual(['mutation-once'])
  expect(item.events('source').filter(event => event.event === 'mutation')).toHaveLength(1)
  expect(closes).toBe(1)
  expect(await item.pool.callTool('mcp__sibling__act', { token: 'sibling-alive' })).toEqual({ content: 'sibling-alive', isError: false })
  expect(item.client('sibling')).toBe(sibling)
  const results = await Promise.all(['new-call-a', 'new-call-b'].map(token => item.pool.callTool('mcp__source__act', { token })))
  expect(results).toEqual([{ content: 'new-call-a', isError: false }, { content: 'new-call-b', isError: false }])
  expect(item.client('source')).not.toBe(old)
  expect(item.spawns('source')).toBe(2)
  expect(item.calls('source')[0]).toBe('mutation-once')
  expect(item.calls('source').slice(1).sort()).toEqual(['new-call-a', 'new-call-b'])
  expect(item.events('source').filter(event => event.event === 'mutation')).toHaveLength(1)
  expect(closes).toBe(1)
  expect(mcpRuntimeLimiter.getActiveCount()).toBe(2)
}, 15_000)

test('real idle stdio death recovers on same-config connect and sync without a background respawn', async () => {
  const item = stdioFixture()
  const source = item.config('source')
  await item.pool.connect('source', source)
  for (const recover of [() => item.pool.connect('source', source), () => item.pool.sync({ source })]) {
    const old = item.client('source')
    const spawns = item.spawns('source')
    item.exit('source')
    await until(() => !item.pool.isConnected('source') && mcpRuntimeLimiter.getActiveCount() === 0)
    expect(old.isConnected()).toBe(false)
    expect(item.spawns('source')).toBe(spawns)
    expect(item.pool.getTools('source').map(tool => tool.name)).toEqual(['act'])
    await recover()
    expect(item.spawns('source')).toBe(spawns + 1)
    expect(item.client('source')).not.toBe(old)
    expect(await item.pool.callTool('mcp__source__act', { token: `recovered-${spawns}` })).toEqual({ content: `recovered-${spawns}`, isError: false })
  }
}, 15_000)

test('real stdio request abort, timeout, RPC error and tool isError keep the transport alive', async () => {
  const item = stdioFixture()
  await item.pool.connect('source', item.config('source'))
  const original = item.client('source')
  const controller = new AbortController()
  const aborted = item.pool.callTool('mcp__source__act', { token: 'abort', action: 'hold' }, { signal: controller.signal })
  await until(() => item.calls('source').includes('abort'))
  controller.abort()
  expect((await aborted).isError).toBe(true)
  expect((await item.pool.callTool('mcp__source__act', { token: 'timeout', action: 'hold' }, { timeoutMs: 20 })).isError).toBe(true)
  expect((await item.pool.callTool('mcp__source__act', { token: 'rpc-error', action: 'rpc-error' })).isError).toBe(true)
  expect(await item.pool.callTool('mcp__source__act', { token: 'tool-error', action: 'tool-error' })).toEqual({ content: 'tool-error', isError: true })
  expect(await item.pool.callTool('mcp__source__act', { token: 'still-alive' })).toEqual({ content: 'still-alive', isError: false })
  expect(item.client('source')).toBe(original)
  expect(original.isConnected()).toBe(true)
  expect(item.spawns('source')).toBe(1)
  expect(item.calls('source')).toEqual(['abort', 'timeout', 'rpc-error', 'tool-error', 'still-alive'])
  expect(mcpRuntimeLimiter.getActiveCount()).toBe(1)
}, 15_000)

test('real stdio death before initialization rejects, frees its slot, and publishes no tools', async () => {
  const item = stdioFixture()
  await expect(item.pool.connect('source', item.config('source', 'exit-initialize'))).rejects.toThrow()
  expect(item.pool.isConnected('source')).toBe(false)
  expect(item.pool.getTools('source')).toEqual([])
  expect(item.pool.getProxyToolDefs()).toEqual([])
  expect(mcpRuntimeLimiter.getActiveCount()).toBe(0)
  await item.pool.connect('source', item.config('source'))
  expect(await item.pool.callTool('mcp__source__act', { token: 'fresh-attempt' })).toEqual({ content: 'fresh-attempt', isError: false })
}, 15_000)

test('real stdio close after discovery response but before publication rejects readiness', async () => {
  let responseObserved = false
  class PublicationBoundaryPool extends McpClientPool {
    override async registerClient(slug: string, client: CraftMcpClient): Promise<void> {
      if (!responseObserved) {
        const listTools = client.listTools.bind(client)
        client.listTools = async () => {
          const tools = await listTools()
          responseObserved = true
          // Delay only delivery of the real discovery result until the real
          // SDK reports our owned child's exit. No lifecycle event is mocked.
          item.exit(slug)
          await until(() => !client.isConnected())
          return tools
        }
      }
      await super.registerClient(slug, client)
    }
  }
  const item = stdioFixture(() => new PublicationBoundaryPool())
  const source = item.config('source')
  await expect(item.pool.ensureConnected('source', source)).rejects.toThrow('Failed to connect to the MCP server')
  expect(responseObserved).toBe(true)
  expect(item.pool.isConnected('source')).toBe(false)
  expect(item.pool.getTools('source')).toEqual([])
  expect(item.pool.getProxyToolDefs()).toEqual([])
  expect(mcpRuntimeLimiter.getActiveCount()).toBe(0)
  await item.pool.connect('source', source)
  expect(await item.pool.callTool('mcp__source__act', { token: 'next-explicit-call' })).toEqual({ content: 'next-explicit-call', isError: false })
  expect(item.calls('source')).toEqual(['next-explicit-call'])
  expect(item.spawns('source')).toBe(2)
}, 15_000)

function controlledFixture() {
  const pool = new ControllablePool('act')
  const pending: Promise<unknown>[] = []
  cleanups.push(async () => { pool.releaseAll(); await pool.disconnectAll(); await Promise.allSettled(pending) })
  const track = <T>(promise: Promise<T>) => { pending.push(promise); void promise.catch(() => {}); return promise }
  const closed = (index: number) => ((pool.records[index]!.client as any).client as { onclose: () => void }).onclose()
  return { pool, track, closed }
}

test('delayed old close after new generation cannot clear the replacement or its slot', async () => {
  const item = controlledFixture()
  const first = item.track(item.pool.connect('source', config('old')))
  await item.pool.started(1)
  item.pool.records[0]!.gate.resolve()
  await first
  const replacement = item.track(item.pool.connect('source', config('new')))
  await item.pool.started(2)
  item.pool.records[1]!.gate.resolve()
  await replacement
  item.closed(0)
  item.closed(0)
  expect(await item.pool.callTool('mcp__source__act', {})).toEqual({ content: 'client_1', isError: false })
  expect(item.pool.getConfig('source')).toMatchObject(config('new'))
  expect(item.pool.records.map(record => record.closes)).toEqual([1, 0])
  expect(mcpRuntimeLimiter.getActiveCount()).toBe(1)
})

test('terminal close during pending handshake waits cleanup once and cannot publish over successor', async () => {
  const item = controlledFixture()
  const old = item.track(item.pool.connect('source', config('same')))
  await item.pool.started(1)
  const closeGate = item.pool.records[0]!.closeGate = deferred()
  item.closed(0)
  item.closed(0)
  const latest = item.track(item.pool.connect('source', config('same')))
  await tick()
  expect(item.pool.records).toHaveLength(1)
  expect(item.pool.records[0]!.closes).toBe(1)
  expect(mcpRuntimeLimiter.getActiveCount()).toBe(1)
  closeGate.resolve()
  await item.pool.started(2)
  item.pool.records[1]!.gate.resolve()
  await latest
  item.pool.records[0]!.gate.resolve()
  await expect(old).rejects.toThrow('Failed to connect to the MCP server')
  item.closed(0)
  expect(await item.pool.callTool('mcp__source__act', {})).toEqual({ content: 'client_1', isError: false })
  expect(item.pool.records.map(record => record.closes)).toEqual([1, 0])
  expect(mcpRuntimeLimiter.getActiveCount()).toBe(1)
})

for (const all of [false, true]) {
  test(`explicit ${all ? 'shutdown' : 'disconnect'} plus reentrant or late close cannot restore desired state`, async () => {
    const item = controlledFixture()
    const first = item.track(item.pool.connect('source', config('same')))
    await item.pool.started(1)
    item.pool.records[0]!.gate.resolve()
    await first
    const client = item.pool.records[0]!.client
    const close = client.close.bind(client)
    client.close = async () => { item.closed(0); await close() }
    await (all ? item.pool.disconnectAll() : item.pool.disconnect('source'))
    item.closed(0)
    expect(item.pool.isConnected('source')).toBe(false)
    expect(item.pool.getConfig('source')).toBeUndefined()
    expect(item.pool.getTools('source')).toEqual([])
    expect((await item.pool.callTool('mcp__source__act', {})).content).toContain('Unknown MCP proxy tool')
    expect(item.pool.records).toHaveLength(1)
    expect(item.pool.records[0]!.closes).toBe(1)
    expect(mcpRuntimeLimiter.getActiveCount()).toBe(0)
  })
}
