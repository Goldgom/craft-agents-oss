import { afterEach, expect, test } from 'bun:test'
import { getEventListeners } from 'node:events'
import { CraftMcpClient, type PoolCallToolOptions } from '../client.ts'
import { ApiSourcePoolClient } from '../api-source-pool-client.ts'
import { McpClientPool } from '../mcp-pool.ts'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { withMcpRequestLifetime, MCP_REQUEST_FAILURE_REASON } from '../request-lifetime.ts'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
async function eventually(check: () => boolean) {
  const end = performance.now() + 3000
  while (!check()) { if (performance.now() > end) throw new Error('Fixture observation timed out'); await tick() }
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

function fixture() {
  const calls = new Map<string, number>()
  const notifications: Array<{ requestId: number; reason: string }> = []
  const held = new Map<string, { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> }>()
  const failureIds = new Set<string>()
  let rejectCancellation = false
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method === 'GET') return new Response(null, { status: 405 })
    const body = await request.json() as any
    if (body.method === 'notifications/cancelled') {
      notifications.push(body.params)
      return new Response(rejectCancellation ? 'synthetic-cancellation-response-marker' : null, { status: rejectCancellation ? 500 : 202 })
    }
    if (body.id === undefined) return new Response(null, { status: 202 })
    let result: unknown
    if (body.method === 'initialize') result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'cleanup-fixture', version: '1' } }
    else if (body.method === 'tools/list') result = { tools: [{ name: 'mutate_once', inputSchema: { type: 'object' } }] }
    else if (body.method === 'tools/call') {
      const id = String(body.params.arguments.id)
      calls.set(id, (calls.get(id) ?? 0) + 1)
      const hold = held.get(id)
      if (hold) { hold.entered.resolve(); await hold.release.promise }
      if (failureIds.has(id)) return new Response('synthetic-response-failure', { status: 500 })
      result = { content: [{ type: 'text', text: `result:${id}` }], ...(id === 'tool-error' ? { isError: true } : {}) }
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result })
  } })
  const client = new CraftMcpClient({ transport: 'http', url: `http://127.0.0.1:${server.port}/mcp` })
  const sdk = (client as any).client
  const errors: unknown[] = []
  const pending: Promise<unknown>[] = []
  const invoke = (id: string, options?: PoolCallToolOptions) => {
    const promise = client.callTool('mutate_once', { id }, options).catch(error => { errors.push(error); throw error })
    pending.push(promise)
    void promise.catch(() => {})
    return promise
  }
  const hold = (id: string) => { const result = { entered: gate(), release: gate() }; held.set(id, result); return result }
  cleanups.push(async () => {
    for (const entry of held.values()) entry.release.resolve()
    await client.close()
    await Promise.allSettled(pending)
    await server.stop(true)
  })
  return { client, sdk, calls, notifications, errors, failureIds, hold, invoke, url: `http://127.0.0.1:${server.port}/mcp`, rejectCancellation: () => { rejectCancellation = true } }
}
function emptyRequests(sdk: any) {
  expect(sdk._responseHandlers.size).toBe(0)
  expect(sdk._timeoutInfo.size).toBe(0)
  expect(sdk._progressHandlers.size).toBe(0)
}

test('100 successful requests detach reused parent signal without cancellation or mutation replay', async () => {
  const item = fixture()
  const controller = new AbortController()
  await item.client.listTools()
  for (let index = 0; index < 100; index++) {
    expect(await item.invoke(`success-${index}`, { signal: controller.signal })).toEqual({ content: [{ type: 'text', text: `result:success-${index}` }] })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    emptyRequests(item.sdk)
  }
  controller.abort('after completed successes')
  await tick()
  expect(item.notifications).toHaveLength(0)
  expect([...item.calls.values()]).toEqual(Array(100).fill(1))
})

test('100 failed sends with and without caller signals clean callbacks and preserve original rejection', async () => {
  const item = fixture()
  const controller = new AbortController()
  await item.client.listTools()
  for (let index = 0; index < 100; index++) {
    const id = `failure-${index}`
    item.failureIds.add(id)
    const error = await item.invoke(id, index % 2 ? { signal: controller.signal } : undefined).catch(error => error)
    expect(error).toBe(item.errors.at(-1))
    expect((error as Error).message).toContain('synthetic-response-failure')
    expect(item.calls.get(id)).toBe(1)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    emptyRequests(item.sdk)
  }
  await eventually(() => item.notifications.length === 100)
  expect(item.notifications.every(item => item.reason === MCP_REQUEST_FAILURE_REASON)).toBe(true)
  expect(await item.invoke('after-failures')).toEqual({ content: [{ type: 'text', text: 'result:after-failures' }] })
  emptyRequests(item.sdk)
  expect(item.client.isConnected()).toBe(true)
  expect([...item.calls.values()]).toEqual(Array(101).fill(1))
})

test('MCP tool-error results preserve original content and never send cancellation', async () => {
  const item = fixture()
  const controller = new AbortController()
  expect(await item.invoke('tool-error', { signal: controller.signal })).toEqual({ content: [{ type: 'text', text: 'result:tool-error' }], isError: true })
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  emptyRequests(item.sdk)
  await tick()
  expect(item.notifications).toHaveLength(0)
  expect(item.calls.get('tool-error')).toBe(1)
})

test('one failed request does not cancel an in-flight sibling sharing the parent signal', async () => {
  const item = fixture()
  const controller = new AbortController()
  await item.client.listTools()
  const failing = item.hold('failing')
  const sibling = item.hold('sibling')
  item.failureIds.add('failing')
  const failure = item.invoke('failing', { signal: controller.signal })
  const success = item.invoke('sibling', { signal: controller.signal })
  await Promise.all([failing.entered.promise, sibling.entered.promise])
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(2)
  failing.release.resolve()
  await expect(failure).rejects.toThrow('synthetic-response-failure')
  expect(controller.signal.aborted).toBe(false)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
  expect(item.sdk._responseHandlers.size).toBe(1)
  expect(item.sdk._timeoutInfo.size).toBe(1)
  sibling.release.resolve()
  expect(await success).toEqual({ content: [{ type: 'text', text: 'result:sibling' }] })
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  emptyRequests(item.sdk)
  expect([...item.calls.values()]).toEqual([1, 1])
})

test('request timeout retains its original error and leaves a shared-parent sibling usable', async () => {
  const item = fixture()
  const controller = new AbortController()
  await item.client.listTools()
  const timed = item.hold('timed')
  const sibling = item.hold('sibling')
  const timeout = item.invoke('timed', { signal: controller.signal, timeoutMs: 30 })
  const success = item.invoke('sibling', { signal: controller.signal, timeoutMs: 2000 })
  await Promise.all([timed.entered.promise, sibling.entered.promise])
  const error = await timeout.catch(error => error)
  expect(error).toBe(item.errors.at(-1))
  expect((error as Error).message).toContain('timed out')
  expect(controller.signal.aborted).toBe(false)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
  expect(item.sdk._responseHandlers.size).toBe(1)
  expect(item.sdk._timeoutInfo.size).toBe(1)
  timed.release.resolve()
  sibling.release.resolve()
  expect(await success).toEqual({ content: [{ type: 'text', text: 'result:sibling' }] })
  emptyRequests(item.sdk)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  expect([...item.calls.values()]).toEqual([1, 1])
})

test('live caller abort cancels its request but not an unrelated sibling', async () => {
  const item = fixture()
  const controller = new AbortController()
  await item.client.listTools()
  const cancelled = item.hold('cancelled')
  const sibling = item.hold('sibling')
  const aborting = item.invoke('cancelled', { signal: controller.signal })
  const success = item.invoke('sibling')
  await Promise.all([cancelled.entered.promise, sibling.entered.promise])
  controller.abort('synthetic caller reason')
  const error = await aborting.catch(error => error)
  expect(error).toBe(item.errors.at(-1))
  expect((error as Error).message).toContain('synthetic caller reason')
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  expect(item.sdk._responseHandlers.size).toBe(1)
  await eventually(() => item.notifications.length === 1)
  cancelled.release.resolve()
  sibling.release.resolve()
  expect(await success).toEqual({ content: [{ type: 'text', text: 'result:sibling' }] })
  emptyRequests(item.sdk)
  expect([...item.calls.values()]).toEqual([1, 1])
})

test('a pre-aborted caller never sends a mutation or adds a lingering listener', async () => {
  const item = fixture()
  await item.client.listTools()
  const controller = new AbortController()
  const reason = new Error('synthetic already cancelled')
  controller.abort(reason)
  const error = await item.invoke('must-not-send', { signal: controller.signal }).catch(error => error)
  expect(error).toBe(reason)
  expect(item.calls.size).toBe(0)
  expect(item.notifications).toHaveLength(0)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  emptyRequests(item.sdk)
})

test('failed best-effort cancellation cannot replace the original transport error', async () => {
  const item = fixture()
  await item.client.listTools()
  item.rejectCancellation()
  item.failureIds.add('failure')
  const error = await item.invoke('failure').catch(error => error)
  expect(error).toBe(item.errors.at(-1))
  expect((error as Error).message).toContain('synthetic-response-failure')
  await eventually(() => item.notifications.length === 1)
  emptyRequests(item.sdk)
  expect(item.calls.get('failure')).toBe(1)
})

test('failed cleanup notification has no SDK error logger and cannot escape pool error sanitization', async () => {
  const item = fixture()
  const logs: string[] = []
  const pool = new McpClientPool({ debug: message => logs.push(message) })
  cleanups.push(() => pool.disconnectAll())
  await pool.ensureConnected('fixture', { type: 'http', url: item.url })
  const sdk = (pool as any).clients.get('fixture').client
  expect(sdk.onerror).toBeUndefined()
  item.rejectCancellation()
  item.failureIds.add('failure')
  const result = await pool.callTool('mcp__fixture__mutate_once', { id: 'failure' })
  expect(result.isError).toBe(true)
  expect(result.content).toContain('outcome may be unknown')
  await eventually(() => item.notifications.length === 1)
  await tick()
  expect(result.content).not.toContain('synthetic-response-failure')
  expect(result.content).not.toContain('synthetic-cancellation-response-marker')
  expect(logs.join('\n')).not.toContain('synthetic-response-failure')
  expect(logs.join('\n')).not.toContain('synthetic-cancellation-response-marker')
  emptyRequests(sdk)
  expect(item.calls.get('failure')).toBe(1)
})

test('explicit close during a request clears scoped forwarding and preserves rejection', async () => {
  const item = fixture()
  await item.client.listTools()
  const controller = new AbortController()
  const held = item.hold('during-close')
  const pending = item.invoke('during-close', { signal: controller.signal })
  await held.entered.promise
  await item.client.close()
  const error = await pending.catch(error => error)
  expect(error).toBe(item.errors.at(-1))
  expect((error as Error).message).toContain('Connection closed')
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  emptyRequests(item.sdk)
  held.release.resolve()
  expect(item.calls.get('during-close')).toBe(1)
})

test('in-process API requests detach reused parents and preserve successful tool-error results', async () => {
  const server = new McpServer({ name: 'scoped-api-fixture', version: '1' })
  let calls = 0
  let toolError = false
  server.tool('mutate_once', async () => { calls++; return { content: [{ type: 'text', text: 'original API content' }], isError: toolError } })
  const client = new ApiSourcePoolClient(server)
  cleanups.push(async () => { await client.close(); await server.close() })
  const controller = new AbortController()
  await client.listTools()
  for (let index = 0; index < 100; index++) {
    toolError = index % 2 === 0
    const result = await client.callTool('mutate_once', {}, { signal: controller.signal })
    expect(result).toEqual({ content: [{ type: 'text', text: 'original API content' }], isError: toolError })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    emptyRequests((client as any).client)
  }
  expect(calls).toBe(100)
})

test('cleanup exceptions never replace original success or failure', async () => {
  const controller = new AbortController()
  const remove = controller.signal.removeEventListener.bind(controller.signal)
  const cleanupError = new Error('synthetic cleanup error')
  controller.signal.removeEventListener = (...args) => { remove(...args); throw cleanupError }
  const success = { unchanged: true }
  expect(await withMcpRequestLifetime(async () => success, controller.signal)).toBe(success)
  const original = new Error('original failure')
  expect(await withMcpRequestLifetime(async () => { throw original }, controller.signal).catch(error => error)).toBe(original)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})
