import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getCachedMcpSourceTools } from '../mcp-pool.ts'
import { mcpRuntimeLimiter } from '../runtime-limiter.ts'
import { config, ControllablePool, deferred } from './fixtures/pool-race-harness.ts'

const pools: ControllablePool[] = []
const pending: Promise<unknown>[] = []
const originalLimits = mcpRuntimeLimiter.getLimits()
function pool(toolName?: string, workspaceRootPath?: string) {
  const value = new ControllablePool(toolName, { workspaceRootPath })
  pools.push(value)
  return value
}
function track<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise)
  void promise.catch(() => {})
  return promise
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
beforeEach(() => { mcpRuntimeLimiter.configure({ hardLimit: 8, softLimit: 8 }) })
afterEach(async () => {
  for (const item of pools) item.releaseAll()
  await Promise.all(pools.map(item => item.disconnectAll()))
  await Promise.allSettled(pending.splice(0))
  pools.length = 0
  await mcpRuntimeLimiter.enforceLimits()
  expect(mcpRuntimeLimiter.getActiveCount()).toBe(0)
  expect(mcpRuntimeLimiter.getQueuedCount()).toBe(0)
  mcpRuntimeLimiter.configure(originalLimits)
})

describe('MCP connection generation ownership', () => {
  test('late success cannot overwrite a newer client, tools, workspace cache, or slot', async () => {
    const workspace = `pool-ownership-${crypto.randomUUID()}`
    const item = pool(undefined, workspace)
    const old = track(item.ensureConnected('race', config('old')))
    await item.started(1)
    const latest = track(item.ensureConnected('race', config('new')))
    await item.started(2)
    expect(item.records[0]!.closes).toBe(1)
    item.records[1]!.gate.resolve()
    await latest
    item.records[0]!.gate.resolve()
    await old
    expect(item.getTools('race').map(tool => tool.name)).toEqual(['tool_1'])
    expect(getCachedMcpSourceTools(workspace, 'race')?.map(tool => tool.name)).toEqual(['tool_1'])
    expect((await item.callTool('mcp__race__tool_1', {})).content).toBe('client_1')
    expect(item.getConfig('race')).toMatchObject(config('new'))
    expect(item.records.map(record => record.closes)).toEqual([1, 0])
    expect(mcpRuntimeLimiter.getActiveCount()).toBe(1)
  })

  test('late failure cannot unregister a newer runtime', async () => {
    const item = pool()
    const old = track(item.ensureConnected('race', config('old')))
    await item.started(1)
    const latest = track(item.ensureConnected('race', config('new')))
    await item.started(2)
    item.records[1]!.gate.resolve()
    await latest
    item.records[0]!.gate.reject(new Error('obsolete handshake failed'))
    await expect(old).rejects.toThrow('superseded or disconnected')
    expect((await item.callTool('mcp__race__tool_1', {})).content).toBe('client_1')
    expect(item.records.map(record => record.closes)).toEqual([1, 0])
    expect(mcpRuntimeLimiter.getActiveCount()).toBe(1)
  })

  test('equivalent config objects share a handshake across connect, ensureConnected, and sync', async () => {
    const item = pool()
    const first = track(item.connect('same', config('value')))
    await item.started(1)
    const second = track(item.ensureConnected('same', { ...config('value'), headers: { 'x-dummy-generation': 'value' } }))
    const third = track(item.sync({ same: config('value') }))
    await tick()
    expect(item.records).toHaveLength(1)
    item.records[0]!.gate.resolve()
    await Promise.all([first, second, third])
    expect((await item.callTool('mcp__same__tool_0', {})).content).toBe('client_0')
  })

  test('fresh snapshots detect in-place mutation of remote credentials', async () => {
    const item = pool()
    const mutable = config('old')
    const old = track(item.ensureConnected('race', mutable))
    await item.started(1)
    mutable.headers!['X-Dummy-Generation'] = 'new'
    expect(item.getConfig('race')).toMatchObject(config('old'))
    const latest = track(item.ensureConnected('race', mutable))
    await item.started(2)
    item.records[1]!.gate.resolve()
    await latest
    item.records[0]!.gate.resolve()
    await old
    expect(item.getConfig('race')).toMatchObject(config('new'))
    expect(item.records.map(record => record.closes)).toEqual([1, 0])
  })

  test('fresh snapshots detect in-place mutation of stdio maps and arrays', async () => {
    const item = pool()
    const mutable = { type: 'stdio' as const, command: 'never-started', args: ['old'], env: { DUMMY: 'old' }, envVars: ['OLD'] }
    const old = track(item.ensureConnected('local', mutable))
    await item.started(1)
    mutable.args[0] = 'new'
    mutable.env.DUMMY = 'new'
    mutable.envVars[0] = 'NEW'
    expect(item.getConfig('local')).toMatchObject({ args: ['old'], env: { DUMMY: 'old' }, envVars: ['OLD'] })
    const latest = track(item.ensureConnected('local', mutable))
    await item.started(2)
    item.releaseAll()
    await Promise.all([old, latest])
    expect(item.getConfig('local')).toMatchObject({ args: ['new'], env: { DUMMY: 'new' }, envVars: ['NEW'] })
  })

  test('concurrent sync keeps the latest config and does not resume obsolete remaining sources', async () => {
    const item = pool()
    const old = track(item.sync({ race: config('old'), obsolete: config('old') }))
    await item.started(1)
    const latest = track(item.sync({ race: config('new') }))
    await item.started(2)
    item.records[1]!.gate.resolve()
    expect(await latest).toEqual([])
    item.records[0]!.gate.resolve()
    expect(await old).toEqual([])
    expect(item.getConnectedSlugs()).toEqual(['race'])
    expect(item.records).toHaveLength(2)
  })

  test('disconnectAll closes pending clients promptly without waiting for handshake completion', async () => {
    const item = pool()
    const old = track(item.ensureConnected('race', config('old')))
    await item.started(1)
    await item.disconnectAll()
    expect(item.records[0]!.closes).toBe(1)
    expect(mcpRuntimeLimiter.getActiveCount()).toBe(0)
    expect(item.getConfig('race')).toBeUndefined()
    item.records[0]!.gate.resolve()
    await old
    expect(item.isConnected('race')).toBe(false)
    expect(item.getTools('race')).toEqual([])
    expect(item.records[0]!.closes).toBe(1)
  })

  test('old handshake and delayed disconnectAll cannot clear a replacement connection', async () => {
    const item = pool()
    const old = track(item.ensureConnected('race', config('old')))
    await item.started(1)
    const closeGate = item.records[0]!.closeGate = deferred()
    const shutdown = track(item.disconnectAll())
    const latest = track(item.ensureConnected('race', config('new')))
    await tick()
    expect(item.records).toHaveLength(1)
    closeGate.resolve()
    await item.started(2)
    item.records[1]!.gate.resolve()
    await latest
    await shutdown
    item.records[0]!.gate.resolve()
    await old
    expect((await item.callTool('mcp__race__tool_1', {})).content).toBe('client_1')
    expect(item.records.map(record => record.closes)).toEqual([1, 0])
  })

  test('failed handshakes release their slot and allow legitimate same-config retries', async () => {
    const item = pool()
    const first = track(item.ensureConnected('retry', config('same')))
    await item.started(1)
    item.records[0]!.gate.reject(new Error('try again'))
    await expect(first).rejects.toThrow('Failed to connect to the MCP server')
    expect(mcpRuntimeLimiter.getActiveCount()).toBe(0)
    const second = track(item.ensureConnected('retry', config('same')))
    await item.started(2)
    item.records[1]!.gate.resolve()
    await second
    expect((await item.callTool('mcp__retry__tool_1', {})).content).toBe('client_1')
    expect(item.records.map(record => record.closes)).toEqual([1, 0])
  })

  test('invalid config construction releases a reserved runtime and remains retryable', async () => {
    const item = pool()
    await expect(item.ensureConnected('bad', { type: 'http', url: 'invalid-url' })).rejects.toThrow()
    expect(mcpRuntimeLimiter.getActiveCount()).toBe(0)
    const retry = track(item.ensureConnected('bad', config('good')))
    await item.started(1)
    item.releaseAll()
    await retry
    expect(item.isConnected('bad')).toBe(true)
  })
})

describe('MCP pool limiter and in-process parity', () => {
  test('hard-limit queued generations dedupe and cancel without constructing a client', async () => {
    mcpRuntimeLimiter.configure({ hardLimit: 1, softLimit: 1 })
    const item = pool()
    const occupied = track(item.ensureConnected('occupied', config('busy')))
    await item.started(1)
    const queued = track(item.ensureConnected('queued', config('same')))
    const duplicate = track(item.ensureConnected('queued', config('same')))
    await tick()
    expect(mcpRuntimeLimiter.getQueuedCount()).toBe(1)
    await item.disconnect('queued')
    await expect(queued).rejects.toThrow('cancelled')
    await expect(duplicate).rejects.toThrow('cancelled')
    expect(item.records).toHaveLength(1)
    expect(mcpRuntimeLimiter.getActiveCount()).toBe(1)
    item.records[0]!.gate.resolve()
    await occupied
    const retry = track(item.ensureConnected('queued', config('same')))
    await item.started(2)
    item.records[1]!.gate.resolve()
    await retry
    expect(item.records.map(record => record.closes)).toEqual([1, 0])
  })

  test('superseding a busy handshake under hardLimit=1 closes only its old slot', async () => {
    mcpRuntimeLimiter.configure({ hardLimit: 1, softLimit: 1 })
    const item = pool()
    const old = track(item.ensureConnected('race', config('old')))
    await item.started(1)
    const closeGate = item.records[0]!.closeGate = deferred()
    const latest = track(item.ensureConnected('race', config('new')))
    await tick()
    expect(item.records).toHaveLength(1)
    expect(mcpRuntimeLimiter.getActiveCount()).toBe(1)
    closeGate.resolve()
    await item.started(2)
    item.records[1]!.gate.resolve()
    await latest
    item.records[0]!.gate.reject(new Error('cancelled old transport'))
    await expect(old).rejects.toThrow('superseded or disconnected')
    expect((await item.callTool('mcp__race__tool_1', {})).content).toBe('client_1')
    expect(mcpRuntimeLimiter.getActiveCount()).toBe(1)
  })

  test('soft eviction preserves tool definitions and shared lazy reconnects', async () => {
    mcpRuntimeLimiter.configure({ hardLimit: 2, softLimit: 1 })
    const item = pool('read')
    const first = track(item.ensureConnected('first', config('first')))
    await item.started(1)
    item.records[0]!.gate.resolve()
    await first
    const second = track(item.ensureConnected('second', config('second')))
    await item.started(2)
    item.records[1]!.gate.resolve()
    await second
    await mcpRuntimeLimiter.enforceLimits()
    expect(item.isConnected('first')).toBe(false)
    expect(item.getTools('first').map(tool => tool.name)).toEqual(['read'])
    const a = track(item.callTool('mcp__first__read', {}))
    const b = track(item.callTool('mcp__first__read', {}))
    await item.started(3)
    item.records[2]!.gate.resolve()
    expect((await Promise.all([a, b])).map(result => result.content)).toEqual(['client_2', 'client_2'])
    expect(item.records).toHaveLength(3)
  })

  test('softLimit=0 pins shared lazy handshakes until tool calls finish', async () => {
    mcpRuntimeLimiter.configure({ hardLimit: 1, softLimit: 0 })
    const item = pool('read')
    const initial = track(item.ensureConnected('source', config('same')))
    await item.started(1)
    item.records[0]!.gate.resolve()
    await initial
    await mcpRuntimeLimiter.enforceLimits()
    expect(item.isConnected('source')).toBe(false)
    const first = track(item.callTool('mcp__source__read', {}))
    const second = track(item.callTool('mcp__source__read', {}))
    await item.started(2)
    const callGate = item.records[1]!.callGate = deferred()
    item.records[1]!.gate.resolve()
    await tick()
    await mcpRuntimeLimiter.enforceLimits()
    expect(item.records[1]!.calls).toHaveLength(2)
    expect(item.records[1]!.closes).toBe(0)
    expect(mcpRuntimeLimiter.getActiveCount()).toBe(1)
    callGate.resolve()
    expect((await Promise.all([first, second])).map(result => result.content)).toEqual(['client_1', 'client_1'])
    await mcpRuntimeLimiter.enforceLimits()
    expect(item.records[1]!.closes).toBe(1)
    expect(item.isConnected('source')).toBe(false)
  })

  test('LRU eviction skips busy calls and cancellation options reach only the claimed client', async () => {
    mcpRuntimeLimiter.configure({ hardLimit: 2, softLimit: 2 })
    const item = pool('read')
    const first = track(item.ensureConnected('first', config('first')))
    await item.started(1)
    item.records[0]!.gate.resolve()
    await first
    const gate = item.records[0]!.callGate = deferred()
    const controller = new AbortController()
    const call = track(item.callTool('mcp__first__read', {}, { signal: controller.signal, timeoutMs: 321 }))
    const second = track(item.ensureConnected('second', config('second')))
    await item.started(2)
    item.records[1]!.gate.resolve()
    await second
    mcpRuntimeLimiter.configure({ hardLimit: 2, softLimit: 1 })
    await mcpRuntimeLimiter.enforceLimits()
    expect(item.records.map(record => record.closes)).toEqual([0, 1])
    expect(item.records[0]!.calls[0]!.options).toEqual({ signal: controller.signal, timeoutMs: 321 })
    gate.resolve()
    expect((await call).isError).toBe(false)
    controller.abort()
    const aborted = await item.callTool('mcp__first__read', {}, { signal: controller.signal })
    expect(aborted.isError).toBe(true)
    expect(item.records[0]!.calls).toHaveLength(1)
  })

  test('shutdown cannot clear a replacement while an unrelated old client is still closing', async () => {
    const item = pool()
    const first = track(item.ensureConnected('first', config('old')))
    await item.started(1)
    item.records[0]!.gate.resolve()
    await first
    const second = track(item.ensureConnected('second', config('other')))
    await item.started(2)
    item.records[1]!.gate.resolve()
    await second
    const oldClose = item.records[1]!.closeGate = deferred()
    const shutdown = track(item.disconnectAll())
    const replacement = track(item.ensureConnected('first', config('new')))
    await item.started(3)
    item.records[2]!.gate.resolve()
    await replacement
    oldClose.resolve()
    await shutdown
    expect((await item.callTool('mcp__first__tool_2', {})).content).toBe('client_2')
    expect(item.records.map(record => record.closes)).toEqual([1, 1, 0])
  })

  test('in-process same-instance calls dedupe and cannot resurrect after shutdown', async () => {
    const item = pool()
    const server = {} as never
    const a = track(item.connectInProcess('api', server))
    await item.started(1)
    const b = track(item.connectInProcess('api', server))
    await tick()
    expect(item.records).toHaveLength(1)
    expect(mcpRuntimeLimiter.getActiveCount()).toBe(0)
    await item.disconnectAll()
    expect(item.records[0]!.closes).toBe(1)
    const latest = track(item.connectInProcess('api', server))
    await item.started(2)
    item.records[1]!.gate.resolve()
    await latest
    item.records[0]!.gate.resolve()
    await Promise.all([a, b])
    expect((await item.callTool('mcp__api__tool_1', {})).content).toBe('client_1')
    expect(item.records.map(record => record.closes)).toEqual([1, 0])
  })

  test('failed in-process handshakes close and allow same-instance retries', async () => {
    const item = pool()
    const server = {} as never
    const first = track(item.connectInProcess('api', server))
    await item.started(1)
    item.records[0]!.gate.reject(new Error('API handshake failed'))
    await expect(first).rejects.toThrow('Failed to connect to the MCP server')
    const second = track(item.connectInProcess('api', server))
    await item.started(2)
    item.records[1]!.gate.resolve()
    await second
    expect(item.isConnected('api')).toBe(true)
    expect(item.records.map(record => record.closes)).toEqual([1, 0])
  })
})
