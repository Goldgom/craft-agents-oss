import { describe, expect, it } from 'bun:test'
import { loadSuperAgentDocument, saveSuperAgentDocument, withSuperAgentOrchestrator } from '@craft-agent/shared/super-agent'
import { join } from 'node:path'
import { superAgentFixture, until } from './SuperAgentTestSupport'
import { buildSuperAgentNodePrompt } from './SuperAgentPrompt'
import { SuperAgentService } from './SuperAgentService'

const block = (actions: unknown) => `<super_agent_actions>${JSON.stringify(actions)}</super_agent_actions>`
async function team() {
  const f = await superAgentFixture()
  f.config = withSuperAgentOrchestrator(f.config)
  f.config.nodes.push({ ...f.config.nodes.find(node => node.role === 'worker')!, id: 'verifier' })
  await f.service.save('alpha', f.config)
  return f
}
type Team = Awaited<ReturnType<typeof team>>
async function started(f: Team, nodeId: string) {
  const s = await until(() => f.service.get('alpha'), s => s.state.nodes.find(node => node.nodeId === nodeId)?.status === 'working'
    && f.host.sends.some(send => send.sessionId === s.state.nodes.find(node => node.nodeId === nodeId)?.sessionId))
  return s.state.nodes.find(node => node.nodeId === nodeId)!.sessionId!
}
async function finish(f: Team, nodeId: string, output: string) {
  const id = await started(f, nodeId)
  f.host.complete(id, output)
  return f.service.get('alpha')
}
async function plan(f: Team, actions: unknown) {
  f.advance(2_000)
  await f.service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'orchestrator', body: 'Arrange the authorized work.' })
  return finish(f, 'orchestrator', block(actions))
}
const task = (id: string, nodeId = 'worker', extra = {}) => ({ id, nodeId, title: id, instructions: `Execute ${id} and report actual evidence.`, ...extra })

describe('separated Super Agent architecture', () => {
  it('hands off intent, plans work and relays the result only through the intent node', async () => {
    const f = await team()
    await f.service.command('alpha', { type: 'chat', text: 'Prepare the report.' })
    const intent = { goal: 'Prepare the report.', constraints: ['Use supplied data'], deliverables: ['report.md'], acceptanceCriteria: ['Cite sources'] }
    await finish(f, 'main', block({ intent }))
    const plannerSession = await started(f, 'orchestrator')
    const handoff = f.host.sends.findLast(send => send.sessionId === plannerSession)!
    expect(JSON.parse(handoff.message).goal).toBe('Prepare the report.')
    expect(handoff.message).toBe(JSON.stringify(intent))
    expect(handoff.hidden).toBe(false)
    expect(handoff.context).toContain('orchestrationNodeId')
    await finish(f, 'orchestrator', block({ tasks: [task('report')] }))
    const workerSession = await started(f, 'worker')
    expect(f.host.sends.findLast(send => send.sessionId === workerSession)!.message).toBe('Execute report and report actual evidence.')
    expect(f.host.options.get(workerSession)!.agentSystemPrompt).toContain('编排节点')
    const shared = await f.service.getNodeSharedData('alpha', workerSession)
    expect(shared.coordination?.tasks.map(item => item.id)).toEqual(['report'])
    await finish(f, 'worker', 'Verified report.md, sources checked.')
    f.advance(2_000); await f.service.tick()
    await started(f, 'orchestrator')
    expect(f.host.sends.findLast(send => send.sessionId === plannerSession)!.hidden).toBe(true)
    await finish(f, 'orchestrator', block({ messages: [{ toNodeId: 'main', body: 'Verified report.md, sources checked.' }] }))
    f.advance(2_000); await f.service.tick()
    const mainSession = await started(f, 'main')
    expect(f.host.sends.findLast(send => send.sessionId === mainSession)!.hidden).toBe(true)
    const result = await finish(f, 'main', block({ userReply: 'Report ready: report.md.' }))
    expect(result.state.messages.filter(message => message.userFacing).map(message => message.body)).toEqual(['Report ready: report.md.'])
    expect(result.state.intents).toHaveLength(1)
  })

  it('rejects main-node planning and direct worker dispatch, including the messaging tool path', async () => {
    const f = await team()
    await f.service.command('alpha', { type: 'chat', text: 'Work.' })
    const result = await finish(f, 'main', block({ tasks: [task('bypass')] }))
    expect(result.state.tasks).toHaveLength(0)
    expect(result.state.messages.at(-1)!.body).toContain('intent node')
    await expect(f.service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'worker', body: 'Bypass planning' })).rejects.toThrow('only to the orchestrator')
  })

  it('rejects orchestrator user replies and worker planning', async () => {
    const f = await team()
    const result = await plan(f, { userReply: 'I am the user-facing agent.' })
    expect(result.state.messages.some(message => message.userFacing)).toBe(false)
    await f.service.command('alpha', { type: 'task', ...task('worker-control') })
    const ended = await finish(f, 'worker', block({ tasks: [task('unauthorized')] }))
    expect(ended.state.tasks.some(task => task.id === 'unauthorized')).toBe(false)
  })

  it('holds a downstream task until acceptance and permits independent review of the submitted version', async () => {
    const f = await team()
    await plan(f, { tasks: [task('build', 'worker', { acceptanceCriteria: ['Reproduced result'], requiresIndependentReview: true }),
      task('review', 'verifier', { dependsOn: ['build'], reviewOf: 'build' }),
      task('publish', 'worker', { dependsOn: ['build'] })] })
    expect((await f.service.get('alpha')).state.tasks.find(task => task.id === 'review')!.status).toBe('queued')
    await finish(f, 'worker', 'Artifact version abc, self-check passed.')
    await started(f, 'verifier')
    expect((await f.service.get('alpha')).state.tasks.find(task => task.id === 'publish')!.status).toBe('queued')
    await finish(f, 'verifier', 'Independently reproduced artifact version abc, all checks passed.')
    f.advance(2_000); await f.service.tick()
    await finish(f, 'orchestrator', block({ acceptances: [{ taskId: 'build', evidenceTaskId: 'review', status: 'accepted', note: 'Version abc independently reproduced.' }] }))
    await started(f, 'worker')
    expect((await f.service.get('alpha')).state.tasks.find(task => task.id === 'publish')!.status).toBe('running')
    const persisted = await loadSuperAgentDocument(join(f.root, 'alpha'))
    expect(persisted.state.tasks.find(task => task.id === 'build')!.acceptance?.evidenceTaskId).toBe('review')
  })

  it('does not accept self-checks where independent review is required', async () => {
    const f = await team()
    await plan(f, { tasks: [task('build', 'worker', { requiresIndependentReview: true })] })
    await finish(f, 'worker', 'Self-check passed.')
    f.advance(2_000); await f.service.tick()
    const result = await finish(f, 'orchestrator', block({ acceptances: [{ taskId: 'build', evidenceTaskId: 'build', status: 'accepted', note: 'Self-check' }] }))
    expect(result.state.tasks[0]!.acceptance).toBeUndefined()
    expect(result.state.messages.at(-1)!.body).toContain('Independent review')
  })

  it('serializes conflicting resource writers from preparation onward and runs independent work in parallel', async () => {
    const f = await team()
    await plan(f, { tasks: [task('first', 'worker', { resources: ['src'] }), task('second', 'verifier', { resources: ['SRC/file.ts'] })] })
    await started(f, 'worker')
    expect((await f.service.get('alpha')).state.tasks.find(task => task.id === 'second')!.status).toBe('queued')
    await finish(f, 'worker', 'First write complete.')
    await started(f, 'verifier')
    expect((await f.service.get('alpha')).state.tasks.find(task => task.id === 'second')!.status).toBe('running')
    await finish(f, 'verifier', 'Second write complete.')
    // Drain the existing result review before issuing another planning turn.
    f.advance(2_000); await f.service.tick(); await finish(f, 'orchestrator', block({}))
    f.advance(2_000); await f.service.tick();
    if ((await f.service.get('alpha')).state.nodes.find(node => node.nodeId === 'orchestrator')?.status === 'working') await finish(f, 'orchestrator', block({}))
    await plan(f, { tasks: [task('third', 'worker', { resources: ['a.txt'] }), task('fourth', 'verifier', { resources: ['b.txt'] })] })
    await started(f, 'worker'); await started(f, 'verifier')
  })

  it('rejects missing, cyclic or duplicate task identities without repeating work', async () => {
    const f = await team()
    await expect(f.service.command('alpha', { type: 'task', ...task('missing', 'worker', { dependsOn: ['unknown'] }) })).rejects.toThrow('earlier existing')
    await expect(f.service.command('alpha', { type: 'task', ...task('cycle', 'worker', { dependsOn: ['cycle'] }) })).rejects.toThrow('earlier existing')
    await f.service.command('alpha', { type: 'task', ...task('stable') })
    await expect(f.service.command('alpha', { type: 'task', ...task('stable') })).rejects.toThrow('already exists')
    expect((await f.service.get('alpha')).state.tasks).toHaveLength(1)
  })

  it('keeps dependent work queued after failure and never replays it on restart', async () => {
    const f = await team()
    await plan(f, { tasks: [task('fails'), task('dependent', 'verifier', { dependsOn: ['fails'] })] })
    f.host.complete(await started(f, 'worker'), 'Original error', 'error', { canRetry: false })
    const result = await f.service.get('alpha')
    expect(result.state.tasks.find(task => task.id === 'dependent')!.status).toBe('queued')
    const document = await loadSuperAgentDocument(join(f.root, 'alpha'))
    expect(document.pendingTurns.find(turn => turn.taskId === 'dependent')?.startedAt).toBeUndefined()
    await f.service.cleanup()
    // Restore the snapshot from before graceful shutdown to simulate a process crash.
    await saveSuperAgentDocument(join(f.root, 'alpha'), document)
    const sends = f.host.sends.length
    const restarted = new SuperAgentService({ host: f.host, rootForWorkspace: id => join(f.root, id), now: f.now, autoTick: false })
    try {
      expect((await restarted.get('alpha')).state.tasks.find(task => task.id === 'dependent')!.status).toBe('queued')
      await restarted.tick()
      expect(f.host.sends.length).toBe(sends)
    } finally { await restarted.cleanup() }
  })

  it('applies scenario concurrency and review policy at the host boundary', async () => {
    const f = await team()
    f.config.workflow = { pattern: 'incident', maxParallelTasks: 1, independentReview: true }
    await f.service.save('alpha', f.config)
    await plan(f, { tasks: [task('first', 'worker', { acceptanceCriteria: ['Recovery metric reached'], requiresIndependentReview: false }), task('second', 'verifier')] })
    await started(f, 'worker')
    const state = (await f.service.get('alpha')).state
    expect(state.tasks[0]!.requiresIndependentReview).toBe(true)
    expect(state.tasks[1]!.status).toBe('queued')
    await finish(f, 'worker', 'Remediation submitted.')
    await started(f, 'verifier')
  })

  it('requires evidence acceptance before closing a modern plan', async () => {
    const f = await team()
    await plan(f, { plans: [{ id: 'goal', title: 'Goal', instructions: 'Deliver artifact', status: 'planned', priority: 1, note: '', expectedRevision: 0 }], tasks: [task('artifact', 'worker', { planId: 'goal' })] })
    await finish(f, 'worker', 'Artifact and self-check evidence.')
    f.advance(2_000); await f.service.tick()
    const s = await f.service.get('alpha'), item = s.state.plans.find(plan => plan.id === 'goal')!
    const denied = await finish(f, 'orchestrator', block({ plans: [{ ...item, revision: undefined, updatedBy: undefined, updatedAt: undefined, status: 'completed', expectedRevision: item.revision }] }))
    expect(denied.state.plans.find(plan => plan.id === 'goal')!.status).toBe('active')
    f.advance(2_000)
    await f.service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'orchestrator', body: 'Review the evidence.' })
    const accepted = await finish(f, 'orchestrator', block({ acceptances: [{ taskId: 'artifact', evidenceTaskId: 'artifact', status: 'accepted', note: 'Self-check evidence meets low-risk acceptance.' }], plans: [{ id: 'goal', title: item.title, instructions: item.instructions, status: 'completed', priority: item.priority, note: 'Accepted evidence.', expectedRevision: item.revision }] }))
    expect(accepted.state.plans.find(plan => plan.id === 'goal')!.status).toBe('completed')
  })

  it('upgrades idle persisted teams without replacing nodes, sessions or source bindings', async () => {
    const f = await superAgentFixture({ upgradeArchitecture: true })
    const config = structuredClone(f.config)
    const document = { version: 1 as const, config, state: { ...(await f.service.get('alpha')).state, nodes: config.nodes.map(node => ({ nodeId: node.id, status: 'idle' as const })) }, pendingTurns: [], chainCounts: {} }
    await saveSuperAgentDocument(join(f.root, 'beta'), document)
    const migrated = await f.service.get('beta')
    expect(migrated.config!.nodes.map(node => node.id)).toEqual(['main', 'orchestrator', 'worker'])
    expect(migrated.config!.nodes.filter(node => node.id !== 'orchestrator')).toEqual(config.nodes)
    expect((await loadSuperAgentDocument(join(f.root, 'beta'))).config!.nodes).toHaveLength(3)
    await f.service.save('alpha', config)
    expect((await f.service.get('alpha')).config!.nodes.filter(node => node.role === 'orchestrator')).toHaveLength(1)
  })

  it('defers migration for a legacy queued turn and leaves its assignment intact', async () => {
    const f = await superAgentFixture({ upgradeArchitecture: true })
    const document = { version: 1 as const, config: f.config, state: { ...(await f.service.get('alpha')).state,
      nodes: f.config.nodes.map(node => ({ nodeId: node.id, status: 'idle' as const })) },
      pendingTurns: [{ id: 'saved_turn', nodeId: 'main', kind: 'chat' as const, text: 'Previously authorized request', createdAt: 1_000, retryAt: 500_000, depth: 0, chainId: 'saved_turn' }], chainCounts: { saved_turn: 1 } }
    await saveSuperAgentDocument(join(f.root, 'beta'), document)
    expect((await f.service.get('beta')).config!.nodes).toEqual(f.config.nodes)
    const saved = await loadSuperAgentDocument(join(f.root, 'beta'))
    expect(saved.pendingTurns[0]!.text).toBe('Previously authorized request')
    expect(saved.config!.nodes.some(node => node.role === 'orchestrator')).toBe(false)
  })

  it('gives modern roles unambiguous hidden instructions', async () => {
    const f = await team()
    const main = buildSuperAgentNodePrompt(f.config, f.config.nodes[0]!)
    const planner = buildSuperAgentNodePrompt(f.config, f.config.nodes[1]!)
    expect(main).toContain('不要拆解任务')
    expect(main).toContain('intent 必须包含')
    expect(planner).toContain('禁止 userReply')
    expect(planner).toContain('reviewOf')
    expect(planner).toContain('collaboration_board')
  })
})
