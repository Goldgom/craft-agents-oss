import { describe, expect, test } from 'bun:test'
import { emptySuperAgentState } from './validation'
import { historySessionEligible, planSuperAgentHistoryCleanup, protectedHistorySessionIds } from './history'
import type { Session } from '../protocol/dto'
import type { SuperAgentScriptRuntime } from './types'

describe('history cleanup selection', () => {
  test('cleans completed acceptance cycles together and retains evidence referenced by newer work', () => {
    const state = emptySuperAgentState()
    const base = { title: 'Artifact', instructions: 'Evidence', nodeId: 'worker', status: 'completed' as const, createdAt: 1, completedAt: 2 }
    state.tasks = [
      { ...base, id: 'build', acceptance: { status: 'accepted', evidenceTaskId: 'review', note: 'Verified', reviewedBy: 'orchestrator', reviewedAt: 3 } },
      { ...base, id: 'review', dependsOn: ['build'], reviewOf: 'build' },
      { ...base, id: 'self', acceptance: { status: 'accepted', evidenceTaskId: 'self', note: 'Self-check', reviewedBy: 'orchestrator', reviewedAt: 3 } },
    ]
    expect(planSuperAgentHistoryCleanup(state, 100, 0).removed.tasks.map(task => task.id)).toEqual(['build', 'review', 'self'])
    state.tasks.push({ ...base, id: 'newer', createdAt: 200, completedAt: 201, dependsOn: ['build'] })
    const cleanup = planSuperAgentHistoryCleanup(state, 100, 0)
    expect(cleanup.removed.tasks.map(task => task.id)).toEqual(['self'])
    expect(cleanup.state.tasks.map(task => task.id)).toEqual(['build', 'review', 'newer'])
  })

  test('protects cross-plan dependency and review sessions of active work', () => {
    const state = emptySuperAgentState()
    const base = { title: 'Evidence', instructions: 'Evidence', nodeId: 'worker', createdAt: 1 }
    state.tasks = [
      { ...base, id: 'evidence', status: 'completed', sessionId: 'evidence-session' },
      { ...base, id: 'build', status: 'completed', sessionId: 'build-session', acceptance: { status: 'accepted', evidenceTaskId: 'evidence', note: 'Checked', reviewedBy: 'orchestrator', reviewedAt: 3 } },
      { ...base, id: 'next', status: 'queued', dependsOn: ['build'] },
    ]
    expect(planSuperAgentHistoryCleanup(state, 100, 0).removed.tasks).toHaveLength(0)
    expect(protectedHistorySessionIds(state)).toEqual(new Set(['build-session', 'evidence-session']))
  })
  test('preserves unfinished goals, linked evidence, current work and shared artifacts', () => {
    const state = emptySuperAgentState()
    state.plans = [
      { id: 'open', title: 'Open', instructions: 'Remaining work', status: 'blocked', note: 'Need evidence', priority: 1, revision: 1, updatedBy: 'main', updatedAt: 1 },
      { id: 'closed', title: 'Closed', instructions: 'Finished work', status: 'completed', note: '', priority: 2, revision: 1, updatedBy: 'main', updatedAt: 1 },
    ]
    state.tasks = [
      { id: 'dependency', planId: 'open', title: 'Previous stage', instructions: 'Details', nodeId: 'worker', sessionId: 'dependency-session', status: 'completed', createdAt: 1, completedAt: 2, output: 'Required evidence' },
      { id: 'old', planId: 'closed', title: 'Finished', instructions: 'Details', nodeId: 'worker', status: 'completed', createdAt: 1, completedAt: 2 },
      { id: 'working', title: 'Current', instructions: 'Details', nodeId: 'worker', status: 'running', createdAt: 1 },
    ]
    state.messages = [
      { id: 'goal', fromNodeId: 'user', toNodeId: 'main', kind: 'chat', body: 'Original authorized goal', createdAt: 1 },
      { id: 'evidence', fromNodeId: 'worker', toNodeId: 'main', kind: 'result', body: 'Evidence', taskId: 'dependency', createdAt: 2 },
      { id: 'old-message', fromNodeId: 'main', toNodeId: 'user', kind: 'chat', body: 'Old completed work', createdAt: 3 },
      { id: 'recent', fromNodeId: 'main', toNodeId: 'user', kind: 'chat', body: 'Recent', createdAt: 4 },
    ]
    state.nodes = [{ nodeId: 'main', status: 'idle', sessionId: 'current-session' }]
    state.board = [{ id: 'artifact', title: 'Evidence', content: 'C:/project/report.md', revision: 1, updatedBy: 'main', updatedAt: 1 }]
    const cleanup = planSuperAgentHistoryCleanup(state, 100, 1)
    expect(cleanup.removed.tasks.map(task => task.id)).toEqual(['old'])
    expect(cleanup.removed.messages.map(message => message.id)).toEqual(['old-message'])
    expect(cleanup.removed.plans.map(plan => plan.id)).toEqual(['closed'])
    expect(cleanup.state.board).toEqual(state.board)
    expect(state.tasks).toHaveLength(3)
    expect(protectedHistorySessionIds(state)).toEqual(new Set(['current-session', 'dependency-session']))
  })
  test('age filters use completion time and never clear live or untracked script logs', () => {
    const state = emptySuperAgentState()
    state.tasks = [{ id: 'recently-finished', title: 'Work', instructions: 'Details', nodeId: 'worker', status: 'completed', createdAt: 1, completedAt: 100 }]
    state.scripts = [{ scriptId: 'ended', status: 'completed', completedAt: 1, output: 'old log' },
      { scriptId: 'running', status: 'running', startedAt: 1, output: 'live log' }, { scriptId: 'unknown', status: 'untracked', completedAt: 1, error: 'check process' }]
    const cleanup = planSuperAgentHistoryCleanup(state, 50, 0)
    expect(cleanup.removed.tasks).toHaveLength(0)
    expect(cleanup.removed.scriptLogs.map(script => script.scriptId)).toEqual(['ended'])
    expect(cleanup.state.scripts[0]!.output).toBeUndefined()
    expect(cleanup.state.scripts[1]!.output).toBe('live log')
    expect(cleanup.state.scripts[2]!.error).toBe('check process')
  })
  test('preserves undelivered, queued and paused script results with their legacy closed assignments', () => {
    const deliveries: Partial<SuperAgentScriptRuntime>[] = [
      { status: 'completed', resultPending: true },
      { status: 'failed', resultQueuedAt: 0 },
      { status: 'stopped', runId: 'paused-run', resultDeliveryPaused: true },
    ]
    for (const delivery of deliveries) {
      const state = emptySuperAgentState()
      state.plans = [{ id: 'closed', title: 'Closed', instructions: 'Verify script output', status: 'completed', note: 'Legacy acceptance', priority: 1, revision: 1, updatedBy: 'main', updatedAt: 1 }]
      state.tasks = [
        { id: 'script-task', planId: 'closed', title: 'Run script', instructions: 'Verify output', nodeId: 'worker', sessionId: 'script-session', status: 'completed', createdAt: 1, completedAt: 2 },
        { id: 'dependency', planId: 'closed', title: 'Input evidence', instructions: 'Details', nodeId: 'worker', sessionId: 'dependency-session', status: 'completed', createdAt: 1, completedAt: 2 },
      ]
      state.messages = [{ id: 'evidence', fromNodeId: 'system', toNodeId: 'main', kind: 'script', body: 'Script result waiting for verification', taskId: 'script-task', createdAt: 2 }]
      state.scripts = [{ scriptId: 'check', taskId: 'script-task', status: 'completed', completedAt: 2, output: 'Required validation evidence', error: 'Diagnostic details', ...delivery }]
      const cleanup = planSuperAgentHistoryCleanup(state, 100, 0)
      expect(cleanup.removed).toEqual({ tasks: [], messages: [], plans: [], scriptLogs: [] })
      expect(cleanup.state.scripts[0]).toMatchObject({ output: 'Required validation evidence', error: 'Diagnostic details' })
      const protectedIds = protectedHistorySessionIds(state)
      expect(protectedIds).toEqual(new Set(['script-session', 'dependency-session']))
      const session: Session = { id: 'script-session', workspaceId: 'alpha', workspaceName: 'Alpha', lastMessageAt: 1, messages: [], isProcessing: false, sessionStatus: 'done' }
      expect(historySessionEligible(session, 'alpha', 100, protectedIds)).toBe(false)
    }
  })
  test('protects a pending manual result and its explicitly linked closed plan without a task', () => {
    const state = emptySuperAgentState()
    state.plans = [{ id: 'closed', title: 'Closed', instructions: 'Verify manual output', status: 'cancelled', note: '', priority: 1, revision: 1, updatedBy: 'main', updatedAt: 1 }]
    state.scripts = [{ scriptId: 'manual', planId: 'closed', runId: 'manual-run', status: 'failed', completedAt: 2, resultQueuedAt: 3, error: 'Validation failure' }]
    state.messages = [{ id: 'goal', fromNodeId: 'user', toNodeId: 'main', kind: 'chat', body: 'Original goal', createdAt: 1 }]
    const cleanup = planSuperAgentHistoryCleanup(state, 100, 0)
    expect(cleanup.removed.plans).toHaveLength(0)
    expect(cleanup.removed.messages).toHaveLength(0)
    expect(cleanup.removed.scriptLogs).toHaveLength(0)
    expect(cleanup.state.scripts[0]!.error).toBe('Validation failure')
  })
  test('retains reviewed script evidence for open plans through direct or task-derived links', () => {
    for (const direct of [true, false]) {
      const state = emptySuperAgentState()
      state.plans = [{ id: 'open', title: 'Open', instructions: 'Check evidence before accepting', status: 'active', note: '', priority: 1, revision: 1, updatedBy: 'main', updatedAt: 1 }]
      state.tasks = [{ id: 'script-task', ...(direct ? {} : { planId: 'open' }), title: 'Run script', instructions: 'Verify output', nodeId: 'worker', sessionId: 'evidence-session', status: 'completed', createdAt: 1, completedAt: 2 }]
      state.scripts = [{ scriptId: 'check', taskId: 'script-task', ...(direct ? { planId: 'open' } : {}), runId: 'reviewed-run', resultReportedAt: 3, status: 'completed', completedAt: 2, output: 'Reviewed but still needed for plan acceptance' }]
      const cleanup = planSuperAgentHistoryCleanup(state, 100, 0)
      expect(cleanup.removed.tasks).toHaveLength(0)
      expect(cleanup.removed.scriptLogs).toHaveLength(0)
      expect(protectedHistorySessionIds(state)).toEqual(new Set(['evidence-session']))
    }
  })
  test('allows old acknowledged terminal evidence to be cleared for closed or unbound work', () => {
    const state = emptySuperAgentState()
    state.plans = [{ id: 'closed', title: 'Closed', instructions: 'Finished', status: 'completed', note: '', priority: 1, revision: 1, updatedBy: 'main', updatedAt: 1 }]
    state.tasks = [{ id: 'old-task', planId: 'closed', title: 'Verified script', instructions: 'Finished', nodeId: 'worker', sessionId: 'old-session', status: 'completed', createdAt: 1, completedAt: 2 }]
    state.scripts = [
      { scriptId: 'closed', taskId: 'old-task', planId: 'closed', runId: 'reported-run', resultPending: false, resultReportedAt: 3, status: 'completed', completedAt: 2, output: 'Old reviewed log' },
      { scriptId: 'unbound', runId: 'reported-unbound-run', resultDeliveryPaused: true, resultReportedAt: 0, status: 'failed', completedAt: 2, output: 'Old log', error: 'Old reviewed failure' },
    ]
    const cleanup = planSuperAgentHistoryCleanup(state, 100, 0)
    expect(cleanup.removed.tasks.map(task => task.id)).toEqual(['old-task'])
    expect(cleanup.removed.plans.map(plan => plan.id)).toEqual(['closed'])
    expect(cleanup.removed.scriptLogs.map(script => script.scriptId)).toEqual(['closed', 'unbound'])
    expect(cleanup.state.scripts.every(script => script.output === undefined && script.error === undefined)).toBe(true)
    expect(protectedHistorySessionIds(state)).toEqual(new Set())
    expect(state.scripts[0]!.output).toBe('Old reviewed log')
  })
  test('session deletion candidates exclude other workspaces, protected and active sessions', () => {
    const session: Session = { id: 'old', workspaceId: 'alpha', workspaceName: 'Alpha', lastMessageAt: 1, messages: [], isProcessing: false, sessionStatus: 'done' }
    const eligible = (changes: Partial<Session>) => historySessionEligible({ ...session, ...changes }, 'alpha', 50, new Set(['protected']))
    expect(eligible({})).toBe(true)
    expect(eligible({ sessionStatus: 'todo', isArchived: true })).toBe(true)
    for (const changes of [{ workspaceId: 'beta' }, { id: 'protected' }, { isProcessing: true }, { isFlagged: true },
      { lastMessageAt: 50 }, { sessionStatus: 'in_progress' }, { taskSlug: 'active-flow' }, { parentSessionId: 'parent' }, { isAsyncOperationOngoing: true }] as Partial<Session>[]) {
      expect(eligible(changes)).toBe(false)
    }
  })
})
