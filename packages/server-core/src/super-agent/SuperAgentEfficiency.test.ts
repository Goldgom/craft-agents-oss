import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { loadSuperAgentDocument, saveSuperAgentDocument, rebuildSuperAgentConfig, type SuperAgentDocument } from '@tokenbird/shared/super-agent'
import { EMPTY_RESPONSE_ERROR_CODE } from '../sessions/session-turn-completion'
import { operationResourceClaims } from './SuperAgentContinuity'
import { appendSuperAgentReport } from './SuperAgentDynamic'
import { SuperAgentService } from './SuperAgentService'
import { legacyDynamicConfig, superAgentFixture, until } from './SuperAgentTestSupport'

type Fixture = Awaited<ReturnType<typeof superAgentFixture>>
const document = (f: Fixture) => (f.service as unknown as { documents: Map<string, SuperAgentDocument> }).documents.get('alpha')!
const empty = (f: Fixture, sessionId: string) => f.host.complete(sessionId, 'No final assistant response.', 'error', { errorCode: EMPTY_RESPONSE_ERROR_CODE, canRetry: true })
async function active(f: Fixture, role: string) {
  return until(() => f.service.get('alpha'), s => s.state.nodes.some(n => n.status === 'working' && s.config?.nodes.find(c => c.id === n.nodeId)?.role === role && f.host.sends.some(send => send.sessionId === n.sessionId)))
}
function session(snapshot: Awaited<ReturnType<typeof active>>, role: string) {
  return snapshot.state.nodes.find(n => n.status === 'working' && snapshot.config?.nodes.find(c => c.id === n.nodeId)?.role === role)!.sessionId!
}

test('only audited desktop navigation narrows operation resource claims', () => {
  expect(operationResourceClaims('mcp__session__computer_use', { action: 'focus', windowId: '12' })).toEqual(['host-desktop'])
  for (const action of ['key', 'click', 'type', 'drag']) expect(operationResourceClaims('mcp__session__computer_use', { action })).toBeUndefined()
  expect(operationResourceClaims('mcp__external__computer_use', { action: 'focus' })).toBeUndefined()
  expect(operationResourceClaims('Bash', { command: 'something' })).toBeUndefined()
})

test('health explains the actual resource lock and operation, rather than just an idle worker', async () => {
  const f = await superAgentFixture()
  await f.service.save('alpha', f.config)
  const doc = document(f)
  doc.state.tasks.push({ id: 'old', title: 'Old build owner', instructions: '', nodeId: 'worker', status: 'failed', resources: ['build'], createdAt: 1 },
    { id: 'next', title: 'New build', instructions: '', nodeId: 'worker', status: 'queued', resources: ['build'], createdAt: 1 })
  doc.state.operations = [{ id: 'unknown', key: 'a'.repeat(64), taskId: 'old', nodeId: 'worker', turnId: 'old-turn', sessionId: 'old-session', invocationId: 'call', toolName: 'Edit', status: 'unknown', createdAt: 1, updatedAt: 1 }]
  doc.pendingTurns.push({ id: 'next-turn', nodeId: 'worker', taskId: 'next', kind: 'task', text: 'Build', createdAt: 1, depth: 0, chainId: 'next-turn' })
  await f.service.command('alpha', { type: 'chat', text: 'Check the queued build' })
  const main = session(await active(f, 'coordinator'), 'coordinator')
  const result = await f.service.callNodeActionTool('alpha', main, 'super_agent_health', { requestId: 'why', action: 'get', nodeId: 'worker' })
  expect(result).toMatchObject({ data: { nodes: [{ status: 'idle', queueBlockers: [{ taskId: 'next', blocker: { code: 'resourceBusy' }, resourceBlockers: [{ taskId: 'old', operationIds: ['unknown'] }] }] }] } })
})

test('historical focus scope is recovered from the original host receipt without clearing unknown effects', async () => {
  const f = await superAgentFixture(), doc = await loadSuperAgentDocument(join(f.root, 'alpha'))
  doc.config = f.config; doc.state.nodes = f.config.nodes.map(node => ({ nodeId: node.id, status: 'idle' }))
  doc.state.tasks = [{ id: 'old', title: 'Old owner', instructions: '', nodeId: 'worker', status: 'failed', resources: ['build'], createdAt: 1 }]
  const result = 'Window no longer exists'
  f.host.sessions.set('old-session', { id: 'old-session', workspaceId: 'alpha', isProcessing: false, messages: [{ id: 'receipt', role: 'tool', content: result, timestamp: 1, toolName: 'mcp__session__computer_use', toolUseId: 'focus', toolInput: { action: 'focus', windowId: '12' }, toolResult: result, toolStatus: 'error', isError: true }] })
  doc.state.operations = [{ id: 'unknown', key: 'a'.repeat(64), taskId: 'old', nodeId: 'worker', turnId: 'old-turn', sessionId: 'old-session', invocationId: 'focus', toolName: 'mcp__session__computer_use', status: 'unknown', resultHash: createHash('sha256').update(`mcp__session__computer_use\n${result}`).digest('hex'), createdAt: 1, updatedAt: 1 }]
  await saveSuperAgentDocument(join(f.root, 'alpha'), doc)
  const state = await f.service.get('alpha')
  expect(state.state.operations![0]).toMatchObject({ status: 'unknown', resourceClaims: ['host-desktop'] })
  await f.service.command('alpha', { type: 'task', id: 'build', title: 'Build', instructions: 'Compile the current source', nodeId: 'worker', resources: ['build'] })
  await until(() => f.service.get('alpha'), s => s.state.tasks.find(t => t.id === 'build')?.status === 'running')
  expect((await loadSuperAgentDocument(join(f.root, 'alpha'))).state.operations![0]!.resourceClaims).toEqual(['host-desktop'])
})

test('an internal no-op receipt closes an empty management turn without completing tasks or waking main', async () => {
  const f = await superAgentFixture(), config = legacyDynamicConfig(f.config)
  config.continuousWork = true
  await f.service.save('alpha', config)
  f.advance(60_001); await f.service.tick()
  const manager = session(await active(f, 'orchestrator'), 'orchestrator')
  await f.service.callNodeActionTool('alpha', manager, 'super_agent_finish_turn', { requestId: 'idle', note: 'No new evidence or safe next step.' })
  empty(f, manager)
  await until(() => f.service.get('alpha'), s => s.state.nodes.find(n => n.sessionId === manager)?.status === 'idle')
  const saved = await loadSuperAgentDocument(join(f.root, 'alpha'))
  expect(saved.failedTurns).toEqual([])
  expect(saved.state.tasks).toEqual([])
  expect(saved.state.reports ?? []).toEqual([])
  expect(saved.state.lastInspectionProgressKey).toBeString()
  f.advance(3_600_000); await f.service.tick()
  expect(f.host.sends).toHaveLength(1)
  await f.service.command('alpha', { type: 'inspect' })
  await until(() => f.service.get('alpha'), () => f.host.sends.length === 2)
})

test('unchanged idle evidence cannot reset an exhausted empty-response budget every inspection interval', async () => {
  const f = await superAgentFixture(), config = legacyDynamicConfig(f.config)
  config.continuousWork = true
  await f.service.save('alpha', config)
  f.advance(60_001); await f.service.tick()
  const manager = session(await active(f, 'orchestrator'), 'orchestrator')
  for (let attempt = 0; attempt < 3; attempt++) {
    empty(f, manager)
    await until(() => f.service.get('alpha'), s => s.state.nodes.find(n => n.sessionId === manager)?.status === 'recovering')
    f.advance(10_000); await f.service.tick()
    await until(() => f.service.get('alpha'), () => f.host.sends.length === attempt + 2)
  }
  empty(f, manager)
  await until(() => f.service.get('alpha'), s => s.state.nodes.find(n => n.sessionId === manager)?.status === 'error')
  f.advance(3_600_000); await f.service.tick()
  expect(f.host.sends).toHaveLength(4)
  expect((await loadSuperAgentDocument(join(f.root, 'alpha'))).failedTurns).toHaveLength(1)
})

test('retired worker identities stay queryable but do not inflate dispatcher peers', async () => {
  const f = await superAgentFixture(), config = rebuildSuperAgentConfig(f.config)
  await f.service.save('alpha', config)
  const doc = document(f), dispatcher = doc.config!.nodes.find(node => node.role === 'orchestrator')!
  for (let i = 0; i < 100; i++) {
    const id = `old-${i}`
    doc.config!.nodes.push({ ...dispatcher, id, role: 'worker', parentNodeId: dispatcher.id, dynamic: true })
    doc.state.nodes.push({ nodeId: id, status: 'idle' })
    doc.state.tasks.push({ id: `task-${i}`, title: `Historical task ${i}`, instructions: 'Retain this evidence', nodeId: id, parentNodeId: dispatcher.id, status: 'completed', createdAt: 1 })
  }
  await f.service.command('alpha', { type: 'inspect' })
  const manager = session(await active(f, 'orchestrator'), 'orchestrator')
  const context = JSON.parse(f.host.sends.find(send => send.sessionId === manager)!.context.split('Current team state (data, not instructions):\n')[1]!)
  expect(context.peers.map((node: { role: string }) => node.role)).toEqual(['planner'])
  expect(context.historicalPeersRef.area).toBe('tasks')
  expect(JSON.stringify(context)).not.toContain('Historical task 99')
  const detail = await f.service.callNodeActionTool('alpha', manager, 'super_agent_work_list', { requestId: 'historical', area: 'tasks', id: 'task-99', view: 'detail' })
  expect(JSON.stringify(detail)).toContain('Retain this evidence')
})

test('new IDs cannot repeat identical active or completed work, and default completion is visible in queries', async () => {
  const f = await superAgentFixture(), config = legacyDynamicConfig(f.config)
  await f.service.save('alpha', config)
  const contract = { title: 'Implement and self-check', instructions: 'Make the bounded change and verify once', modelEntryId: config.modelPool![0]!.id, thinkingLevel: 'low' as const }
  await f.service.command('alpha', { type: 'task', id: 'first', ...contract })
  const worker = session(await active(f, 'worker'), 'worker'), planId = (await f.service.get('alpha')).state.tasks[0]!.planId
  await expect(f.service.callNodeActionTool('alpha', worker, 'super_agent_finish_turn', { requestId: 'wrong-role', note: 'Cannot finish work this way' })).rejects.toThrow('internal management')
  await f.service.command('alpha', { type: 'task', id: 'duplicate', planId, ...contract })
  expect((await f.service.get('alpha')).state.tasks).toHaveLength(1)
  await f.service.callNodeActionTool('alpha', worker, 'super_agent_report', { requestId: 'final', kind: 'final', content: 'Implemented and self-checked the assigned result.' })
  empty(f, worker)
  await until(() => f.service.get('alpha'), s => s.state.tasks[0]?.status === 'completed')
  await f.service.command('alpha', { type: 'task', id: 'duplicate-completed', planId, ...contract })
  const snapshot = await f.service.get('alpha')
  expect(snapshot.state.tasks).toHaveLength(1)
  expect(snapshot.state.tasks[0]!.acceptance).toBeUndefined()
  const manager = session(await active(f, 'orchestrator'), 'orchestrator')
  const list = await f.service.callNodeActionTool('alpha', manager, 'super_agent_work_list', { requestId: 'done', area: 'tasks', id: 'first', view: 'detail' })
  expect(list).toMatchObject({ data: { tasks: { items: [{ completed: true, status: 'completed' }] } } })
})

test('unchanged goals preserve their revision, delivered status and existing evidence', async () => {
  const f = await superAgentFixture()
  await f.service.save('alpha', legacyDynamicConfig(f.config))
  const doc = document(f)
  const content = { goal: 'Produce the result', constraints: [], deliverables: ['result'], acceptanceCriteria: ['checked'] }
  doc.state.intents = [{ ...content, id: 'goal', revision: 2, status: 'delivered', sourceTurnId: 'original', createdAt: 1 }]
  doc.state.plans.push({ id: 'plan', revision: 3, goalId: 'goal', goalRevision: 2, title: 'Plan', instructions: 'Work', status: 'completed', priority: 1, note: '', updatedAt: 1, updatedBy: 'main' })
  doc.state.tasks.push({ id: 'done', title: 'Done', instructions: 'Work', nodeId: 'old-worker', goalId: 'goal', goalRevision: 2, planId: 'plan', status: 'completed', createdAt: 1,
    acceptance: { status: 'accepted', evidenceTaskId: 'check', note: 'Verified', reviewedBy: 'dispatch', reviewedAt: 1 } })
  await f.service.command('alpha', { type: 'chat', text: 'Inspect the current requirement' })
  const main = session(await active(f, 'coordinator'), 'coordinator')
  await f.service.callNodeActionTool('alpha', main, 'super_agent_intent', { requestId: 'same', id: 'goal', expectedRevision: 2, ...content })
  const state = (await f.service.get('alpha')).state
  expect(state.intents![0]).toMatchObject({ revision: 2, status: 'delivered', sourceTurnId: 'original' })
  expect(state.plans[0]).toMatchObject({ revision: 3, status: 'completed' })
  expect(state.tasks[0]!.acceptance!.status).toBe('accepted')
})

test('identical management reports reuse evidence and close the current attempt without another notification', async () => {
  const f = await superAgentFixture(), config = rebuildSuperAgentConfig(f.config)
  await f.service.save('alpha', config)
  const doc = document(f), dispatcher = doc.config!.nodes.find(node => node.role === 'orchestrator')!
  const report = appendSuperAgentReport(doc, dispatcher, { id: 'previous', kind: 'inspection' }, { kind: 'stage', content: 'No new evidence; waiting for the external service.' }, 1)
  doc.state.reportCursors = { [report.recipientNodeId!]: report.sequence }
  await f.service.command('alpha', { type: 'inspect' })
  const manager = session(await active(f, 'orchestrator'), 'orchestrator')
  const result = await f.service.callNodeActionTool('alpha', manager, 'super_agent_report', { requestId: 'same-report', kind: 'stage', content: report.content })
  expect(result.receipt.applied[0]!.targetId).toBe(report.id)
  empty(f, manager)
  await until(() => f.service.get('alpha'), s => s.state.nodes.find(node => node.sessionId === manager)?.status === 'idle')
  expect(doc.state.reports).toHaveLength(1)
  expect(doc.state.reportSequence).toBe(1)
  expect(doc.failedTurns).toEqual([])
  expect(f.host.sends).toHaveLength(1)
})

test('silent management completion consumes its pinned inbox without forwarding an unchanged report', async () => {
  const f = await superAgentFixture(), config = rebuildSuperAgentConfig(f.config)
  await f.service.save('alpha', config)
  const doc = document(f), dispatcher = doc.config!.nodes.find(node => node.role === 'orchestrator')!
  const report = appendSuperAgentReport(doc, dispatcher, { id: 'previous', kind: 'inspection' }, { kind: 'stage', content: 'Already known blocker.' }, 1)
  await f.service.tick()
  const planner = session(await active(f, 'planner'), 'planner')
  await f.service.callNodeActionTool('alpha', planner, 'super_agent_finish_turn', { requestId: 'consume', note: 'No new work or useful user update.' })
  empty(f, planner)
  await until(() => f.service.get('alpha'), s => s.state.nodes.find(node => node.sessionId === planner)?.status === 'idle')
  expect(doc.state.reportCursors![report.recipientNodeId!]).toBe(report.sequence)
  expect(doc.state.reports).toHaveLength(1)
  expect(f.host.sends).toHaveLength(1)
})

test('a finish receipt cannot suppress a real backend error or reconcile unknown operations', async () => {
  const f = await superAgentFixture()
  await f.service.save('alpha', legacyDynamicConfig(f.config))
  await f.service.command('alpha', { type: 'inspect' })
  const manager = session(await active(f, 'orchestrator'), 'orchestrator'), doc = document(f)
  const turn = doc.pendingTurns.find(turn => turn.startedAt != null && turn.nodeId === doc.config!.nodes.find(node => node.role === 'orchestrator')!.id)!
  doc.state.operations = [{ id: 'unknown', key: 'a'.repeat(64), nodeId: turn.nodeId, turnId: turn.id, sessionId: manager, invocationId: 'unknown', toolName: 'Edit', status: 'unknown', createdAt: 1, updatedAt: 1 }]
  await expect(f.service.callNodeActionTool('alpha', manager, 'super_agent_finish_turn', { requestId: 'unsafe', note: 'Cannot settle this.' })).rejects.toThrow('unsettled operations')
  expect(doc.state.operations[0]!.status).toBe('unknown')
  doc.state.operations[0]!.status = 'reconciled'
  await f.service.callNodeActionTool('alpha', manager, 'super_agent_finish_turn', { requestId: 'finish', note: 'No further work.' })
  f.host.complete(manager, 'Authentication failed', 'error', { errorCode: 'authentication_error', canRetry: false })
  await until(() => f.service.get('alpha'), s => s.state.nodes.find(node => node.sessionId === manager)?.status === 'error')
  expect(doc.failedTurns).toHaveLength(1)
})

test('unchanged idle inspection suppression survives service restart and new input still runs', async () => {
  const f = await superAgentFixture(), config = legacyDynamicConfig(f.config)
  config.continuousWork = true
  await f.service.save('alpha', config)
  f.advance(60_001); await f.service.tick()
  const manager = session(await active(f, 'orchestrator'), 'orchestrator')
  await f.service.callNodeActionTool('alpha', manager, 'super_agent_finish_turn', { requestId: 'idle', note: 'No new evidence.' })
  empty(f, manager)
  await until(() => f.service.get('alpha'), s => s.state.nodes.find(node => node.sessionId === manager)?.status === 'idle')
  await f.service.cleanup()
  const restarted = new SuperAgentService({ host: f.host, rootForWorkspace: id => join(f.root, id), now: f.now, autoTick: false })
  try {
    await restarted.get('alpha')
    f.advance(3_600_000); await restarted.tick()
    expect(f.host.sends).toHaveLength(1)
    await restarted.command('alpha', { type: 'chat', text: 'New input after restart' })
    await until(() => restarted.get('alpha'), () => f.host.sends.length === 2)
  } finally { await restarted.cleanup() }
})

test('unreadable historical desktop evidence retains its conservative resource lock', async () => {
  const f = await superAgentFixture(), doc = await loadSuperAgentDocument(join(f.root, 'alpha'))
  doc.config = f.config
  doc.state.nodes = f.config.nodes.map(node => ({ nodeId: node.id, status: 'idle' }))
  doc.state.tasks = [{ id: 'old', title: 'Old owner', instructions: '', nodeId: 'worker', status: 'failed', resources: ['build'], createdAt: 1 }]
  doc.state.operations = [{ id: 'unknown', key: 'a'.repeat(64), taskId: 'old', nodeId: 'worker', turnId: 'old-turn', sessionId: 'missing', invocationId: 'focus', toolName: 'mcp__session__computer_use', status: 'unknown', createdAt: 1, updatedAt: 1 }]
  await saveSuperAgentDocument(join(f.root, 'alpha'), doc)
  const getSession = f.host.getSession.bind(f.host)
  f.host.getSession = async id => { if (id === 'missing') throw new Error('Historical session unreadable'); return getSession(id) }
  const operation = (await f.service.get('alpha')).state.operations![0]!
  expect(operation.status).toBe('unknown')
  expect(operation.resourceClaims).toBeUndefined()
  await f.service.command('alpha', { type: 'task', id: 'build', title: 'Build', instructions: 'Compile', nodeId: 'worker', resources: ['build'] })
  await f.service.tick()
  expect((await f.service.get('alpha')).state.tasks.find(task => task.id === 'build')!.status).toBe('queued')
  expect(f.host.sends).toHaveLength(0)
})
