import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { emptySuperAgentState, loadSuperAgentDocument, saveSuperAgentDocument, superAgentDependencySatisfied, superAgentTaskBlocker, type SuperAgentTask } from '@tokenbird/shared/super-agent'
import { markArtifactStale } from './SuperAgentContinuity'
import { superAgentFixture, until } from './SuperAgentTestSupport'

const source: SuperAgentTask = { id: 'source', title: 'Source', instructions: 'Build and self-check', nodeId: 'worker',
  status: 'completed', createdAt: 1, output: 'Self-check passed', acceptanceCriteria: ['Build passes'] }

test('criteria alone do not require acceptance, but explicit review and negative evidence still gate dependencies', () => {
  expect(superAgentDependencySatisfied(source)).toBe(true)
  expect(superAgentDependencySatisfied({ ...source, requiresIndependentReview: true })).toBe(false)
  const accepted = { status: 'accepted' as const, evidenceTaskId: 'review', note: 'Checked', reviewedBy: 'main', reviewedAt: 1 }
  expect(superAgentDependencySatisfied({ ...source, requiresIndependentReview: true, acceptance: accepted })).toBe(true)
  for (const status of ['rejected', 'stale'] as const) {
    expect(superAgentDependencySatisfied({ ...source, acceptance: { ...accepted, status } })).toBe(false)
  }
  expect(superAgentDependencySatisfied({ ...source, status: 'failed' })).toBe(false)
  expect(superAgentDependencySatisfied({ ...source, actionReceipt: { turnId: 'source-turn', status: 'partially_applied', applied: [], createdAt: 1 } })).toBe(false)
})

test('removing mandatory acceptance still blocks downstream tasks with unknown source operations', () => {
  const state = emptySuperAgentState(1)
  const dependent: SuperAgentTask = { ...source, id: 'integration', status: 'queued', dependsOn: [source.id] }
  state.tasks = [source, dependent]
  expect(superAgentTaskBlocker(state, dependent)).toBeUndefined()
  state.operations = [{ id: 'operation', key: 'a'.repeat(64), taskId: source.id, nodeId: source.nodeId, turnId: 'source-turn',
    sessionId: 'source-session', invocationId: 'write', toolName: 'Write', status: 'unknown', createdAt: 1, updatedAt: 1 }]
  expect(superAgentTaskBlocker(state, dependent)).toMatchObject({ code: 'dependencyWaiting', permanent: false })
  state.operations[0]!.status = 'completed'
  expect(superAgentTaskBlocker(state, dependent)).toBeUndefined()
})

test('artifact changes invalidate self-checked tasks even when no acceptance was ever recorded', async () => {
  const f = await superAgentFixture()
  const document = await loadSuperAgentDocument(join(f.root, 'alpha'))
  document.state.tasks = [{ ...source, artifactIds: ['artifact'] }, { ...source, id: 'consumer', dependsOn: [source.id] }]
  markArtifactStale(document, 'artifact')
  expect(document.state.tasks.map(task => task.acceptance?.status)).toEqual(['stale', 'stale'])
  expect(document.state.tasks.every(task => !superAgentDependencySatisfied(task))).toBe(true)
})

test('an idle queue waiting for an explicit review wakes the planner once instead of silently waiting for inspection', async () => {
  const f = await superAgentFixture()
  const document = await loadSuperAgentDocument(join(f.root, 'alpha'))
  document.config = f.config
  document.state.nodes = f.config.nodes.map(node => ({ nodeId: node.id, status: 'idle' }))
  document.state.tasks = [{ ...source, requiresIndependentReview: true },
    { ...source, id: 'integration', status: 'queued', dependsOn: [source.id] }]
  document.pendingTurns = [{ id: 'integration-turn', nodeId: 'worker', kind: 'task', taskId: 'integration', text: 'Integrate', createdAt: 1, depth: 0, chainId: 'integration-chain' }]
  await saveSuperAgentDocument(join(f.root, 'alpha'), document)
  await f.service.get('alpha')
  await f.service.tick()
  await until(() => f.service.get('alpha'), () => f.host.sends.length === 1)
  expect(f.host.sends[0]!.message).toContain('Queued dependency blockers')
  expect(f.host.sends[0]!.message).toContain('integration')
  f.host.complete(f.host.sends[0]!.sessionId, '')
  await until(() => f.service.get('alpha'), value => value.state.nodes.every(node => node.status === 'idle'))
  f.advance(5_000)
  await f.service.tick()
  expect(f.host.sends).toHaveLength(1)
  expect((await f.service.get('alpha')).state.tasks[1]!.status).toBe('queued')
})
