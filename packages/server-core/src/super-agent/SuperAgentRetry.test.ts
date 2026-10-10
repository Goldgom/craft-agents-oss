import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSuperAgentDocument, saveSuperAgentDocument } from '@craft-agent/shared/super-agent'
import { SuperAgentService } from './SuperAgentService'
import { canRecoverSuperAgentTurn, SUPER_AGENT_RECOVERY_WINDOW_MS, superAgentRetryDelay } from './SuperAgentRetry'
import { superAgentFixture, until } from './SuperAgentTestSupport'

const connectionError = 'Connection Error: Could not reach the AI service. Check your internet connection or VPN settings.'
type Fixture = Awaited<ReturnType<typeof superAgentFixture>>

async function startTask(context: Fixture) {
  context.config.idleInspectionMinutes = 1440
  await context.service.save('alpha', context.config)
  await context.service.command('alpha', { type: 'task', title: 'Continue verification', instructions: 'Review existing artifacts and finish verification.' })
  const snapshot = await until(() => context.service.get('alpha'), value => value.state.tasks[0]?.status === 'running' && context.host.sends.length === 1)
  return snapshot.state.tasks[0]!
}

async function recovering(context: Fixture) {
  return until(() => context.service.get('alpha'), value => value.state.nodes.some(node => node.status === 'recovering'))
}

describe('Super Agent transient failure classification', () => {
  test('recovers known network failures and respects explicit nonretryable metadata', () => {
    for (const finalText of [connectionError, 'fetch failed', 'read ECONNRESET', 'Request timed out', 'HTTP 503 service unavailable', '429 too many requests']) {
      expect(canRecoverSuperAgentTurn({ reason: 'error', finalText })).toBe(true)
    }
    expect(canRecoverSuperAgentTurn({ reason: 'error', errorCode: 'network_error', finalText: 'Localized error' })).toBe(true)
    for (const errorCode of ['expired_oauth_token', 'invalid_api_key', 'billing_error', 'permission_denied', 'unknown_error']) {
      expect(canRecoverSuperAgentTurn({ reason: 'error', errorCode, finalText: connectionError })).toBe(false)
    }
    expect(canRecoverSuperAgentTurn({ reason: 'error', errorCode: 'network_error', canRetry: false, finalText: connectionError })).toBe(false)
    for (const finalText of ['401 token expired; connection failed', '402 payment required; connection failed', 'Turn completed without a new final assistant response.', 'Execution outcome unknown']) {
      expect(canRecoverSuperAgentTurn({ reason: 'error', finalText })).toBe(false)
    }
    expect(canRecoverSuperAgentTurn({ reason: 'interrupted', finalText: connectionError })).toBe(false)
    expect(canRecoverSuperAgentTurn({ reason: 'complete', finalText: connectionError })).toBe(false)
  })

  test('backs off exponentially and caps at one minute', () => {
    expect([1, 2, 3, 4, 5, 6, 1000].map(superAgentRetryDelay)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000])
  })
})

describe('Super Agent durable network recovery', () => {
  test('counts a completion event and rejection for the same failed send only once', async () => {
    const context = await superAgentFixture()
    let rejectSend!: (reason: Error) => void
    const pending = new Promise<void>((_resolve, reject) => { rejectSend = reject })
    const send = context.host.sendMessage.bind(context.host)
    context.host.sendMessage = async (sessionId, message) => { await send(sessionId, message); await pending }
    const task = await startTask(context)
    context.host.complete(task.sessionId!, connectionError, 'error', { errorCode: 'network_error' })
    rejectSend(new Error(connectionError))
    await recovering(context)
    const snapshot = await context.service.get('alpha')
    expect(snapshot.state.nodes.find(node => node.nodeId === 'worker')).toMatchObject({ retryAttempt: 1, retryAt: context.now() + 2000 })
    context.host.sendMessage = send
  })

  test('retains the same task, plan and session, then continues only when due and settles once', async () => {
    const context = await superAgentFixture()
    const { service, host, root } = context
    const task = await startTask(context)
    const before = await loadSuperAgentDocument(join(root, 'alpha'))
    host.complete(task.sessionId!, connectionError + '\n<super_agent_actions>{"board":[{"title":"must not apply","content":"failed response","expectedRevision":0}]}</super_agent_actions>', 'error', { errorCode: 'network_error', canRetry: true })
    const waiting = await recovering(context)
    expect(waiting.state.tasks[0]).toMatchObject({ id: task.id, status: 'running', sessionId: task.sessionId, startedAt: task.startedAt })
    expect(waiting.state.plans[0]!.status).toBe('active')
    expect(waiting.state.board).toHaveLength(0)
    expect(waiting.state.messages.some(message => message.kind === 'error')).toBe(false)
    expect(waiting.state.nodes.find(node => node.nodeId === 'worker')).toMatchObject({ status: 'recovering', activeTaskId: task.id, retryAt: context.now() + 2000, retryAttempt: 1 })
    expect(waiting.activity?.find(activity => activity.nodeId === 'worker')?.status).toBe('recovering')
    const durable = await loadSuperAgentDocument(join(root, 'alpha'))
    expect(durable.pendingTurns[0]).toMatchObject({ id: before.pendingTurns[0]!.id, taskId: task.id, retryAttempt: 1 })
    expect(durable.pendingTurns[0]!.startedAt).toBeUndefined()
    expect(durable.chainCounts).toEqual(before.chainCounts)

    context.advance(1999)
    await service.tick()
    expect(host.sends).toHaveLength(1)
    context.advance(1)
    await service.tick()
    await until(() => service.get('alpha'), () => host.sends.length === 2)
    expect(host.sends[1]!.sessionId).toBe(task.sessionId!)
    expect(host.sends[1]!.context).toContain('do not repeat completed operations or restart scripts')
    expect(host.options.size).toBe(1)
    host.complete(task.sessionId!, 'Verified remaining artifacts.')
    const finished = await until(() => service.get('alpha'), value => value.state.tasks[0]!.status === 'completed')
    expect(finished.state.tasks[0]).toMatchObject({ id: task.id, output: 'Verified remaining artifacts.', startedAt: task.startedAt })
    expect(finished.state.nodes.find(node => node.nodeId === 'worker')).toMatchObject({ status: 'idle', retryAt: undefined, retryAttempt: undefined })
    expect(finished.state.messages.filter(message => message.kind === 'result' && message.taskId === task.id)).toHaveLength(1)
  })

  test('bounds repeated failures to ten minutes without consuming the chain budget', async () => {
    const context = await superAgentFixture()
    const task = await startTask(context)
    const before = await loadSuperAgentDocument(join(context.root, 'alpha'))
    const deadline = context.now() + SUPER_AGENT_RECOVERY_WINDOW_MS
    for (let attempt = 1; attempt <= 14; attempt++) {
      context.host.complete(task.sessionId!, connectionError, 'error')
      const waiting = await until(() => context.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'worker')?.retryAttempt === attempt
        && value.state.nodes.find(node => node.nodeId === 'worker')?.status === 'recovering')
      expect(waiting.state.tasks[0]!.status).toBe('running')
      expect((await loadSuperAgentDocument(join(context.root, 'alpha'))).chainCounts).toEqual(before.chainCounts)
      expect(waiting.state.nodes.find(node => node.nodeId === 'worker')!.retryAttempt).toBe(attempt)
      expect(waiting.state.nodes.find(node => node.nodeId === 'worker')!.retryDeadline).toBe(deadline)
      context.advance(Math.min(superAgentRetryDelay(attempt), deadline - context.now()))
      await context.service.tick()
      if (context.now() === deadline) break
      await until(() => context.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'worker')?.status === 'working' && context.host.sends.length === attempt + 1)
    }
    const durable = await loadSuperAgentDocument(join(context.root, 'alpha'))
    expect(durable.chainCounts[before.pendingTurns[0]!.chainId]).toBe(2)
    expect(durable.pendingTurns.some(turn => turn.taskId === task.id)).toBe(false)
    expect(durable.failedTurns?.[0]).toMatchObject({ taskId: task.id, retryDeadline: deadline })
    expect(durable.state.tasks[0]!.status).toBe('failed')
    expect(durable.state.plans[0]!.status).toBe('blocked')
    expect(durable.state.nodes.find(node => node.nodeId === 'worker')!.error).toContain('10 minutes')
    expect(context.host.sends.filter(send => send.sessionId === task.sessionId)).toHaveLength(14)
  })

  test('cancel during backoff retires the recovery and prevents future sends', async () => {
    const context = await superAgentFixture()
    const task = await startTask(context)
    context.host.complete(task.sessionId!, connectionError, 'error')
    await recovering(context)
    const cancelled = await context.service.command('alpha', { type: 'cancel', taskId: task.id })
    expect(cancelled.state.tasks[0]!.status).toBe('cancelled')
    expect(cancelled.state.nodes.find(node => node.nodeId === 'worker')).toMatchObject({ status: 'idle', activeTaskId: undefined, retryAt: undefined, retryAttempt: undefined })
    context.advance(120000)
    await context.service.tick()
    expect(context.host.sends).toHaveLength(1)
    expect((await loadSuperAgentDocument(join(context.root, 'alpha'))).pendingTurns).toHaveLength(0)
  })

  test('authentication failures remain terminal even when display text mentions connection', async () => {
    const context = await superAgentFixture()
    const task = await startTask(context)
    context.host.complete(task.sessionId!, connectionError, 'error', { errorCode: 'expired_oauth_token', canRetry: false })
    const finished = await until(() => context.service.get('alpha'), value => value.state.tasks[0]!.status === 'failed')
    expect(finished.state.nodes.find(node => node.nodeId === 'worker')!.status).toBe('error')
    expect(finished.state.plans[0]!.status).toBe('blocked')
    expect((await loadSuperAgentDocument(join(context.root, 'alpha'))).pendingTurns.some(turn => turn.taskId === task.id)).toBe(false)
  })

  test('reloads a persisted recovery with its deadline and original session', async () => {
    const context = await superAgentFixture()
    const task = await startTask(context)
    context.host.complete(task.sessionId!, connectionError, 'error')
    await recovering(context)
    const durable = await loadSuperAgentDocument(join(context.root, 'alpha'))
    context.advance(500)
    await context.service.cleanup()
    // Restore the last durable checkpoint to simulate an abrupt process exit;
    // orderly cleanup explicitly cancels work as part of shutdown.
    await saveSuperAgentDocument(join(context.root, 'alpha'), durable)
    const restarted = new SuperAgentService({ host: context.host, rootForWorkspace: id => join(context.root, id), now: context.now, autoTick: false })
    try {
      const snapshot = await restarted.get('alpha')
      expect(snapshot.state.nodes.find(node => node.nodeId === 'worker')).toMatchObject({ status: 'recovering', sessionId: task.sessionId, retryAt: context.now() + 1500, retryDeadline: durable.pendingTurns[0]!.retryDeadline })
      context.advance(1499)
      await restarted.tick()
      expect(context.host.sends).toHaveLength(1)
      context.advance(1)
      await restarted.tick()
      await until(() => restarted.get('alpha'), () => context.host.sends.length === 2)
      expect(context.host.sends[1]!.sessionId).toBe(task.sessionId!)
    } finally { await restarted.cleanup() }
  })

  test('coordinator recovery precedes newly queued chat and can be stopped without a task', async () => {
    const context = await superAgentFixture()
    await context.service.save('alpha', context.config)
    await context.service.command('alpha', { type: 'chat', text: 'Original authorized request' })
    await until(() => context.service.get('alpha'), () => context.host.sends.length === 1)
    const sessionId = context.host.sends[0]!.sessionId
    context.host.complete(sessionId, connectionError, 'error')
    await recovering(context)
    await context.service.command('alpha', { type: 'chat', text: 'Later question' })
    expect(context.host.sends).toHaveLength(1)
    context.advance(2000)
    await context.service.tick()
    await until(() => context.service.get('alpha'), () => context.host.sends.length === 2)
    expect(context.host.sends[1]!.message).toContain('Original authorized request')
    context.host.complete(sessionId, connectionError, 'error')
    await recovering(context)
    const cancelled = await context.service.command('alpha', { type: 'cancel' })
    expect(cancelled.state.nodes.find(node => node.nodeId === 'main')!.status).toBe('idle')
    context.advance(120000)
    await context.service.tick()
    expect(context.host.sends).toHaveLength(2)
  })

  test('disabling continuous work clears a recovering background inspection', async () => {
    const context = await superAgentFixture()
    context.config.continuousWork = true
    context.config.idleInspectionMinutes = 30
    await context.service.save('alpha', context.config)
    context.advance(30 * 60000)
    await context.service.tick()
    await until(() => context.service.get('alpha'), () => context.host.sends.length === 1)
    context.host.complete(context.host.sends[0]!.sessionId, connectionError, 'error')
    await recovering(context)
    const disabled = await context.service.command('alpha', { type: 'continuous-work', enabled: false })
    expect(disabled.state.nodes.find(node => node.nodeId === 'main')).toMatchObject({ status: 'idle', retryAt: undefined, retryAttempt: undefined })
    context.advance(120000)
    await context.service.tick()
    expect(context.host.sends).toHaveLength(1)
    expect((await loadSuperAgentDocument(join(context.root, 'alpha'))).pendingTurns).toHaveLength(0)
  })

  test('retiring a queued background inspection preserves recovery of an unrelated coordinator request', async () => {
    const context = await superAgentFixture()
    const session = await context.host.createSession('alpha', {})
    const document = await loadSuperAgentDocument(join(context.root, 'alpha'))
    document.config = { ...context.config, continuousWork: true }
    document.state.nodes = [{ nodeId: 'main', sessionId: session.id, status: 'recovering', retryAttempt: 1, retryAt: context.now() + 2000 }, { nodeId: 'worker', status: 'idle' }]
    document.pendingTurns = [
      { id: 'chat_retry', nodeId: 'main', kind: 'chat', text: 'Continue authorized request', createdAt: context.now(), retryAttempt: 1, retryAt: context.now() + 2000, depth: 0, chainId: 'chat_retry' },
      { id: 'background', nodeId: 'main', kind: 'inspection', text: 'Background inspection', createdAt: context.now(), backgroundInspection: true, depth: 0, chainId: 'background' },
    ]
    await saveSuperAgentDocument(join(context.root, 'alpha'), document)
    const disabled = await context.service.command('alpha', { type: 'continuous-work', enabled: false })
    expect(disabled.state.nodes[0]).toMatchObject({ status: 'recovering', retryAttempt: 1, retryAt: context.now() + 2000 })
    expect((await loadSuperAgentDocument(join(context.root, 'alpha'))).pendingTurns.map(turn => turn.id)).toEqual(['chat_retry'])
    expect(context.host.sends).toHaveLength(0)
    context.advance(2000)
    await context.service.tick()
    await until(() => context.service.get('alpha'), () => context.host.sends.length === 1)
    expect(context.host.sends[0]!.message).toContain('Continue authorized request')
  })
})
