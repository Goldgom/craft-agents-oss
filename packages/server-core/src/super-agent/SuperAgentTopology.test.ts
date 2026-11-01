import { expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { canSuperAgentCommunicate, rebuildSuperAgentConfig, withSuperAgentPlanner, loadSuperAgentDocument, saveSuperAgentDocument } from '@tokenbird/shared/super-agent'
import { appendSuperAgentReport, readSuperAgentArea } from './SuperAgentDynamic'
import { superAgentFixture, until, legacyDynamicConfig } from './SuperAgentTestSupport'
import { SuperAgentService } from './SuperAgentService'

async function fixture() {
  const f = await superAgentFixture()
  const config = rebuildSuperAgentConfig(f.config)
  config.environment.fullControl = true
  config.maxConcurrentSubagents = 1
  await f.service.save('alpha', config)
  return { ...f, config }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function working(f: Fixture, role: string) {
  f.advance(2000); await f.service.tick()
  const state = await until(() => f.service.get('alpha'), value => value.state.nodes.some(runtime => runtime.status === 'working'
    && value.config?.nodes.find(node => node.id === runtime.nodeId)?.role === role && f.host.sends.some(send => send.sessionId === runtime.sessionId)))
  return state.state.nodes.find(runtime => runtime.status === 'working' && state.config?.nodes.find(node => node.id === runtime.nodeId)?.role === role)!.sessionId!
}
async function submit(f: Fixture, text = 'Implement the complete request') {
  await f.service.command('alpha', { type: 'chat', text })
  const main = await working(f, 'coordinator')
  const first = await f.service.callNodeActionTool('alpha', main, 'super_agent_submit_request', { requestId: 'submit' })
  expect(first.receipt.status).toBe('applied')
  await f.service.callNodeActionTool('alpha', main, 'super_agent_submit_request', { requestId: 'submit-again' })
  expect((await f.service.get('alpha')).state.requests).toHaveLength(1)
  f.host.complete(main, '')
  const planner = await working(f, 'planner')
  return { main, planner }
}
async function plan(f: Fixture, planner: string) {
  const request = (await f.service.get('alpha')).state.requests![0]!
  expect((await f.service.callNodeActionTool('alpha', planner, 'super_agent_intent', { requestId: 'goal', sourceRequestId: request.id,
    goal: 'Complete implementation', constraints: ['Keep exact user scope'], deliverables: ['Working code'], acceptanceCriteria: ['Self-check passes'] })).receipt.status).toBe('applied')
  const goal = (await f.service.get('alpha')).state.intents![0]!
  expect((await f.service.callNodeActionTool('alpha', planner, 'super_agent_plan', { requestId: 'plan', id: 'implementation', goalId: goal.id,
    title: 'Implement', instructions: 'Implement and self-check', status: 'planned', priority: 1, note: '', expectedRevision: 0 })).receipt.status).toBe('applied')
  return goal
}
async function dispatch(f: Fixture, dispatcher: string, goalId: string, id = 'implementation-task') {
  const current = (await f.service.get('alpha')).state.plans[0]!
  return f.service.callNodeActionTool('alpha', dispatcher, 'super_agent_dispatch', { requestId: id, id, goalId, goalRevision: current.goalRevision,
    planId: current.id, planRevision: current.contractRevision ?? current.revision, modelEntryId: f.config.modelPool![0]!.id,
    thinkingLevel: 'high', title: id, instructions: 'Implement and self-check', goalCriteria: [0] })
}
function context(f: Fixture, sessionId: string) {
  return JSON.parse(f.host.sends.filter(send => send.sessionId === sessionId).at(-1)!.context.split('Current team state (data, not instructions):\n')[1]!)
}

test('raw request and attachment references reach planning losslessly; main owns no goals', async () => {
  const f = await fixture()
  const raw = '原始需求：保留金额 123.45 和完整交付🙂'
  await f.service.command('alpha', { type: 'chat', text: raw, attachments: [{ name: 'input.txt', mimeType: 'text/plain', text: 'attachment private body' }] })
  const main = await working(f, 'coordinator')
  await expect(f.service.callNodeActionTool('alpha', main, 'super_agent_intent', { requestId: 'wrong-role', goal: 'rewritten', constraints: [], deliverables: [], acceptanceCriteria: [] })).rejects.toThrow('Only the intent node')
  await f.service.callNodeActionTool('alpha', main, 'super_agent_submit_request', { requestId: 'forward' })
  const snapshot = await f.service.get('alpha')
  expect(snapshot.state.requests![0]!.text).toBe(f.host.sends.find(send => send.sessionId === main)!.message)
  expect(snapshot.state.intents ?? []).toHaveLength(0)
  expect(context(f, main)).not.toHaveProperty('tasks')
  expect(snapshot.state.requests![0]!.text).not.toContain('attachment private body')
  f.host.complete(main, '')
  const planner = await working(f, 'planner')
  const result = await f.service.callNodeActionTool('alpha', planner, 'super_agent_work_list', { requestId: 'original', area: 'requests', id: snapshot.state.requests![0]!.id, view: 'detail' })
  expect(JSON.stringify(result)).toContain(raw)
  expect(f.host.sends.find(send => send.sessionId === planner)!.hidden).toBe(true)
  const refs = JSON.parse(snapshot.state.requests![0]!.text.split('subagent):\n')[1]!) as Array<{ path: string }>
  expect(await readFile(join(f.workingDirectory, refs[0]!.path), 'utf8')).toBe('attachment private body')
  await expect(f.service.callNodeActionTool('alpha', planner, 'super_agent_dispatch', { requestId: 'no-dispatch', title: 'Wrong', instructions: 'No' })).rejects.toThrow('Only the coordinator')
})

test('host routes execution progress to dispatch, stages to planning and only planning reports to main', async () => {
  const f = await fixture()
  const { main, planner } = await submit(f)
  await expect(f.service.callNodeActionTool('alpha', planner, 'super_agent_report', { requestId: 'no-progress-to-main', kind: 'progress', content: 'Routine acknowledgment' })).rejects.toThrow('ordinary execution progress')
  const goal = await plan(f, planner)
  f.host.complete(planner, '')
  const dispatcher = await working(f, 'orchestrator')
  await expect(f.service.callNodeActionTool('alpha', dispatcher, 'super_agent_report', { requestId: 'no-progress-to-planning', kind: 'progress', content: 'Routine acknowledgment' })).rejects.toThrow('ordinary execution progress')
  expect((await dispatch(f, dispatcher, goal.id)).receipt.status).toBe('applied')
  f.host.complete(dispatcher, '')
  const worker = await working(f, 'worker')
  let state = await f.service.get('alpha')
  const task = state.state.tasks[0]!
  expect(task.parentNodeId).toBe(state.config!.nodes.find(node => node.role === 'orchestrator')!.id)
  expect(state.config!.nodes.find(node => node.id === task.nodeId)!.parentNodeId).toBe(task.parentNodeId)
  await f.service.callNodeActionTool('alpha', worker, 'super_agent_report', { requestId: 'progress', kind: 'progress', content: 'Working with real evidence' })
  const handling = await working(f, 'orchestrator')
  expect(context(f, handling).reports[0].content).toBe('Working with real evidence')
  expect(f.host.sends.filter(send => send.sessionId === main)).toHaveLength(1)
  expect(f.host.sends.filter(send => send.sessionId === planner)).toHaveLength(1)
  const reports = await f.service.callNodeActionTool('alpha', handling, 'super_agent_reports', { requestId: 'read-progress' })
  expect(JSON.stringify(reports)).toContain('Working with real evidence')
  await expect(f.service.callNodeActionTool('alpha', handling, 'super_agent_message', { requestId: 'no-main', toNodeId: 'main', body: 'Forbidden even in full control' })).rejects.toThrow('topology')
  await expect(f.service.sendNodeMessage('alpha', worker, main, 'Forbidden session route')).rejects.toThrow()
  await expect(f.service.callNodeActionTool('alpha', worker, 'super_agent_message', { requestId: 'no-planner', toNodeId: 'planner', body: 'Forbidden' })).rejects.toThrow('topology')
  await f.service.callNodeActionTool('alpha', worker, 'super_agent_report', { requestId: 'final', kind: 'final', content: 'Implementation and self-check completed' })
  f.host.complete(worker, 'Turn completed without a final assistant response.', 'error', { errorCode: 'empty_response', canRetry: true })
  state = await until(() => f.service.get('alpha'), value => value.state.tasks[0]?.status === 'completed')
  const workerReport = state.state.reports!.find(report => report.kind === 'final')!
  expect((await f.service.callNodeActionTool('alpha', handling, 'super_agent_accept', { requestId: 'accept', taskId: task.id, evidenceTaskId: task.id, status: 'accepted', note: 'Actual self-check verified' })).receipt.status).toBe('applied')
  await f.service.callNodeActionTool('alpha', handling, 'super_agent_report', { requestId: 'stage', kind: 'stage', taskId: task.id, sourceReportIds: [workerReport.id], content: 'Accepted current task evidence' })
  f.host.complete(handling, 'Turn completed without a final assistant response.', 'error', { errorCode: 'empty_response', canRetry: true })
  const planning = await working(f, 'planner')
  const plannerContext = context(f, planning)
  expect(plannerContext.reports.map((report: { content: string }) => report.content)).toEqual(['Accepted current task evidence'])
  expect(JSON.stringify(plannerContext)).not.toContain('Working with real evidence')
  expect(f.host.sends.filter(send => send.sessionId === main)).toHaveLength(1)
  state = await f.service.get('alpha')
  const stage = state.state.reports!.find(report => report.nodeId === task.parentNodeId)!
  expect(stage.verification).toBe('verified')
  await f.service.callNodeActionTool('alpha', planning, 'super_agent_report', { requestId: 'main-stage', kind: 'stage', sourceReportIds: [stage.id], content: '阶段成果已核验' })
  f.host.complete(planning, 'Turn completed without a final assistant response.', 'error', { errorCode: 'empty_response', canRetry: true })
  f.advance(6000); await f.service.tick()
  const interaction = await working(f, 'coordinator')
  expect(context(f, interaction).reports.map((report: { content: string }) => report.content)).toEqual(['阶段成果已核验'])
  await f.service.callNodeActionTool('alpha', interaction, 'super_agent_deliver', { requestId: 'delivery', reply: '' })
  f.host.complete(interaction, 'Turn completed without a final assistant response.', 'error', { errorCode: 'empty_response', canRetry: true })
  const finished = await until(() => f.service.get('alpha'), value => !!value.state.reportCursors?.main)
  expect(finished.state.reportCursors!.main).toBe(finished.state.reports!.at(-1)!.sequence)
  expect(finished.state.reportCursors![task.parentNodeId!]).toBeLessThan(finished.state.reportCursors!.main!)
  expect(finished.state.messages.some(message => message.toNodeId === 'user' && (message.kind === 'error' || message.userFacing && message.body === '阶段成果已核验'))).toBe(false)
  expect(f.host.sends.filter(send => send.sessionId === interaction)).toHaveLength(2)
})

test('topology permits only adjacent roles and owned workers, independently of full control', async () => {
  const f = await fixture()
  const config = f.config
  const dispatcher = config.nodes.find(node => node.role === 'orchestrator')!
  const worker = { ...dispatcher, id: 'worker-a', role: 'worker' as const, parentNodeId: dispatcher.id, dynamic: true }
  const sibling = { ...worker, id: 'worker-b' }
  const foreign = { ...worker, id: 'foreign', parentNodeId: 'other-dispatcher' }
  const nodes = [...config.nodes, worker, sibling, foreign]
  const edges = new Set(['coordinator:planner', 'planner:coordinator', 'planner:orchestrator', 'orchestrator:planner', 'orchestrator:worker', 'worker:orchestrator'])
  for (const fullControl of [false, true]) for (const from of nodes) for (const to of nodes) {
    const expected = from.id !== to.id && edges.has(`${from.role}:${to.role}`) && !(from.id === 'foreign' || to.id === 'foreign')
    expect(canSuperAgentCommunicate({ ...config, environment: { ...config.environment, fullControl } }, from, to)).toBe(expected)
  }
  expect(withSuperAgentPlanner(config)).toEqual(config)
})

test('dispatch rejects stale plan revisions and planner cannot accept execution evidence', async () => {
  const f = await fixture()
  const { planner } = await submit(f)
  const goal = await plan(f, planner)
  await expect(f.service.callNodeActionTool('alpha', planner, 'super_agent_accept', { requestId: 'accept-no', taskId: 'missing', evidenceTaskId: 'missing', status: 'accepted', note: 'No' })).rejects.toThrow('Only the orchestrator')
  // A successful last call ends the repaired model turn normally.
  await f.service.callNodeActionTool('alpha', planner, 'super_agent_message', { requestId: 'handoff', toNodeId: 'orchestrator', body: 'Published plan implementation is ready' })
  f.host.complete(planner, '')
  const dispatcher = await working(f, 'orchestrator')
  await expect(f.service.callNodeActionTool('alpha', dispatcher, 'super_agent_dispatch', { requestId: 'stale', goalId: goal.id, goalRevision: 1,
    planId: 'implementation', planRevision: 99, modelEntryId: f.config.modelPool![0]!.id, thinkingLevel: 'high', title: 'Stale', instructions: 'No' })).rejects.toThrow('planRevision')
  expect((await f.service.get('alpha')).state.tasks).toHaveLength(0)
  await expect(f.service.callNodeActionTool('alpha', dispatcher, 'super_agent_plan', { requestId: 'plan-no', id: 'implementation', title: 'Rewrite', instructions: 'No', status: 'planned', priority: 1, note: '', expectedRevision: 1 })).rejects.toThrow('Only the coordinator')
  expect((await dispatch(f, dispatcher, goal.id)).receipt.status).toBe('applied')
})

test('independent report inboxes retain failed pinned batches and survive restart', async () => {
  const f = await fixture()
  const { main, planner } = await submit(f)
  await f.service.callNodeActionTool('alpha', planner, 'super_agent_report', { requestId: 'question', kind: 'question', content: 'Which delivery account?' })
  f.host.complete(planner, '')
  f.advance(6000); await f.service.tick()
  const handling = await working(f, 'coordinator')
  expect(handling).toBe(main)
  f.host.complete(handling, '', 'error', { canRetry: false })
  const failed = await until(() => f.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'error')
  expect(failed.state.reportCursors?.main ?? 0).toBe(0)
  await f.service.cleanup()
  const stored = await loadSuperAgentDocument(join(f.root, 'alpha'))
  expect(stored.failedTurns!.find(turn => turn.nodeId === 'main')!.reportThrough).toBe(1)
  const restarted = new SuperAgentService({ host: f.host, rootForWorkspace: id => join(f.root, id), autoTick: false, now: f.now })
  try {
    await restarted.get('alpha')
    await restarted.command('alpha', { type: 'node-refresh', nodeId: 'main' })
    f.advance(2000); await restarted.tick()
    await until(() => restarted.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    expect(context(f, main).reportBatch).toEqual({ afterSequence: 0, throughSequence: 1 })
    await restarted.callNodeActionTool('alpha', main, 'super_agent_deliver', { requestId: 'answer', reply: '请选择交付账户。' })
    f.host.complete(main, '')
    await until(() => restarted.get('alpha'), value => value.state.reportCursors?.main === 1)
  } finally { await restarted.cleanup() }
})

test('dynamic migration preserves active worker identity, checkpoints, unknown outcomes and unread reports', async () => {
  const f = await superAgentFixture()
  const old = legacyDynamicConfig(f.config)
  await f.service.save('alpha', old)
  await f.service.command('alpha', { type: 'task', id: 'retained', title: 'Retain', instructions: 'Work', modelEntryId: old.modelPool![0]!.id, thinkingLevel: 'low' })
  const active = await until(() => f.service.get('alpha'), value => value.state.tasks[0]?.status === 'running' && f.host.sends.some(send => send.sessionId === value.state.tasks[0]?.sessionId))
  const task = active.state.tasks[0]!
  await f.service.updateNodeTask('alpha', task.sessionId!, { action: 'checkpoint', taskId: task.id, expectedRevision: 0, completedSteps: ['Already done'], nextStep: 'Verify unknown write' })
  await f.service.prepareNodeOperation('alpha', task.sessionId!, { toolName: 'mcp__crm__update', input: { id: 'record' }, invocationId: 'original-call' })
  const cancel = f.host.cancelProcessing.bind(f.host)
  f.host.cancelProcessing = async () => {} // Simulate a service restart while the external host keeps execution alive.
  await f.service.cleanup()
  f.host.cancelProcessing = cancel
  const stored = await loadSuperAgentDocument(join(f.root, 'alpha'))
  const author = stored.config!.nodes.find(node => node.id === task.nodeId)!
  appendSuperAgentReport(stored, author, { id: 'old-report', taskId: task.id }, { kind: 'progress', content: 'Retained unread evidence' }, f.now())
  await saveSuperAgentDocument(join(f.root, 'alpha'), stored)
  const migrated = new SuperAgentService({ host: f.host, rootForWorkspace: id => join(f.root, id), autoTick: false, now: f.now, rebuildArchitecture: true })
  try {
    const result = await migrated.get('alpha')
    expect(result.config!.roleTopologyVersion).toBe(2)
    expect(result.config!.nodes.filter(node => node.role !== 'worker')).toHaveLength(3)
    expect(result.state.tasks[0]!.nodeId).toBe(task.nodeId)
    expect(result.state.tasks[0]!.sessionId).toBe(task.sessionId)
    expect(result.state.nodes.find(node => node.nodeId === task.nodeId)!.sessionId).toBe(task.sessionId)
    expect(result.state.nodes.find(node => node.nodeId === task.nodeId)!.status).toBe('working')
    expect(result.state.tasks[0]!.checkpoint?.completedSteps).toEqual(['Already done'])
    expect(result.state.operations![0]!.invocationId).toBe('original-call')
    expect(['running', 'prepared', 'unknown']).toContain(result.state.operations![0]!.status)
    expect(result.state.reports![0]!.recipientNodeId).toBe(old.nodes.find(node => node.role === 'orchestrator')!.id)
    const planner = result.config!.nodes.find(node => node.role === 'planner')!
    const doc = await loadSuperAgentDocument(join(f.root, 'alpha'))
    expect(JSON.stringify(readSuperAgentArea(doc, planner, 'reports'))).not.toContain('Retained unread evidence')
    await migrated.get('alpha')
    expect((await readdir(join(f.root, 'alpha', 'super-agent', 'history'))).filter(name => name.startsWith('topology-v1-'))).toHaveLength(1)
  } finally { await migrated.cleanup() }
})


test('replanning retires only stale queued work, preserves active unknown effects and never replays them', async () => {
  const f = await fixture()
  const { planner } = await submit(f)
  const goal = await plan(f, planner)
  f.host.complete(planner, '')
  const dispatcher = await working(f, 'orchestrator')
  await dispatch(f, dispatcher, goal.id, 'active')
  await dispatch(f, dispatcher, goal.id, 'queued')
  f.host.complete(dispatcher, '')
  const worker = await working(f, 'worker')
  await f.service.updateNodeTask('alpha', worker, { action: 'checkpoint', taskId: 'active', expectedRevision: 0, completedSteps: ['Original write prepared'], nextStep: 'Verify external receipt' })
  await f.service.prepareNodeOperation('alpha', worker, { toolName: 'mcp__crm__update', input: { id: 'record' }, invocationId: 'original-write' })
  await f.service.command('alpha', { type: 'chat', text: 'Change the deliverable but preserve already executed work' })
  const main = await working(f, 'coordinator')
  await f.service.callNodeActionTool('alpha', main, 'super_agent_submit_request', { requestId: 'change' })
  f.host.complete(main, '')
  const replanning = await working(f, 'planner')
  let state = await f.service.get('alpha')
  await f.service.callNodeActionTool('alpha', replanning, 'super_agent_intent', { requestId: 'revise', id: goal.id, expectedRevision: 1,
    sourceRequestId: state.state.requests!.at(-1)!.id, goal: 'Updated outcome', constraints: ['Preserve existing effects'], deliverables: ['Updated artifact'], acceptanceCriteria: ['Current contract works'] })
  state = await f.service.get('alpha')
  const current = state.state.plans[0]!
  await f.service.callNodeActionTool('alpha', replanning, 'super_agent_plan', { requestId: 'refresh-plan', id: current.id, goalId: goal.id,
    title: 'Updated plan', instructions: 'Verify existing effects, then implement remaining changes', status: 'active', priority: 1, note: '', expectedRevision: current.revision })
  f.host.complete(replanning, '')
  state = await f.service.get('alpha')
  expect(state.state.tasks.find(task => task.id === 'active')!.status).toBe('running')
  expect(state.state.tasks.find(task => task.id === 'queued')!.status).toBe('failed')
  expect(state.state.tasks.find(task => task.id === 'active')!.checkpoint?.completedSteps).toEqual(['Original write prepared'])
  expect(state.state.operations).toHaveLength(1)
  await f.service.callNodeActionTool('alpha', worker, 'super_agent_report', { requestId: 'old-result', kind: 'final', content: 'Old contract output retained for verification' })
  f.host.complete(worker, 'Old contract output retained for verification')
  state = await until(() => f.service.get('alpha'), value => value.state.operations![0]!.status === 'unknown')
  expect(state.state.reports!.find(report => report.nodeId === state.state.tasks[0]!.nodeId)!.verification).toBe('stale')
  f.advance(10_000); await f.service.tick()
  state = await f.service.get('alpha')
  expect(state.state.tasks).toHaveLength(2)
  expect(state.state.operations).toHaveLength(1)
  expect(f.host.sends.filter(send => send.sessionId === worker)).toHaveLength(1)
})

test('automatic migration waits for a live management turn and rotates its mixed-duty session afterwards', async () => {
  const f = await superAgentFixture()
  const old = legacyDynamicConfig(f.config)
  await f.service.save('alpha', old)
  await f.service.command('alpha', { type: 'chat', text: 'Keep this exact pending request' })
  const active = await until(() => f.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working' && f.host.sends.length === 1)
  const main = active.state.nodes.find(node => node.nodeId === 'main')!.sessionId!
  const cancel = f.host.cancelProcessing.bind(f.host)
  f.host.cancelProcessing = async () => {} // The host owns an ongoing management turn across this service replacement.
  await f.service.cleanup()
  f.host.cancelProcessing = cancel
  const upgraded = new SuperAgentService({ host: f.host, rootForWorkspace: id => join(f.root, id), autoTick: false, now: f.now, rebuildArchitecture: true })
  try {
    const waiting = await upgraded.get('alpha')
    expect(waiting.config!.roleTopologyVersion).toBeUndefined()
    expect(waiting.state.nodes.find(node => node.nodeId === 'main')!.sessionId).toBe(main)
    f.host.complete(main, 'Original turn completed')
    const migrated = await until(() => upgraded.get('alpha'), value => value.config!.roleTopologyVersion === 2)
    expect(migrated.state.nodes.find(node => node.nodeId === 'main')!.sessionId).toBeUndefined()
    expect(migrated.state.messages.some(message => message.body === 'Keep this exact pending request')).toBe(true)
    expect((await readdir(join(f.root, 'alpha', 'super-agent', 'history'))).filter(name => name.startsWith('topology-v1-'))).toHaveLength(1)
  } finally { await upgraded.cleanup() }
})


test('raw requests can be archived without removing a failed planner handoff', async () => {
  const f = await fixture()
  await f.service.cleanup()
  const stored = await loadSuperAgentDocument(join(f.root, 'alpha'))
  stored.recoverySuspended = true
  stored.state.requests = [{ id: 'retire', text: 'Original completed request', sourceTurnId: 'original', createdAt: 1 },
    { id: 'keep', text: 'Pending planner request', sourceTurnId: 'pending', createdAt: 1 }]
  stored.failedTurns = [{ id: 'failed', nodeId: 'planner', kind: 'message', text: 'Process raw request keep', createdAt: 1, depth: 0, chainId: 'failed' }]
  await saveSuperAgentDocument(join(f.root, 'alpha'), stored)
  const restarted = new SuperAgentService({ host: f.host, rootForWorkspace: id => join(f.root, id), autoTick: false, now: f.now })
  try {
    const before = await restarted.get('alpha')
    const cleaned = await restarted.command('alpha', { type: 'history-cleanup', expectedRevision: before.state.revision, before: f.now(), keepRecentMessages: 0 })
    expect(cleaned.state.requests!.map(request => request.id)).toEqual(['keep'])
    const archive = JSON.parse(await readFile(cleaned.historyCleanup!.archivePath!, 'utf8'))
    expect(archive.requests).toEqual([stored.state.requests[0]])
  } finally { await restarted.cleanup() }
})


test('a worker follow-up message result reaches only its dispatch inbox without re-completing the task', async () => {
  const f = await fixture()
  const { planner } = await submit(f)
  const goal = await plan(f, planner)
  f.host.complete(planner, '')
  const dispatcher = await working(f, 'orchestrator')
  await dispatch(f, dispatcher, goal.id)
  f.host.complete(dispatcher, '')
  const worker = await working(f, 'worker')
  f.host.complete(worker, 'Initial task completed')
  let state = await until(() => f.service.get('alpha'), value => value.state.tasks[0]?.status === 'completed')
  const review = await working(f, 'orchestrator')
  await f.service.callNodeActionTool('alpha', review, 'super_agent_message', { requestId: 'follow-up', toNodeId: state.state.tasks[0]!.nodeId, body: 'Clarify the evidence without replaying the original work' })
  f.host.complete(review, '')
  await working(f, 'worker')
  f.host.complete(worker, 'Follow-up evidence is now available')
  state = await until(() => f.service.get('alpha'), value => value.state.reports?.some(report => report.content === 'Follow-up evidence is now available') === true)
  const reply = state.state.reports!.find(report => report.content === 'Follow-up evidence is now available')!
  expect(reply.taskId).toBeUndefined()
  expect(reply.recipientNodeId).toBe(state.state.tasks[0]!.parentNodeId)
  expect(state.state.tasks).toHaveLength(1)
  expect(state.state.metrics!.completedTasks).toBe(1)
  const recipient = await working(f, 'orchestrator')
  expect(JSON.stringify(context(f, recipient))).toContain('Follow-up evidence is now available')
  expect(f.host.sends.filter(send => send.sessionId === planner)).toHaveLength(1)
})

test('manual recovery after raw handoff preserves original request identity', async () => {
  const f = await fixture()
  await f.service.command('alpha', { type: 'chat', text: 'Preserve this original request through recovery' })
  const main = await working(f, 'coordinator')
  await f.service.callNodeActionTool('alpha', main, 'super_agent_submit_request', { requestId: 'before-error' })
  const original = (await f.service.get('alpha')).state.requests![0]!
  f.host.complete(main, 'Provider failed after the handoff committed', 'error', { canRetry: false })
  await until(() => f.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'error')
  await f.service.command('alpha', { type: 'node-refresh', nodeId: 'main' })
  const recovered = await working(f, 'coordinator')
  await f.service.callNodeActionTool('alpha', recovered, 'super_agent_submit_request', { requestId: 'after-error' })
  const state = await f.service.get('alpha')
  expect(state.state.requests).toEqual([original])
})
