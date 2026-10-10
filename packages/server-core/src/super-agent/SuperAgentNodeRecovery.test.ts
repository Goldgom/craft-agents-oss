import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSuperAgentDocument, saveSuperAgentDocument, type SuperAgentDocument } from '@craft-agent/shared/super-agent'
import { SuperAgentService } from './SuperAgentService'
import { SUPER_AGENT_RECOVERY_WINDOW_MS } from './SuperAgentRetry'
import { superAgentFixture, until } from './SuperAgentTestSupport'

type Fixture = Awaited<ReturnType<typeof superAgentFixture>>

async function start(context: Fixture) {
  context.config.idleInspectionMinutes = 1440
  await context.service.save('alpha', context.config)
  await context.service.command('alpha', { type: 'task', title: 'Verify', instructions: 'Continue the authorized verification.' })
  const snapshot = await until(() => context.service.get('alpha'), value => value.state.tasks[0]?.status === 'running' && context.host.sends.length === 1)
  return snapshot.state.tasks[0]!
}

async function fail(context: Fixture, sessionId: string, errorCode = 'network_error') {
  context.host.complete(sessionId, errorCode === 'network_error' ? 'fetch failed' : 'Fix login first', 'error', { errorCode })
  return until(() => context.service.get('alpha'), value => value.state.nodes.some(node => ['error', 'recovering'].includes(node.status)))
}

describe('Super Agent manual node recovery', () => {
  test('refreshes backoff promptly, preserves task/session/budget and still enforces call rate', async () => {
    const context = await superAgentFixture()
    context.config.nodes.find(node => node.id === 'worker')!.maxCallsPerMinute = 1
    const task = await start(context)
    await fail(context, task.sessionId!)
    const before = await loadSuperAgentDocument(join(context.root, 'alpha'))
    context.advance(500)
    const refreshed = await context.service.command('alpha', { type: 'node-refresh', nodeId: 'worker' })
    expect(refreshed.state.nodes.find(node => node.nodeId === 'worker')).toMatchObject({ status: 'recovering', retryAttempt: 0, retryDeadline: context.now() + SUPER_AGENT_RECOVERY_WINDOW_MS })
    expect(context.host.sends).toHaveLength(1)
    const after = await loadSuperAgentDocument(join(context.root, 'alpha'))
    expect(after.pendingTurns[0]).toMatchObject({ id: before.pendingTurns[0]!.id, taskId: task.id, manualRecovery: true })
    expect(after.chainCounts).toEqual(before.chainCounts)
    context.advance(59_500)
    await context.service.tick()
    await until(() => context.service.get('alpha'), () => context.host.sends.length === 2)
    expect(context.host.sends[1]!.sessionId).toBe(task.sessionId!)
    expect(context.host.sends[1]!.context).toContain('do not repeat completed operations or restart scripts')
    expect((await context.service.get('alpha')).state.tasks).toHaveLength(1)
  })

  test('requires manual action after authentication failure and keeps the blocked plan for review', async () => {
    const context = await superAgentFixture()
    const task = await start(context)
    await fail(context, task.sessionId!, 'expired_oauth_token')
    context.advance(1000)
    await context.service.tick()
    expect(context.host.sends.filter(send => send.sessionId === task.sessionId)).toHaveLength(1)
    await context.service.command('alpha', { type: 'node-refresh', nodeId: 'worker' })
    await until(() => context.service.get('alpha'), () => context.host.sends.filter(send => send.sessionId === task.sessionId).length === 2)
    context.host.complete(task.sessionId!, 'Verified')
    const finished = await until(() => context.service.get('alpha'), value => value.state.tasks[0]!.status === 'completed')
    expect(finished.state.tasks).toHaveLength(1)
    expect(finished.state.plans[0]!.status).toBe('blocked')
    expect(finished.state.nodes.find(node => node.nodeId === 'worker')!.retryDeadline).toBeUndefined()
  })

  test('refuses working nodes, busy host sessions and sessions owned by another workspace', async () => {
    const context = await superAgentFixture()
    const task = await start(context)
    await expect(context.service.command('alpha', { type: 'node-refresh', nodeId: 'worker' })).rejects.toThrow('Only abnormal')
    await fail(context, task.sessionId!)
    const session = context.host.sessions.get(task.sessionId!)!
    session.isProcessing = true
    await expect(context.service.command('alpha', { type: 'node-refresh', nodeId: 'worker' })).rejects.toThrow('still busy')
    session.isProcessing = false; session.workspaceId = 'beta'
    await expect(context.service.command('alpha', { type: 'node-refresh', nodeId: 'worker' })).rejects.toThrow('not owned')
    session.workspaceId = 'alpha'
    expect(context.host.sends).toHaveLength(1)
  })

  test('stopping a failed task discards its checkpoint and refresh cannot resurrect it', async () => {
    const context = await superAgentFixture()
    const task = await start(context)
    await fail(context, task.sessionId!, 'invalid_api_key')
    await context.service.command('alpha', { type: 'cancel', taskId: task.id })
    const refreshed = await context.service.command('alpha', { type: 'node-refresh', nodeId: 'worker' })
    expect(refreshed.state.nodes.find(node => node.nodeId === 'worker')!.status).toBe('idle')
    expect(refreshed.state.tasks[0]!.status).toBe('failed')
    context.advance(1000)
    await context.service.tick()
    expect(context.host.sends.filter(send => send.sessionId === task.sessionId)).toHaveLength(1)
  })

  test('unknown completion refresh resets only the node without replaying the turn', async () => {
    const context = await superAgentFixture()
    const task = await start(context)
    context.host.loseCompletion(task.sessionId!)
    context.advance(11000); await context.service.tick()
    context.advance(1000); await context.service.tick()
    const saved = await loadSuperAgentDocument(join(context.root, 'alpha'))
    expect(saved.failedTurns?.some(turn => turn.nodeId === 'worker')).toBe(false)
    const refreshed = await context.service.command('alpha', { type: 'node-refresh', nodeId: 'worker' })
    expect(refreshed.state.nodes.find(node => node.nodeId === 'worker')!.status).toBe('idle')
    expect(refreshed.state.tasks[0]!.status).toBe('failed')
    context.advance(1000); await context.service.tick()
    expect(context.host.sends.filter(send => send.sessionId === task.sessionId)).toHaveLength(1)
  })

  test('retains a terminal checkpoint across restart for explicit manual recovery', async () => {
    const context = await superAgentFixture()
    const task = await start(context)
    await fail(context, task.sessionId!, 'invalid_api_key')
    const saved = await loadSuperAgentDocument(join(context.root, 'alpha'))
    await context.service.cleanup()
    await saveSuperAgentDocument(join(context.root, 'alpha'), saved)
    const restarted = new SuperAgentService({ host: context.host, rootForWorkspace: id => join(context.root, id), now: context.now, autoTick: false })
    try {
      await restarted.get('alpha')
      context.advance(1000)
      await restarted.command('alpha', { type: 'node-refresh', nodeId: 'worker' })
      await until(() => restarted.get('alpha'), () => context.host.sends.filter(send => send.sessionId === task.sessionId).length === 2)
      expect((await restarted.get('alpha')).state.tasks[0]!.id).toBe(task.id)
    } finally { await restarted.cleanup() }
  })

  test('does not send an expired persisted recovery after restart and retains manual recovery', async () => {
    const context = await superAgentFixture()
    const task = await start(context)
    await fail(context, task.sessionId!)
    const saved = await loadSuperAgentDocument(join(context.root, 'alpha'))
    await context.service.cleanup()
    await saveSuperAgentDocument(join(context.root, 'alpha'), saved)
    context.advance(SUPER_AGENT_RECOVERY_WINDOW_MS)
    const restarted = new SuperAgentService({ host: context.host, rootForWorkspace: id => join(context.root, id), now: context.now, autoTick: false })
    try {
      await restarted.get('alpha')
      expect(context.host.sends).toHaveLength(1)
      await restarted.tick()
      expect((await restarted.get('alpha')).state.tasks[0]!.status).toBe('failed')
      expect(context.host.sends.filter(send => send.sessionId === task.sessionId)).toHaveLength(1)
      await restarted.command('alpha', { type: 'node-refresh', nodeId: 'worker' })
      await until(() => restarted.get('alpha'), () => context.host.sends.filter(send => send.sessionId === task.sessionId).length === 2)
    } finally { await restarted.cleanup() }
  })

  test('expires during slow environment preparation without sending a late retry', async () => {
    const context = await superAgentFixture()
    const task = await start(context)
    await fail(context, task.sessionId!)
    const document = (context.service as unknown as { documents: Map<string, SuperAgentDocument> }).documents.get('alpha')!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const prepare = context.host.ensureSuperAgentSessionSettings.bind(context.host)
    context.host.ensureSuperAgentSessionSettings = async (sessionId, settings) => { await gate; await prepare(sessionId, settings) }
    try {
      context.advance(2000); await context.service.tick()
      await until(() => context.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'worker')!.status === 'preparing')
      context.advance(SUPER_AGENT_RECOVERY_WINDOW_MS)
      release()
      await until(() => context.service.get('alpha'), value => value.state.tasks[0]!.status === 'failed')
      expect(document.failedTurns?.[0]!.taskId).toBe(task.id)
      expect(context.host.sends.filter(send => send.sessionId === task.sessionId)).toHaveLength(1)
    } finally { release() }
  })

  test('does not interrupt a recovery request that is genuinely running past its deadline', async () => {
    const context = await superAgentFixture()
    const task = await start(context)
    await fail(context, task.sessionId!)
    context.advance(2000); await context.service.tick()
    await until(() => context.service.get('alpha'), () => context.host.sends.length === 2)
    context.advance(SUPER_AGENT_RECOVERY_WINDOW_MS); await context.service.tick()
    expect((await context.service.get('alpha')).state.tasks[0]!.status).toBe('running')
    context.host.complete(task.sessionId!, 'Verified long-running work')
    const finished = await until(() => context.service.get('alpha'), value => value.state.tasks[0]!.status === 'completed')
    expect(finished.state.tasks[0]!.output).toBe('Verified long-running work')
    expect(context.host.cancelled).toHaveLength(0)
  })

  test('refuses to resume a checkpoint after its plan has been cancelled', async () => {
    const context = await superAgentFixture()
    const task = await start(context)
    await fail(context, task.sessionId!, 'invalid_api_key')
    const snapshot = await context.service.get('alpha')
    const plan = snapshot.state.plans[0]!
    await context.service.command('alpha', { type: 'plan-upsert', item: { id: plan.id, title: plan.title, instructions: plan.instructions, status: 'cancelled', priority: plan.priority, note: plan.note }, expectedRevision: plan.revision })
    await expect(context.service.command('alpha', { type: 'node-refresh', nodeId: 'worker' })).rejects.toThrow('plan is no longer recoverable')
    expect((await context.service.get('alpha')).state.tasks[0]!.status).toBe('failed')
    expect(context.host.sends.filter(send => send.sessionId === task.sessionId)).toHaveLength(1)
  })
})
