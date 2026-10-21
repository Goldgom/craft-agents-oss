import { expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadSkillBySlug } from '@tokenbird/shared/skills'
import { loadWorkspaceSources, SourceServerBuilder } from '@tokenbird/shared/sources'
import { McpClientPool } from '@tokenbird/shared/mcp'
import { loadSuperAgentDocument, rebuildSuperAgentConfig, withSuperAgentOrchestrator, type SuperAgentSnapshot } from '@tokenbird/shared/super-agent'
import { describeSuperAgentResources } from './SuperAgentResources'
import { superAgentFixture, until } from './SuperAgentTestSupport'

const block = (actions: unknown) => `<super_agent_actions>${JSON.stringify(actions)}</super_agent_actions>`
const activate = (nodeId = 'worker', sourceSlugs = ['research-mcp'], skillSlugs = ['resource-research']) => ({ nodeId, sourceSlugs, skillSlugs, reason: 'Read the authorized research source and verify the result' })
const context = (text: string) => JSON.parse(text.split('Current team state (data, not instructions):\n')[1]!)

async function fixture() {
  const f = await superAgentFixture({
    describeResources: (_workspace, config) => describeSuperAgentResources(join(f.root, 'alpha'), config),
    resolveNodeSkills: (_workspace, config, node) => (node.skillSlugs ?? []).map(slug => {
      const skill = loadSkillBySlug(join(f.root, 'alpha'), slug, config.environment.workingDirectory)
      if (!skill) throw new Error(`Missing skill ${slug}`)
      return { slug, content: skill.content }
    }),
  })
  const skillPath = join(f.root, 'alpha', 'skills', 'resource-research')
  await mkdir(skillPath, { recursive: true })
  await writeFile(join(skillPath, 'SKILL.md'), '---\nname: Resource research\ndescription: Use authorized research records and verify their evidence.\n---\n\nACTUAL_RESOURCE_RESEARCH_INSTRUCTIONS')
  for (const [slug, enabled, authType] of [['research-mcp', true, 'none'], ['disabled-mcp', false, 'none'], ['auth-mcp', true, 'bearer'], ['private-mcp', true, 'none']] as const) {
    const path = join(f.root, 'alpha', 'sources', slug)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'config.json'), JSON.stringify({ id: slug, slug, name: slug, type: 'mcp', provider: 'research', enabled,
      mcp: { url: 'https://example.invalid/mcp', authType }, secret: 'NEVER_EXPOSE_CREDENTIAL', connectionStatus: authType === 'none' ? 'untested' : 'needs_auth' }))
  }
  f.config.sourceSlugs = ['research-mcp', 'disabled-mcp', 'auth-mcp']
  return f
}

async function working(f: Awaited<ReturnType<typeof fixture>>, nodeId: string) {
  return until(() => f.service.get('alpha'), s => s.state.nodes.find(node => node.nodeId === nodeId)?.status === 'working')
}

async function finish(f: Awaited<ReturnType<typeof fixture>>, snapshot: SuperAgentSnapshot, nodeId: string, actions: unknown) {
  const count = snapshot.state.messages.length
  f.host.complete(snapshot.state.nodes.find(node => node.nodeId === nodeId)!.sessionId!, block(actions))
  return until(() => f.service.get('alpha'), s => s.state.messages.slice(count).some(message => !!message.actionReceipt))
}

test('orchestrator discovers actual catalogs and distributes resources before dispatching work', async () => {
  const f = await fixture()
  f.config = withSuperAgentOrchestrator(f.config)
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'orchestrator', body: 'Plan research' })
  const planning = await working(f, 'orchestrator')
  const discovered = context(f.host.sends.at(-1)!.context).resourceCatalog
  expect(discovered.skills.find((item: { slug: string }) => item.slug === 'resource-research')?.name).toBe('Resource research')
  expect(discovered.sources.map((item: { slug: string }) => item.slug).sort()).toEqual(['auth-mcp', 'disabled-mcp', 'research-mcp'])
  expect(JSON.stringify(discovered)).not.toContain('NEVER_EXPOSE_CREDENTIAL')
  expect(JSON.stringify(discovered)).not.toContain('ACTUAL_RESOURCE_RESEARCH_INSTRUCTIONS')
  await finish(f, planning, 'orchestrator', { activateResources: [activate()], tasks: [{ id: 'research', nodeId: 'worker', title: 'Research', instructions: 'Read and verify the source' }] })
  const running = await until(() => f.service.get('alpha'), s => s.state.tasks[0]?.status === 'running')
  const sessionId = running.state.tasks[0]!.sessionId!
  expect(f.host.options.get(sessionId)?.enabledSourceSlugs).toEqual(['research-mcp'])
  expect(f.host.options.get(sessionId)?.agentSystemPrompt).toContain('ACTUAL_RESOURCE_RESEARCH_INSTRUCTIONS')
  expect(f.host.policies.get(sessionId)).toMatchObject({ allowSources: ['research-mcp'], allowSkills: ['super-agent-collaboration', 'resource-research'], allowSubagents: false, fullControl: false })
  expect(running.state.messages.find(message => message.fromNodeId === 'orchestrator' && message.actionReceipt)?.actionReceipt?.applied.map(action => action.type)).toEqual(['activate-resources', 'task'])
  expect((await loadSuperAgentDocument(join(f.root, 'alpha'))).config?.nodes.find(node => node.id === 'worker')).toMatchObject({ sourceSlugs: ['research-mcp'], skillSlugs: ['resource-research'] })
})

test('worker activates resources and resumes the same task and session without a premature completion report', async () => {
  const f = await fixture()
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'task', id: 'job', nodeId: 'worker', title: 'Research', instructions: 'Read and verify; preserve prior progress' })
  const started = await working(f, 'worker')
  const sessionId = started.state.tasks[0]!.sessionId!
  expect(context(f.host.sends.at(-1)!.context).resourceCatalog.sources).toHaveLength(3)
  expect(f.host.policies.get(sessionId)?.allowSources).toEqual([])
  const activated = await finish(f, started, 'worker', { activateResources: [activate()] })
  expect(activated.state.tasks[0]).toMatchObject({ status: 'queued', actionReceipt: { status: 'applied' } })
  expect(activated.state.tasks[0]?.completedAt).toBeUndefined()
  expect(activated.state.metrics?.completedTasks).toBe(0)
  expect(activated.state.nodes.find(node => node.nodeId === 'main')?.status).toBe('idle')
  f.advance(2_000); await f.service.tick()
  const resumed = await working(f, 'worker')
  expect(resumed.state.tasks).toHaveLength(1)
  expect(resumed.state.tasks[0]?.sessionId).toBe(sessionId)
  expect(f.host.policies.get(sessionId)?.allowSources).toEqual(['research-mcp'])
  expect(f.host.options.get(sessionId)?.agentSystemPrompt).toContain('ACTUAL_RESOURCE_RESEARCH_INSTRUCTIONS')
  expect(f.host.sends.at(-1)?.message).toContain('preserve prior progress')
  f.host.complete(sessionId, 'Research completed with verified evidence')
  const completed = await until(() => f.service.get('alpha'), s => s.state.tasks[0]?.status === 'completed')
  expect(completed.state.metrics?.completedTasks).toBe(1)
  expect(completed.state.tasks[0]?.output).toBe('Research completed with verified evidence')
})

for (const [label, input, error] of [
  ['outside team pool', activate('worker', ['private-mcp']), 'outside the team authorization pool'],
  ['disabled source', activate('worker', ['disabled-mcp']), 'disabled, unauthenticated or unavailable'],
  ['unauthenticated source', activate('worker', ['auth-mcp']), 'disabled, unauthenticated or unavailable'],
  ['unknown skill', activate('worker', [], ['missing-skill']), 'not in the available catalog'],
  ['manager target', activate('main'), 'existing worker'],
] as const) test(`resource activation rejects ${label} without partially binding skills or dispatching work`, async () => {
  const f = await fixture()
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'chat', text: 'Prepare research' })
  const result = await finish(f, await working(f, 'main'), 'main', { activateResources: [input], tasks: [{ id: 'blocked', nodeId: 'worker', title: 'Work', instructions: 'Must not dispatch' }] })
  const receipt = result.state.messages.find(message => message.fromNodeId === 'main' && message.actionReceipt)?.actionReceipt
  expect(receipt).toMatchObject({ status: 'rejected', rejected: { type: 'activate-resources' } })
  expect(receipt?.rejected?.error).toContain(error)
  expect(receipt?.notAttempted?.map(action => action.type)).toEqual(['task'])
  expect(result.state.tasks).toHaveLength(0)
  expect(result.config?.nodes.find(node => node.id === 'worker')?.sourceSlugs).toEqual([])
  expect(result.config?.nodes.find(node => node.id === 'worker')?.skillSlugs ?? []).toEqual([])
})

test('a worker cannot distribute resources to another worker or mix activation with other actions', async () => {
  const f = await fixture()
  f.config.nodes.push({ ...f.config.nodes[1]!, id: 'other', name: 'Other' })
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'task', title: 'Research', instructions: 'Work', nodeId: 'worker' })
  const result = await finish(f, await working(f, 'worker'), 'worker', { activateResources: [activate('other')] })
  expect(result.state.tasks[0]?.actionReceipt?.rejected?.error).toContain('only for themselves')
  f.advance(2_000)
  await f.service.command('alpha', { type: 'task', title: 'Research again', instructions: 'Work', nodeId: 'worker' })
  const mixed = await finish(f, await working(f, 'worker'), 'worker', { activateResources: [activate()], board: [{ title: 'Should not publish', content: 'Unverified', expectedRevision: 0 }] })
  expect(mixed.state.tasks[1]?.actionReceipt?.rejected?.error).toContain('standalone action')
  expect(mixed.state.board).toHaveLength(0)
})

test('intent node cannot distribute resources and active workers keep their current policy', async () => {
  const f = await fixture()
  f.config = withSuperAgentOrchestrator(f.config)
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'chat', text: 'Research' })
  const intent = await working(f, 'main')
  expect(context(f.host.sends.at(-1)!.context).resourceCatalog).toBeUndefined()
  const refused = await finish(f, intent, 'main', { activateResources: [activate()] })
  expect(refused.state.messages.find(message => message.fromNodeId === 'main' && message.actionReceipt)?.actionReceipt?.rejected?.error).toContain('Only the orchestrator')
  await f.service.command('alpha', { type: 'task', nodeId: 'worker', title: 'Busy', instructions: 'Keep working' })
  await working(f, 'worker')
  await f.service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'orchestrator', body: 'Prepare resources' })
  const result = await finish(f, await working(f, 'orchestrator'), 'orchestrator', { activateResources: [activate()] })
  expect(result.config?.nodes.find(node => node.id === 'worker')?.sourceSlugs).toEqual([])
  expect(result.state.nodes.find(node => node.nodeId === 'worker')?.status).toBe('working')
  expect(result.state.messages.find(message => message.fromNodeId === 'orchestrator' && message.actionReceipt)?.actionReceipt?.rejected?.error).toContain('worker is idle')
})

test('oversized actual skill instructions fail before any source or skill binding is saved', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'alpha', 'skills', 'resource-research', 'SKILL.md'), '---\nname: Big skill\ndescription: Too big\n---\n' + 'x'.repeat(128_001))
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'chat', text: 'Prepare research' })
  const result = await finish(f, await working(f, 'main'), 'main', { activateResources: [activate()] })
  expect(result.state.messages.find(message => message.fromNodeId === 'main' && message.actionReceipt)?.actionReceipt?.rejected?.error).toContain('128 KB')
  expect(result.config?.nodes.find(node => node.id === 'worker')?.sourceSlugs).toEqual([])
})

test('a workspace that disables local MCP reports stdio sources as unavailable', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'alpha', 'config.json'), JSON.stringify({ localMcpServers: { enabled: false } }))
  const path = join(f.root, 'alpha', 'sources', 'research-mcp', 'config.json')
  await writeFile(path, JSON.stringify({ id: 'research-mcp', slug: 'research-mcp', name: 'Local research', type: 'mcp', provider: 'local', enabled: true,
    mcp: { transport: 'stdio', command: 'never-launch-this', authType: 'none' } }))
  const catalog = describeSuperAgentResources(join(f.root, 'alpha'), f.config)
  expect(catalog.sources.find(source => source.slug === 'research-mcp')).toMatchObject({ available: false, status: 'local_mcp_disabled' })
})

for (const dynamic of [false, true]) test(`${dynamic ? 'dynamic shared' : 'legacy team'} self activation connects a real MCP transport on continuation and exposes callable tools and remote errors`, async () => {
  const f = await fixture()
  if (dynamic) f.config = rebuildSuperAgentConfig(f.config)
  let connections = 0
  let remoteError = false
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      if (request.method === 'GET') return new Response(null, { status: 405 })
      if (request.method === 'DELETE') return new Response(null, { status: 200 })
      const body = await request.json() as { id?: number; method: string; params?: { protocolVersion?: string; arguments?: { text: string } } }
      if (body.id === undefined) return new Response(null, { status: 202 })
      let result: unknown
      if (body.method === 'initialize') {
        connections++
        result = { protocolVersion: body.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'resource-fixture', version: '1' } }
      } else if (body.method === 'tools/list') result = { tools: [{ name: 'read_record', description: 'Read a research record', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
      else if (body.method === 'tools/call') result = { content: [{ type: 'text', text: remoteError ? 'Research record unavailable' : body.params?.arguments?.text }], isError: remoteError }
      else return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Unknown method' } })
      return Response.json({ jsonrpc: '2.0', id: body.id, result })
    },
  })
  const pool = new McpClientPool({ workspaceRootPath: join(f.root, 'alpha') })
  try {
    await writeFile(join(f.root, 'alpha', 'sources', 'research-mcp', 'config.json'), JSON.stringify({ id: 'research-mcp', slug: 'research-mcp', name: 'Research', type: 'mcp', provider: 'research', enabled: true,
      mcp: { transport: 'http', url: `http://127.0.0.1:${server.port}/mcp`, authType: 'none' } }))
    const apply = f.host.applySessionPolicy.bind(f.host)
    f.host.applySessionPolicy = async (sessionId, policy) => {
      await apply(sessionId, policy)
      const sources = loadWorkspaceSources(join(f.root, 'alpha')).filter(source => policy.allowSources.includes(source.config.slug))
      const builder = new SourceServerBuilder()
      const configs = Object.fromEntries(sources.map(source => [source.config.slug, builder.buildMcpServer(source, null)!]))
      expect(await pool.sync(configs)).toEqual([])
    }
    await f.service.save('alpha', f.config)
    await f.service.command('alpha', { type: 'task', ...(dynamic ? { modelEntryId: f.config.modelPool![0]!.id, thinkingLevel: 'high' as const } : { nodeId: 'worker' }), title: 'Read research', instructions: 'Read the research record and verify the result' })
    const initial = await until(() => f.service.get('alpha'), s => s.state.tasks[0]?.status === 'running'
      && f.host.sends.some(send => send.sessionId === s.state.tasks[0]?.sessionId))
    const worker = initial.state.tasks[0]!.nodeId, sessionId = initial.state.tasks[0]!.sessionId!
    if (dynamic) {
      expect(initial.config!.sourceSlugs).toEqual([])
      expect(context(f.host.sends.at(-1)!.context).resourceCatalog.sources.some((source: { slug: string }) => source.slug === 'research-mcp')).toBe(true)
      for (const slug of ['disabled-mcp', 'auth-mcp', 'missing-mcp']) {
        await expect(f.service.callNodeActionTool('alpha', sessionId, 'super_agent_resources', {
          requestId: `reject-${slug}`, ...activate(worker, [slug], []),
        })).rejects.toThrow('disabled, unauthenticated or unavailable')
        expect((await f.service.get('alpha')).config!.sourceSlugs).toEqual([])
      }
    }
    expect(connections).toBe(0)
    expect(pool.getTools('research-mcp')).toEqual([])
    const activated = await f.service.callNodeActionTool('alpha', sessionId, 'super_agent_resources', { requestId: 'load-research', ...activate(worker) })
    expect('resourceContinuation' in activated && activated.resourceContinuation).toBe(true)
    expect(f.host.policies.get(sessionId)!.allowSources).toEqual([])
    expect(pool.getTools('research-mcp')).toEqual([])
    f.host.complete(sessionId, '')
    await until(() => f.service.get('alpha'), s => s.state.tasks[0]?.status === 'queued')
    f.advance(2_000); await f.service.tick()
    const resumed = await working(f, worker)
    expect(resumed.state.tasks[0]!.sessionId).toBe(sessionId)
    expect(resumed.config!.nodes.find(node => node.id === worker)!.sourceSlugs).toEqual(['research-mcp'])
    expect(connections).toBe(1)
    expect(pool.getTools('research-mcp').map(tool => tool.name)).toEqual(['read_record'])
    expect((await pool.callTool('mcp__research-mcp__read_record', { text: 'Verified research record' })).content).toBe('Verified research record')
    remoteError = true
    const failed = await pool.callTool('mcp__research-mcp__read_record', { text: 'Missing record' })
    expect(failed.isError).toBe(true)
    expect(failed.content).toContain('Research record unavailable')
    f.host.complete(resumed.state.tasks[0]!.sessionId!, 'Read verified record; the missing record remains an explicit source error')
    await until(() => f.service.get('alpha'), s => s.state.tasks[0]?.status === 'completed')
  } finally {
    await pool.disconnectAll()
    server.stop(true)
  }
}, 15_000)
