import { expect, test } from 'bun:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpClientPool } from '../mcp-pool.ts'
import { ApiSourcePoolClient } from '../api-source-pool-client.ts'
import { mcpRuntimeLimiter } from '../runtime-limiter.ts'
import { deferred } from './fixtures/pool-race-harness.ts'

/** Real SDK transport and client; only the remote endpoint is a local fixture. */
function httpFixture(options?: { holdFirstList?: boolean }) {
  const firstList = deferred()
  const releaseFirst = deferred()
  const sessions = new Map<string, number>()
  let sessionCount = 0
  let callCount = 0
  let failure: 'initialize' | 'call' | undefined
  let toolError = false
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      if (request.method === 'GET') return new Response(null, { status: 405 })
      if (request.method === 'DELETE') return new Response(null, { status: 200 })
      const body = await request.json() as { id?: number; method: string; params?: { protocolVersion?: string } }
      if (body.method === 'initialize' && failure === 'initialize') {
        return new Response(`Rejected ${request.headers.get('x-dummy-credential')}`, { status: 500 })
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      let result: unknown
      if (body.method === 'initialize') {
        const index = sessionCount++
        const session = `dummy-session-${index}`
        sessions.set(session, index)
        headers['Mcp-Session-Id'] = session
        result = { protocolVersion: body.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'local-fixture', version: '1' } }
      } else if (body.method === 'tools/list') {
        const index = sessions.get(request.headers.get('mcp-session-id')!)!
        if (index === 0 && options?.holdFirstList) { firstList.resolve(); await releaseFirst.promise }
        result = { tools: [{ name: 'dummy_tool', inputSchema: { type: 'object', properties: {} } }] }
      } else if (body.method === 'tools/call') {
        callCount++
        if (failure === 'call') return new Response(`Applied once: ${request.headers.get('x-dummy-credential')}`, { status: 500 })
        result = { content: [{ type: 'text', text: toolError ? 'Intentional tool error details' : 'local result' }], isError: toolError }
      } else if (body.id === undefined) return new Response(null, { status: 202 })
      else return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Unknown method' } })
      return Response.json({ jsonrpc: '2.0', id: body.id, result }, { headers })
    },
  })
  return {
    config: (tag = 'dummy-private-marker') => ({ type: 'http' as const, url: `http://127.0.0.1:${server.port}/mcp`, headers: { 'X-Dummy-Credential': tag } }),
    firstList, releaseFirst,
    fail: (value?: typeof failure) => { failure = value },
    returnToolError: () => { toolError = true },
    callCount: () => callCount,
    sessionCount: () => sessionCount,
    close: () => { releaseFirst.resolve(); server.stop(true) },
  }
}

test('real HTTP handshake cancellation cannot remove a usable replacement', async () => {
  const fixture = httpFixture({ holdFirstList: true })
  const pool = new McpClientPool()
  const pending: Promise<unknown>[] = []
  try {
    const old = pool.ensureConnected('http', fixture.config('old'))
    pending.push(old)
    void old.catch(() => {})
    await fixture.firstList.promise
    await pool.ensureConnected('http', fixture.config('new'))
    expect((await pool.callTool('mcp__http__dummy_tool', {})).content).toBe('local result')
    fixture.releaseFirst.resolve()
    await Promise.allSettled(pending)
    expect(pool.isConnected('http')).toBe(true)
    expect(pool.getTools('http').map(tool => tool.name)).toEqual(['dummy_tool'])
    expect((await pool.callTool('mcp__http__dummy_tool', {})).content).toBe('local result')
    expect(fixture.sessionCount()).toBe(2)
    expect(fixture.callCount()).toBe(2)
  } finally {
    fixture.releaseFirst.resolve()
    await pool.disconnectAll()
    fixture.close()
    await Promise.allSettled(pending)
  }
  expect(mcpRuntimeLimiter.getActiveCount()).toBe(0)
}, 10_000)

test('connection errors never expose echoed credentials in rejection, sync logs, or lazy-call output', async () => {
  const fixture = httpFixture()
  const logs: string[] = []
  const pool = new McpClientPool({ debug: message => logs.push(message) })
  try {
    fixture.fail('initialize')
    const error = await pool.ensureConnected('http', fixture.config()).then(() => undefined, error => error as Error)
    expect(error?.message).toContain('Failed to connect to the MCP server')
    expect(error?.stack).not.toContain('dummy-private-marker')
    expect(error?.cause).toBeUndefined()
    expect(await pool.sync({ http: fixture.config() })).toEqual(['http'])
    expect(logs.join('\n')).not.toContain('dummy-private-marker')
    fixture.fail()
    await pool.ensureConnected('http', fixture.config())
    await mcpRuntimeLimiter.clearIdleRuntimes()
    fixture.fail('initialize')
    const result = await pool.callTool('mcp__http__dummy_tool', {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Failed to connect to the MCP server')
    expect(result.content).not.toContain('dummy-private-marker')
    expect(fixture.callCount()).toBe(0)
  } finally { await pool.disconnectAll(); fixture.close() }
})

test('real transport failure after mutation is sanitized, never replayed, and warns of unknown outcome', async () => {
  const fixture = httpFixture()
  const pool = new McpClientPool()
  try {
    await pool.ensureConnected('http', fixture.config())
    fixture.fail('call')
    const result = await pool.callTool('mcp__http__dummy_tool', {})
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('dummy-private-marker')
    expect(result.content).toContain('outcome may be unknown')
    expect(result.content).toContain('check the remote state before retrying')
    expect(fixture.callCount()).toBe(1)
    expect(pool.isConnected('http')).toBe(true)
    expect(fixture.sessionCount()).toBe(1)
    fixture.fail()
    fixture.returnToolError()
    const toolError = await pool.callTool('mcp__http__dummy_tool', {})
    expect(toolError).toEqual({ content: 'Intentional tool error details', isError: true })
    expect(fixture.callCount()).toBe(2)
    expect(pool.isConnected('http')).toBe(true)
    expect(fixture.sessionCount()).toBe(1)
  } finally { await pool.disconnectAll(); fixture.close() }
})

test('real in-process server can reappear during pending shutdown without stale wrapper close', async () => {
  const server = new McpServer({ name: 'api-fixture', version: '1' })
  let calls = 0
  server.tool('dummy_tool', async () => { calls++; return { content: [{ type: 'text', text: 'api result' }] } })
  const pool = new McpClientPool()
  try {
    await Promise.all([pool.connectInProcess('api', server), pool.connectInProcess('api', server)])
    const closing = pool.disconnectAll()
    const replacement = pool.connectInProcess('api', server)
    await Promise.all([closing, replacement])
    expect(pool.isConnected('api')).toBe(true)
    expect((await pool.callTool('mcp__api__dummy_tool', {})).content).toBe('api result')
    expect(calls).toBe(1)
    expect(mcpRuntimeLimiter.getActiveCount()).toBe(0)
  } finally { await pool.disconnectAll(); await server.close() }
})

test('API wrapper closes its pending pair once and never closes a later same-server wrapper', async () => {
  const server = new McpServer({ name: 'api-fixture', version: '1' })
  server.tool('dummy_tool', async () => ({ content: [{ type: 'text', text: 'api result' }] }))
  const connected = deferred()
  const release = deferred()
  const originalConnect = server.connect.bind(server)
  let connects = 0
  server.connect = async transport => {
    await originalConnect(transport)
    if (++connects === 1) { connected.resolve(); await release.promise }
  }
  const old = new ApiSourcePoolClient(server)
  const replacement = new ApiSourcePoolClient(server)
  const pending = old.listTools()
  void pending.catch(() => {})
  try {
    await connected.promise
    await old.close()
    expect((await replacement.listTools()).map(tool => tool.name)).toEqual(['dummy_tool'])
    release.resolve()
    await expect(pending).rejects.toThrow('closed during connection')
    await old.close()
    const result = await replacement.callTool('dummy_tool', {}) as { content: Array<{ text: string }> }
    expect(result.content[0]!.text).toBe('api result')
    expect(connects).toBe(2)
  } finally {
    release.resolve()
    await Promise.allSettled([pending])
    await Promise.all([old.close(), replacement.close()])
    await server.close()
  }
})
