import { expect, test } from 'bun:test'
import { emptySuperAgentState } from './validation'
import type { SuperAgentTask } from './types'
import type { SuperAgentOperation } from './continuity'
import { superAgentTaskCompleted, superAgentTaskBlocker, superAgentResourceBlockers } from './scheduling'
import { superAgentWorkList } from './dynamic'

const task = (id: string, status: SuperAgentTask['status'] = 'completed'): SuperAgentTask => ({ id, title: id, instructions: 'Work and self-check', nodeId: id, status, createdAt: 1, completedAt: 2 })
const operation = (taskId: string): SuperAgentOperation => ({ id: `op-${taskId}`, taskId, nodeId: taskId, turnId: 'turn', sessionId: 'session', invocationId: 'call', key: 'a'.repeat(64), toolName: 'Edit', status: 'unknown', createdAt: 1, updatedAt: 1 })

test('self-checked work is marked complete without an extra acceptance turn, including work-list queries', () => {
  const state = emptySuperAgentState()
  state.tasks = [task('done'), task('pending', 'queued')]
  expect(superAgentTaskCompleted(state, state.tasks[0]!)).toBe(true)
  expect(superAgentWorkList(state).tasks.map(task => task.completed)).toEqual([true, false])
})

test('completion marks never cover waiting, unknown, rejected, stale or required unreviewed work', () => {
  const state = emptySuperAgentState(), done = task('done')
  for (const phase of ['waiting', 'outcome-unknown'] as const) expect(superAgentTaskCompleted(state, { ...done, phase })).toBe(false)
  for (const status of ['rejected', 'stale'] as const) expect(superAgentTaskCompleted(state, { ...done, acceptance: { status, evidenceTaskId: 'check', note: '', reviewedBy: 'lead', reviewedAt: 1 } })).toBe(false)
  expect(superAgentTaskCompleted(state, { ...done, requiresIndependentReview: true })).toBe(false)
  expect(superAgentTaskCompleted(state, { ...done, actionReceipt: { turnId: 'turn', status: 'partially_applied', applied: [], createdAt: 1 } })).toBe(false)
  state.tasks = [{ ...done, actionReceipt: { turnId: 'turn', status: 'partially_applied', applied: [], createdAt: 1 } }]
  expect(superAgentWorkList(state).tasks[0]!.completed).toBe(false)
  state.operations = [operation(done.id)]
  expect(superAgentTaskCompleted(state, done)).toBe(false)
  state.operations[0]!.status = 'reconciled'
  expect(superAgentTaskCompleted(state, done)).toBe(true)
})

test('goal and plan changes clear the completion projection while preserving the old task evidence', () => {
  const state = emptySuperAgentState(), done = { ...task('done'), goalId: 'goal', goalRevision: 1, planId: 'plan', planRevision: 1 }
  state.intents = [{ id: 'goal', revision: 1, status: 'active', goal: 'Goal', constraints: [], deliverables: [], acceptanceCriteria: [], sourceTurnId: 'request', createdAt: 1 }]
  state.plans = [{ id: 'plan', revision: 2, contractRevision: 1, title: 'Plan', instructions: '', status: 'active', priority: 1, note: '', updatedAt: 1, updatedBy: 'planner' }]
  expect(superAgentTaskCompleted(state, done)).toBe(true)
  state.plans[0]!.contractRevision = 2
  expect(superAgentTaskCompleted(state, done)).toBe(false)
  state.plans[0]!.contractRevision = 1; state.intents[0]!.revision = 2
  expect(superAgentTaskCompleted(state, done)).toBe(false)
  expect(done.status).toBe('completed')
})

test('a stopped desktop focus cannot hold a build lock; legacy and uncertain writes keep their locks', () => {
  const state = emptySuperAgentState(), previous = { ...task('old', 'failed'), resources: ['build', 'host-desktop'] }
  const build = { ...task('build', 'queued'), resources: ['build'] }, desktop = { ...task('desktop', 'queued'), resources: ['host-desktop'] }
  state.tasks = [previous, build, desktop]; state.operations = [operation(previous.id)]
  expect(superAgentTaskBlocker(state, build)?.code).toBe('resourceBusy')
  state.operations[0]!.resourceClaims = ['host-desktop']
  expect(superAgentTaskBlocker(state, build)).toBeUndefined()
  expect(superAgentResourceBlockers(state, desktop)[0]).toMatchObject({ taskId: 'old', operationIds: ['op-old'], resources: ['host-desktop'] })
  previous.status = 'running'
  expect(superAgentTaskBlocker(state, build)?.code).toBe('resourceBusy')
  previous.status = 'failed'; state.operations[0]!.resourceClaims = undefined
  expect(superAgentWorkList(state).tasks.find(task => task.id === 'build')!.blocker?.code).toBe('resourceBusy')
})
