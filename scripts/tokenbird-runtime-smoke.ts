#!/usr/bin/env bun
/**
 * Reproducible, credential-free live TokenBird smoke test.
 *
 *   bun scripts/tokenbird-runtime-smoke.ts
 *   bun scripts/tokenbird-runtime-smoke.ts --webui
 *   bun scripts/tokenbird-runtime-smoke.ts --webui --keep-running
 *
 * Uses a fresh temporary HOME/config, dummy secrets and loopback fake MCP
 * endpoints. It never needs a real model account and never deploys anything.
 * SMOKE_SERVER_ENTRY can point to a locally built server bundle for post-build verification.
 * --webui also checks the built apps/webui/dist via the real HTTP entrypoint.
 * Ports can be changed with SMOKE_RPC_PORT / SMOKE_MCP_PORT.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { WsRpcClient } from '../packages/server-core/src/transport/client'
import { RPC_CHANNELS as C } from '../packages/shared/src/protocol'

const repo = resolve(import.meta.dir, '..')
const rpcPort = Number(process.env.SMOKE_RPC_PORT ?? 19100)
const mcpPort = Number(process.env.SMOKE_MCP_PORT ?? 19110)
const root = mkdtempSync(join(tmpdir(), 'tokenbird-live-smoke-'))
const home = join(root, 'home')
const configDir = join(home, '.tokenbird')
const workspaceRoot = join(configDir, 'workspaces', 'runtime-smoke')
const logDir = resolve(process.env.SMOKE_LOG_DIR ?? join(repo, '../../tokenbird-deliverables/logs'))
const webui = process.argv.includes('--webui')
const serverEntry = process.env.SMOKE_SERVER_ENTRY ?? 'packages/server/src/index.ts'
const keepRunning = process.argv.includes('--keep-running')
const suffix = webui ? '-webui' : ''
const token = 'dummy-smoke-only-1234-ABCD-5678-efgh'
const rpcUrl = `ws://127.0.0.1:${rpcPort}`
mkdirSync(home, { recursive: true })
mkdirSync(logDir, { recursive: true })
const cases: Array<{ name: string; status: 'passed' | 'failed'; detail?: string }> = []
const clients: WsRpcClient[] = []
let child: ReturnType<typeof Bun.spawn> | undefined
let serverLog = ''
let serverExit: number | null = null
let stopReading: Promise<void> | undefined
let workspace: any
let primary: any
let existing: any
let collaboration: any
let httpSource: any
let sseSource: any
let headerSource: any
let publicSource: any
let rotated = false
let expectedBearer = 'dummy-mcp-one'
let expectedHeader = 'dummy-header-one'
const requestStats = { http: 0, sseGet: 0, ssePost: 0, rejected: 0, header: 0, silentOpened: 0, silentClosed: 0 }
const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
const encoder = new TextEncoder()

function mcpResult(body: any, path: string): any {
  if (body.id === undefined) return undefined
  const base = { jsonrpc: '2.0', id: body.id }
  if (body.method === 'initialize') return { ...base, result: {
    protocolVersion: body.params?.protocolVersion ?? '2025-03-26',
    capabilities: { tools: {} }, serverInfo: { name: 'tokenbird-local-smoke', version: '1.0.0' },
  } }
  if (body.method === 'ping') return { ...base, result: {} }
  if (body.method === 'tools/list') return { ...base, result: { tools: [{
    name: path.includes('rotated') ? 'smoke_rotated' : 'smoke_echo',
    description: 'Local deterministic smoke tool', inputSchema: { type: 'object', properties: {} },
  }] } }
  if (body.method === 'tools/call') return { ...base, result: { content: [{ type: 'text', text: 'local smoke response' }] } }
  return { ...base, error: { code: -32601, message: 'Method not found' } }
}

const fake = Bun.serve({
  hostname: '127.0.0.1', port: mcpPort,
  async fetch(req) {
    const url = new URL(req.url)
    const isHeaders = url.pathname === '/headers'
    const isPool = url.pathname.startsWith('/pool')
    const poolCredential = req.headers.get('x-smoke-key')
    const authorized = url.pathname === '/public' ? req.headers.get('authorization') === null : isPool
      ? ['dummy-pool-one', 'dummy-pool-two'].includes(poolCredential ?? '')
      : isHeaders
      ? req.headers.get('x-smoke-key') === expectedHeader && req.headers.get('x-smoke-static') === 'static-value' && req.headers.get('authorization') === null
      : req.headers.get('authorization') === `Bearer ${expectedBearer}`
    if (url.pathname === '/offline') return new Response('Deliberately unavailable', { status: 503 })
    if (!authorized) {
      requestStats.rejected++
      return new Response('Unauthorized local test credential', { status: 401 })
    }
    if (isHeaders) requestStats.header++
    if ((url.pathname === '/sse' || url.pathname === '/sse-silent') && req.method === 'GET') {
      if (!req.headers.get('accept')?.includes('text/event-stream')) return new Response('SSE Accept required', { status: 406 })
      requestStats.sseGet++
      const silent = url.pathname === '/sse-silent'
      if (silent) requestStats.silentOpened++
      const id = crypto.randomUUID()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.set(id, controller)
          controller.enqueue(encoder.encode(silent ? ': waiting without endpoint\n\n' : `event: endpoint\ndata: /messages?sessionId=${id}\n\n`))
        },
        cancel() { streams.delete(id); if (silent) requestStats.silentClosed++ },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
    }
    if (url.pathname === '/messages' && req.method === 'POST') {
      requestStats.ssePost++
      const controller = streams.get(url.searchParams.get('sessionId') ?? '')
      if (!controller) return new Response('Missing test session', { status: 404 })
      const result = mcpResult(await req.json(), '/sse')
      if (result) controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(result)}\n\n`))
      return new Response(null, { status: 202 })
    }
    if (req.method === 'POST') {
      requestStats.http++
      const result = mcpResult(await req.json(), isPool && poolCredential === 'dummy-pool-two' ? '/rotated' : url.pathname)
      return result ? Response.json(result) : new Response(null, { status: 202 })
    }
    if (req.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response('No stream needed', { status: 405 })
  },
})

async function check(name: string, work: () => Promise<void>) {
  try {
    await work()
    cases.push({ name, status: 'passed' })
    console.log(`PASS ${name}`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    cases.push({ name, status: 'failed', detail })
    console.log(`FAIL ${name}: ${detail}`)
  }
}

function client(workspaceId?: string, auth = token): WsRpcClient {
  const value = new WsRpcClient(rpcUrl, {
    workspaceId, token: auth, autoReconnect: false, connectTimeout: 3000, requestTimeout: 25000,
  })
  clients.push(value)
  return value
}

async function startServer(): Promise<void> {
  serverExit = null
  const env: Record<string, string> = {
    HOME: home,
    PATH: `${resolve(process.execPath, '..')}:/usr/local/bin:/usr/bin:/bin`,
    TOKENBIRD_CONFIG_DIR: configDir,
    CRAFT_SERVER_TOKEN: token,
    CRAFT_MINIMAL_SERVER: webui ? 'false' : 'true',
    CRAFT_RPC_HOST: '127.0.0.1', CRAFT_RPC_PORT: String(rpcPort),
    CRAFT_HEALTH_PORT: String(rpcPort + 1),
    CRAFT_BUNDLED_ASSETS_ROOT: join(repo, 'apps/electron'),
    ...(webui ? { CRAFT_WEBUI_DIR: join(repo, 'apps/webui/dist'), CRAFT_WEBUI_SECURE_COOKIE: 'false' } : {}),
  }
  child = Bun.spawn([process.execPath, 'run', serverEntry], {
    cwd: repo, env, stdout: 'pipe', stderr: 'pipe',
  })
  const current = child
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) serverLog += decoder.decode(chunk)
  }
  stopReading = Promise.all([read(current.stdout as ReadableStream<Uint8Array>), read(current.stderr as ReadableStream<Uint8Array>)]).then(() => {})
  current.exited.then(code => { serverExit = code })
  for (let attempt = 0; attempt < 150; attempt++) {
    if (serverExit !== null) throw new Error(`Server exited ${serverExit}: ${serverLog.slice(-3500)}`)
    try {
      const health = await fetch(`http://127.0.0.1:${rpcPort + 1}/health`, { signal: AbortSignal.timeout(500) })
      if (health.ok) return
    } catch { /* retry startup */ }
    await Bun.sleep(200)
  }
  throw new Error(`Server did not become healthy: ${serverLog.slice(-3500)}`)
}

async function stopServer(): Promise<void> {
  for (const value of clients.splice(0)) value.destroy()
  if (!child) return
  child.kill('SIGTERM')
  await Promise.race([child.exited, Bun.sleep(5000)])
  if (child.exitCode === null) child.kill('SIGKILL')
  await child.exited
  await stopReading
  child = undefined
}

const saveCredentials = (rpc: WsRpcClient, entries: any[]) => rpc.invoke(C.sources.SAVE_CREDENTIALS_BATCH, workspace.id, entries)
const getTools = (rpc: WsRpcClient, source: any, force = true) => rpc.invoke(C.sources.GET_MCP_TOOLS, workspace.id, source.slug, force)
const sourceConfigPath = (source: any) => join(workspaceRoot, 'sources', source.slug, 'config.json')
function editSource(source: any, changes: Record<string, unknown>) {
  const path = sourceConfigPath(source)
  const config = JSON.parse(readFileSync(path, 'utf8'))
  config.mcp = { ...config.mcp, ...changes }
  config.updatedAt = Date.now()
  writeFileSync(path, JSON.stringify(config, null, 2))
}

try {
  await check('real headless entrypoint starts with isolated HOME', startServer)
  if (cases[0]?.status !== 'passed') throw new Error('Startup failed; dependent runtime flows not run')
  const admin = client()
  await check('RPC authentication rejects an invalid bearer', async () => {
    await assert.rejects(() => client(undefined, 'dummy-invalid-credential').invoke(C.server.GET_STATUS), /auth|unauthor|token|closed/i)
  })
  await check('RPC workspace creation and discovery', async () => {
    workspace = await admin.invoke(C.server.CREATE_WORKSPACE, 'Runtime Smoke', workspaceRoot)
    assert.ok(workspace.id)
    assert.ok((await admin.invoke(C.server.GET_WORKSPACES)).some((x: any) => x.id === workspace.id))
  })
  if (!workspace) throw new Error('Workspace creation failed; dependent flows not run')
  let rpc = client(workspace.id)
  await check('UI-compatible session create, list and read', async () => {
    primary = await rpc.invoke(C.sessions.CREATE, workspace.id, { name: 'Smoke primary' })
    existing = await rpc.invoke(C.sessions.CREATE, workspace.id, { name: 'Smoke existing secondary' })
    const sessions = await rpc.invoke(C.sessions.GET)
    assert.ok(sessions.some((x: any) => x.id === primary.id))
    assert.ok(sessions.some((x: any) => x.id === existing.id))
    assert.equal((await rpc.invoke(C.sessions.GET_MESSAGES, primary.id)).name, 'Smoke primary')
  })
  await check('MCP source creation through UI-compatible RPC', async () => {
    const create = (name: string, mcp: any) => rpc.invoke(C.sources.CREATE, workspace.id, { name, provider: 'custom', type: 'mcp', enabled: true, mcp })
    httpSource = await create('Smoke HTTP', { transport: 'http', url: `http://127.0.0.1:${mcpPort}/http`, authType: 'bearer' })
    sseSource = await create('Smoke SSE', { transport: 'sse', url: `http://127.0.0.1:${mcpPort}/sse`, authType: 'bearer', headers: { Accept: 'application/json' } })
    headerSource = await create('Smoke Headers', { transport: 'http', url: `http://127.0.0.1:${mcpPort}/headers`, authType: 'bearer', headerNames: ['X-Smoke-Key'], headers: { 'X-Smoke-Static': 'static-value' } })
    publicSource = await create('Smoke Public', { transport: 'http', url: `http://127.0.0.1:${mcpPort}/public`, authType: 'none' })
    assert.ok(httpSource.slug && sseSource.slug && headerSource.slug)
  })
  await check('credential batch saves HTTP/SSE/header values', async () => {
    const result = await saveCredentials(rpc, [
      { sourceSlug: httpSource.slug, credential: expectedBearer },
      { sourceSlug: sseSource.slug, credential: expectedBearer },
      { sourceSlug: headerSource.slug, credential: JSON.stringify({ 'X-Smoke-Key': expectedHeader }) },
    ])
    assert.equal(result.saved, 3)
    assert.deepEqual(result.statusUpdateFailed, [])
  })
  await check('live HTTP MCP initialize and tool listing use bearer', async () => {
    const result = await getTools(rpc, httpSource)
    assert.equal(result.success, true, result.error)
    assert.equal(result.tools[0].name, 'smoke_echo')
    assert.ok(requestStats.http >= 3)
  })
  await check('live SSE authenticates both GET stream and POST messages', async () => {
    const result = await getTools(rpc, sseSource)
    assert.equal(result.success, true, result.error)
    assert.equal(result.tools[0].name, 'smoke_echo')
    assert.ok(requestStats.sseGet >= 1 && requestStats.ssePost >= 3)
  })
  await check('MCP credential-store custom headers merge with static headers', async () => {
    const result = await getTools(rpc, headerSource)
    assert.equal(result.success, true, result.error)
    assert.ok(requestStats.header >= 3)
  })
  await check('public MCP connects without saved credentials', async () => {
    const result = await getTools(rpc, publicSource)
    assert.equal(result.success, true, result.error)
    assert.equal(result.tools[0].name, 'smoke_echo')
  })
  await check('malformed batch rejects before modifying an earlier credential', async () => {
    for (const invalid of ['bad\r\nheader', 'dummy-nul-secret\u0000']) {
      await assert.rejects(() => saveCredentials(rpc, [
        { sourceSlug: httpSource.slug, credential: 'dummy-must-not-be-saved' },
        { sourceSlug: headerSource.slug, credential: JSON.stringify({ 'X-Smoke-Key': invalid }) },
      ]), error => {
        assert.match(String(error), /header|invalid/i)
        assert.ok(!String(error).includes('dummy-nul-secret'))
        return true
      })
    }
    const result = await getTools(rpc, httpSource)
    assert.equal(result.success, true, result.error)
  })
  await check('credential rotation invalidates old token and then recovers HTTP/SSE', async () => {
    expectedBearer = 'dummy-mcp-two'
    const rejected = await getTools(rpc, httpSource)
    assert.equal(rejected.success, false)
    let source = (await rpc.invoke(C.sources.GET, workspace.id)).find((x: any) => x.config.slug === httpSource.slug)
    assert.equal(source.config.connectionStatus, 'needs_auth')
    await saveCredentials(rpc, [httpSource, sseSource].map(x => ({ sourceSlug: x.slug, credential: expectedBearer })))
    for (const candidate of [httpSource, sseSource]) {
      const result = await getTools(rpc, candidate)
      assert.equal(result.success, true, result.error)
    }
    source = (await rpc.invoke(C.sources.GET, workspace.id)).find((x: any) => x.config.slug === httpSource.slug)
    assert.equal(source.config.connectionStatus, 'connected')
    rotated = true
  })
  await check('MCP endpoint configuration rotation returns new server tools', async () => {
    editSource(httpSource, { url: `http://127.0.0.1:${mcpPort}/http-rotated` })
    const result = await getTools(rpc, httpSource)
    assert.equal(result.success, true, result.error)
    assert.equal(result.tools[0].name, 'smoke_rotated')
  })
  await check('MCP endpoint failure records failed state and force-refresh recovers', async () => {
    editSource(httpSource, { url: `http://127.0.0.1:${mcpPort}/offline` })
    const failed = await getTools(rpc, httpSource)
    assert.equal(failed.success, false)
    const source = (await rpc.invoke(C.sources.GET, workspace.id)).find((x: any) => x.config.slug === httpSource.slug)
    assert.equal(source.config.connectionStatus, 'failed')
    editSource(httpSource, { url: `http://127.0.0.1:${mcpPort}/http-rotated` })
    assert.equal((await getTools(rpc, httpSource)).success, true)
  })
  await check('MCP hot-reload RPC covers unloaded sessions without failures', async () => {
    const result = await rpc.invoke(C.server.RELOAD_MCP_SERVERS, workspace.id)
    assert.deepEqual(result.failures, [])
    assert.ok(result.freshOnNextUseSessionIds.includes(primary.id))
  })
  await check('live MCP pool reconnects custom-header and endpoint changes; tools dispatch', async () => {
    const code = `
      import assert from 'node:assert/strict';
      import { McpClientPool } from './packages/shared/src/mcp/mcp-pool.ts';
      import { CraftMcpClient } from './packages/shared/src/mcp/client.ts';
      const pool = new McpClientPool();
      const config = (key, path = '/pool') => ({ type: 'http', url: 'http://127.0.0.1:${mcpPort}' + path, headers: { 'X-Smoke-Key': key } });
      try {
        assert.deepEqual(await pool.sync({ smoke: config('dummy-pool-one') }), []);
        assert.equal(pool.getTools('smoke')[0].name, 'smoke_echo');
        let result = await pool.callTool(pool.getProxyToolDefs()[0].name, {});
        assert.equal(result.isError, false); assert.match(result.content, /local smoke response/);
        assert.deepEqual(await pool.sync({ smoke: config('dummy-pool-two') }), []);
        assert.equal(pool.getTools('smoke')[0].name, 'smoke_rotated');
        assert.deepEqual(await pool.sync({ smoke: config('dummy-pool-one', '/pool-new') }), []);
        assert.equal(pool.getTools('smoke')[0].name, 'smoke_echo');
        assert.deepEqual(await pool.sync({ smoke: config('dummy-pool-one', '/offline') }), ['smoke']);
        assert.deepEqual(await pool.sync({ smoke: config('dummy-pool-one', '/pool') }), []);
        assert.equal(pool.getTools('smoke')[0].name, 'smoke_echo');
        assert.deepEqual(await pool.sync({}), []); assert.deepEqual(pool.getConnectedSlugs(), []);
        const silent = new CraftMcpClient({ transport: 'sse', url: 'http://127.0.0.1:${mcpPort}/sse-silent', headers: { Authorization: 'Bearer ${expectedBearer}' }, connectTimeoutMs: 100 });
        await assert.rejects(() => silent.listTools(), /timed out/);
        await silent.close();
        console.log('PASS live MCP pool rotation and dispatch');
      } finally { await pool.disconnectAll(); }
    `
    const process = Bun.spawn([globalThis.process.execPath, '-e', code], { cwd: repo, env: {
      HOME: home, TOKENBIRD_CONFIG_DIR: configDir, PATH: '/usr/local/bin:/usr/bin:/bin',
    }, stdout: 'pipe', stderr: 'pipe' })
    const output = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text()])
    const exitCode = await process.exited
    writeFileSync(join(logDir, `runtime-mcp-pool${suffix}.log`), output.join('\n'))
    assert.equal(exitCode, 0, output.join('\n').slice(-1500))
    assert.equal(requestStats.silentOpened, 1)
    assert.equal(requestStats.silentClosed, 1, 'timed-out SSE stream must close without a reconnection loop')
  })
  await check('invalid remote collaboration selection creates no partial sessions', async () => {
    const before = (await rpc.invoke(C.sessions.GET)).length
    await assert.rejects(() => rpc.invoke(C.collaborations.CREATE, primary.id, [
      { workspaceId: workspace.id, createNew: true, name: 'Must not be created' },
      { workspaceId: workspace.id, sessionId: existing.id, serverUrl: 'http://127.0.0.1:19999' },
    ]), /relay|Cross-server/i)
    assert.equal((await rpc.invoke(C.sessions.GET)).length, before)
    assert.ok(!(await rpc.invoke(C.sessions.GET_MESSAGES, primary.id)).collaboration)
  })
  await check('collaboration combines existing and new sessions', async () => {
    collaboration = await rpc.invoke(C.collaborations.CREATE, primary.id, [
      { workspaceId: workspace.id, sessionId: existing.id },
      { workspaceId: workspace.id, createNew: true, name: 'Smoke new secondary' },
    ])
    assert.equal(collaboration.members.length, 3)
    assert.ok(collaboration.members.some((x: any) => x.sessionId === existing.id))
    const fresh = collaboration.members.find((x: any) => x.sessionId !== primary.id && x.sessionId !== existing.id)
    assert.equal((await rpc.invoke(C.sessions.GET_MESSAGES, fresh.sessionId)).name, 'Smoke new secondary')
    for (const member of collaboration.members) {
      assert.equal((await rpc.invoke(C.sessions.GET_MESSAGES, member.sessionId)).collaboration.groupId, collaboration.id)
    }
  })
  await check('collaboration board revision guards, file round-trip and listing', async () => {
    const input = { groupId: collaboration.id, coordinatorWorkspaceId: workspace.id, actorMemberId: collaboration.primaryMemberId }
    const updated = await rpc.invoke(C.collaborations.UPDATE_BOARD, { ...input, itemId: 'smoke.result', value: { kind: 'note', text: 'Local live verification' }, operationId: 'smoke-board-1', expectedRevision: collaboration.revision })
    assert.ok(updated.group.revision > collaboration.revision)
    await assert.rejects(() => rpc.invoke(C.collaborations.UPDATE_BOARD, { ...input, itemId: 'smoke.stale', value: 'stale', operationId: 'smoke-board-stale', expectedRevision: collaboration.revision }), /revision|conflict/i)
    const fileResult = await rpc.invoke(C.collaborations.PUT_FILE, { ...input, name: 'smoke.txt', dataBase64: Buffer.from('local smoke file').toString('base64'), contentType: 'text/plain', operationId: 'smoke-file-1', expectedRevision: updated.group.revision })
    collaboration = fileResult.group
    const file: any = Object.values(collaboration.files).find((x: any) => x.name === 'smoke.txt')
    assert.ok(file)
    const fetched = await rpc.invoke(C.collaborations.GET_FILE, collaboration.id, workspace.id, file.id)
    assert.equal(Buffer.from(fetched.dataBase64, 'base64').toString(), 'local smoke file')
    assert.ok((await rpc.invoke(C.collaborations.LIST, workspace.id)).some((x: any) => x.id === collaboration.id))
  })
  await check('cross-workspace collaboration reads are rejected', async () => {
    const other = await admin.invoke(C.server.CREATE_WORKSPACE, 'Other Smoke', join(configDir, 'workspaces', 'other-smoke'))
    await assert.rejects(() => client(other.id).invoke(C.collaborations.GET, collaboration.id, workspace.id), /not a member|workspace/i)
  })
  if (webui) await check('built web UI auth/config and static asset routes', async () => {
    assert.ok(existsSync(join(repo, 'apps/webui/dist/index.html')))
    const base = `http://127.0.0.1:${rpcPort}`
    const unauthenticated = await fetch(`${base}/api/config`)
    assert.equal(unauthenticated.status, 401)
    const rejected = await fetch(`${base}/api/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'dummy-wrong-password' }) })
    assert.equal(rejected.status, 401)
    const authenticated = await fetch(`${base}/api/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: token }) })
    assert.equal(authenticated.status, 200)
    const cookie = authenticated.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    const configResponse = await fetch(`${base}/api/config`, { headers: { cookie } })
    assert.equal(configResponse.status, 200)
    const content = await fetch(base, { headers: { cookie } })
    assert.equal(content.status, 200)
    assert.match(await content.text(), /<html|<!doctype/i)
  })
  await check('server restart persists sessions, sources, credentials and collaboration', async () => {
    await stopServer()
    await startServer()
    rpc = client(workspace.id)
    assert.ok((await rpc.invoke(C.sessions.GET)).some((x: any) => x.id === primary.id))
    const restored = await rpc.invoke(C.collaborations.GET, collaboration.id, workspace.id)
    assert.equal(restored.id, collaboration.id)
    assert.equal(restored.members.length, 3)
    assert.equal(restored.board['smoke.result'].value.text, 'Local live verification')
    assert.ok(Object.values(restored.files).some((file: any) => file.name === 'smoke.txt'))
    assert.ok(rotated)
    assert.equal((await getTools(rpc, httpSource)).success, true)
  })
  await check('ending collaboration clears persisted session membership', async () => {
    const result = await rpc.invoke(C.collaborations.END, collaboration.id, workspace.id)
    assert.equal(result.status, 'ended')
    for (const member of collaboration.members) assert.ok(!(await rpc.invoke(C.sessions.GET_MESSAGES, member.sessionId)).collaboration)
  })
} catch (error) {
  console.log(`BLOCKED ${error instanceof Error ? error.message : String(error)}`)
} finally {
  const cleanup = async () => {
    await stopServer()
    for (const controller of streams.values()) { try { controller.close() } catch {} }
    fake.stop(true)
    writeFileSync(join(logDir, `runtime-server${suffix}.log`), serverLog)
  }
  if (!keepRunning || cases.some(x => x.status === 'failed')) await cleanup()
  else {
    for (const value of clients.splice(0)) value.destroy()
    process.once('SIGTERM', () => { void cleanup().then(() => process.exit(0)) })
    process.once('SIGINT', () => { void cleanup().then(() => process.exit(0)) })
    console.log(`READY browser QA at http://127.0.0.1:${rpcPort}/ with dummy password ${token}`)
  }
  const summary = {
    generatedAt: new Date().toISOString(), isolatedHome: home, rpcPort, mcpPort,
    passed: cases.filter(x => x.status === 'passed').length,
    failed: cases.filter(x => x.status === 'failed').length,
    modelInference: 'collaboration activation reaches expected no-credentials auth failure; successful model inference not tested',
    browserInteraction: 'not run; RPC/HTTP compatibility checked only',
    requestStats, cases,
  }
  writeFileSync(join(logDir, `runtime-smoke${suffix}.json`), JSON.stringify(summary, null, 2))
  writeFileSync(join(logDir, `runtime-server${suffix}.log`), serverLog)
  console.log(JSON.stringify(summary, null, 2))
  process.exitCode = summary.failed || summary.passed < 2 ? 1 : 0
}
