import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSuperAgentDocument, type SuperAgentDocument } from '@craft-agent/shared/super-agent'
import { superAgentFixture as fixture, until } from './SuperAgentTestSupport'

type Fixture = Awaited<ReturnType<typeof fixture>>

async function startTask(context: Fixture, title = 'Inspect artifacts', workspaceId = 'alpha') {
  await context.service.command(workspaceId, { type: 'task', title, instructions: 'Review the existing artifact and record evidence.' })
  const snapshot = await until(() => context.service.get(workspaceId), value => {
    const task = value.state.tasks.find(task => task.title === title)
    return task?.status === 'running' && context.host.sends.some(send => send.sessionId === task.sessionId)
  })
  return snapshot.state.tasks.find(task => task.title === title)!
}

async function confirmStopped(context: Fixture) {
  context.advance(11_000)
  await context.service.tick()
  context.advance(1_000)
  await context.service.tick()
}

describe('Super Agent runtime turn reconciliation', () => {
  test('settles a lost worker completion as unknown, blocks its plan and asks the coordinator to review once', async () => {
    const context = await fixture()
    const { root, service, host, config } = context
    config.continuousWork = true
    await service.save('alpha', config)
    const task = await startTask(context)
    host.finalText = 'Old result <super_agent_actions>{"board":[{"title":"stale action","content":"must not run","expectedRevision":0}]}</super_agent_actions>'
    host.loseCompletion(task.sessionId!)

    context.advance(11_000)
    await service.tick()
    expect((await service.get('alpha')).state.tasks[0]!.status).toBe('running')
    context.advance(1_000)
    await service.tick()
    const recovered = await until(() => service.get('alpha'), () => host.sends.some(send => send.message.includes('The result is unknown')))
    expect(recovered.state.tasks[0]).toMatchObject({ id: task.id, status: 'failed', sessionId: task.sessionId })
    expect(recovered.state.tasks[0]!.output).toBeUndefined()
    expect(recovered.state.tasks[0]!.error).toContain(task.sessionId!)
    expect(recovered.state.plans[0]!.status).toBe('blocked')
    expect(recovered.state.nodes.find(node => node.nodeId === 'worker')).toMatchObject({ status: 'error', sessionId: undefined, activeTaskId: undefined })
    expect(recovered.state.board).toHaveLength(0)
    expect(host.finalTextReads).toBe(0)
    expect(host.cancelled).toHaveLength(0)
    expect(host.sends.filter(send => send.sessionId === task.sessionId)).toHaveLength(1)
    expect(host.sends.find(send => send.message.includes('The result is unknown'))!.message).toContain('do not replay this turn')
    const saved = await loadSuperAgentDocument(join(root, 'alpha'))
    expect(saved.pendingTurns.filter(turn => turn.nodeId === 'main')).toHaveLength(1)
    expect(saved.pendingTurns.some(turn => turn.taskId === task.id)).toBe(false)

    context.advance(1_000)
    await service.tick()
    expect(host.sends).toHaveLength(2)
  })

  test('keeps a genuinely busy long task running regardless of elapsed time', async () => {
    const context = await fixture()
    const { service, host, config } = context
    config.continuousWork = true
    await service.save('alpha', config)
    const task = await startTask(context)
    context.advance(24 * 60 * 60_000)
    await service.tick()
    context.advance(1_000)
    await service.tick()
    const snapshot = await service.get('alpha')
    expect(snapshot.state.tasks[0]!.status).toBe('running')
    expect(snapshot.state.nodes.find(node => node.nodeId === 'worker')).toMatchObject({ status: 'working', sessionId: task.sessionId })
    expect(host.sessionQueries).toContain(task.sessionId!)
    expect(host.sends).toHaveLength(1)
    expect(snapshot.state.lastInspectionAt).toBeUndefined()
  })

  for (const limit of ['depth', 'budget'] as const) {
    test(`gives an uncertain worker result a system review when its ${limit} limit is exhausted`, async () => {
      const context = await fixture()
      const { root, service, host, config } = context
      await service.save('alpha', config)
      const task = await startTask(context)
      const document = (service as unknown as { documents: Map<string, SuperAgentDocument> }).documents.get('alpha')!
      const turn = document.pendingTurns.find(turn => turn.taskId === task.id)!
      if (limit === 'depth') turn.depth = 6
      else document.chainCounts[turn.chainId] = 32
      const chainId = turn.chainId
      host.loseCompletion(task.sessionId!)
      await confirmStopped(context)
      const recovered = await until(() => service.get('alpha'), () => host.sends.some(send => send.message.includes('The result is unknown')))
      expect(recovered.state.tasks[0]!.status).toBe('failed')
      expect(recovered.state.plans[0]!.status).toBe('blocked')
      const saved = await loadSuperAgentDocument(join(root, 'alpha'))
      const review = saved.pendingTurns.filter(turn => turn.nodeId === 'main')
      expect(review).toHaveLength(1)
      expect(review[0]!.kind).toBe('summary')
      expect(review[0]!.depth).toBe(0)
      expect(review[0]!.chainId).not.toBe(chainId)
      context.advance(1_000)
      await service.tick()
      expect(host.sends).toHaveLength(2)
    })
  }

  test('keeps the original turn and pending permission while the host is still processing', async () => {
    const context = await fixture()
    const { service, host, config } = context
    config.continuousWork = true
    await service.save('alpha', config)
    const task = await startTask(context)
    const waiting = host.requestPermission(task.sessionId!, { requestId: 'approval', toolName: 'Write', description: 'Write reviewed output', approvalTtlSeconds: 120 })
    await until(() => service.get('alpha'), value => value.permissionRequests?.some(request => request.status === 'pending') === true)
    await confirmStopped(context)
    const snapshot = await service.get('alpha')
    expect(snapshot.state.tasks[0]!.status).toBe('running')
    expect(snapshot.activity!.find(activity => activity.nodeId === 'worker')!.status).toBe('waiting_permission')
    expect(snapshot.permissionRequests![0]!.status).toBe('pending')
    expect(host.sends.filter(send => send.sessionId === task.sessionId)).toHaveLength(1)
    expect(host.cancelled).toHaveLength(0)
    await service.command('alpha', { type: 'permission-response', requestId: 'approval', allowed: true })
    expect(await waiting).toBe(true)
  })

  test('allows the startup gap before sendMessage marks the host busy', async () => {
    const context = await fixture()
    const { service, host, config } = context
    config.continuousWork = true
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const send = host.sendMessage.bind(host)
    host.sendMessage = async (sessionId, message) => { await gate; await send(sessionId, message) }
    await service.save('alpha', config)
    try {
      await service.command('alpha', { type: 'task', title: 'Starting', instructions: 'Run the assigned work.' })
      const started = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
      expect(host.sessions.get(started.state.tasks[0]!.sessionId!)!.isProcessing).toBe(false)
      context.advance(9_999)
      await service.tick()
      expect((await service.get('alpha')).state.tasks[0]!.status).toBe('running')
      expect(host.sends).toHaveLength(0)
      release()
      await until(() => service.get('alpha'), () => host.sends.length === 1)
      context.advance(2_000)
      await service.tick()
      expect((await service.get('alpha')).state.tasks[0]!.status).toBe('running')
    } finally { release() }
  })

  test('lets a real completion settle after the first stopped observation', async () => {
    const context = await fixture()
    const { service, host, config } = context
    await service.save('alpha', config)
    const task = await startTask(context)
    host.loseCompletion(task.sessionId!)
    context.advance(11_000)
    await service.tick()
    host.complete(task.sessionId!, 'Actual final result')
    const complete = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'completed')
    expect(complete.state.tasks[0]!.output).toBe('Actual final result')
    context.advance(1_000)
    await service.tick()
    expect((await service.get('alpha')).state.nodes.find(node => node.nodeId === 'worker')!.sessionId).toBe(task.sessionId)
    expect(host.sends.every(send => !send.message.includes('The result is unknown'))).toBe(true)
  })

  test('ignores duplicate and delayed terminal events for a retired session while a new task runs', async () => {
    const context = await fixture()
    const { service, host, config } = context
    await service.save('alpha', config)
    const first = await startTask(context, 'First')
    await service.command('alpha', { type: 'task', title: 'Second', instructions: 'Only execute the second assignment.' })
    host.loseCompletion(first.sessionId!)
    await confirmStopped(context)
    const active = await until(() => service.get('alpha'), value => value.state.tasks[1]?.status === 'running' && host.sends.some(send => send.sessionId === value.state.tasks[1]!.sessionId))
    const second = active.state.tasks[1]!
    expect(second.sessionId).not.toBe(first.sessionId)
    const before = host.sends.length
    const stale = 'Late result <super_agent_actions>{"board":[{"title":"late action","content":"must not run","expectedRevision":0}]}</super_agent_actions>'
    host.complete(first.sessionId!, stale)
    host.complete(first.sessionId!, stale)
    const after = await service.get('alpha')
    expect(after.state.tasks[0]!.status).toBe('failed')
    expect(after.state.tasks[1]).toMatchObject({ status: 'running', sessionId: second.sessionId })
    expect(after.state.board).toHaveLength(0)
    expect(host.sends).toHaveLength(before)
    host.complete(second.sessionId!, 'Second verified output')
    const finished = await until(() => service.get('alpha'), value => value.state.tasks[1]?.status === 'completed')
    expect(finished.state.tasks[1]!.output).toBe('Second verified output')
  })

  test('keeps uncertain host disconnections active and reconciles after the host recovers', async () => {
    const context = await fixture()
    const { service, host, config } = context
    config.continuousWork = true
    await service.save('alpha', config)
    const task = await startTask(context)
    const getSession = host.getSession.bind(host)
    host.getSession = async sessionId => { if (sessionId === task.sessionId) throw new Error('Host disconnected'); return getSession(sessionId) }
    await confirmStopped(context)
    expect((await service.get('alpha')).state.tasks[0]!.status).toBe('running')
    expect(host.sends).toHaveLength(1)
    expect(host.cancelled).toHaveLength(0)
    host.getSession = getSession
    host.loseCompletion(task.sessionId!)
    await service.tick()
    context.advance(1_000)
    await service.tick()
    expect((await service.get('alpha')).state.tasks[0]!.status).toBe('failed')
  })

  for (const missing of [false, true]) {
    test(`${missing ? 'missing' : 'foreign'} session is not reused or cancelled and cannot affect another workspace`, async () => {
      const context = await fixture()
      const { service, host, config } = context
      config.continuousWork = true
      await service.save('alpha', config)
      await service.save('beta', config)
      const first = await startTask(context, 'Alpha work')
      const second = await startTask(context, 'Beta work', 'beta')
      for (const listener of host.listeners) listener({ sessionId: first.sessionId!, workspaceId: 'beta', reason: 'complete', finalText: 'Foreign event' })
      if (missing) host.sessions.delete(first.sessionId!)
      else host.sessions.get(first.sessionId!)!.workspaceId = 'beta'
      await confirmStopped(context)
      const alpha = await service.get('alpha')
      const beta = await service.get('beta')
      expect(alpha.state.tasks[0]!.status).toBe('failed')
      expect(alpha.state.tasks[0]!.error).toContain(missing ? 'is unavailable' : 'different workspace')
      expect(alpha.state.nodes.find(node => node.nodeId === 'worker')!.sessionId).toBeUndefined()
      expect(beta.state.tasks[0]).toMatchObject({ status: 'running', sessionId: second.sessionId })
      expect(host.sessions.get(second.sessionId!)!.isProcessing).toBe(true)
      expect(host.cancelled).toHaveLength(0)
      expect(host.sends.filter(send => send.sessionId === second.sessionId)).toHaveLength(1)
      expect(host.finalTextReads).toBe(0)
    })
  }

  test('gives a coordinator with a lost chat one review turn without recursively retrying lost review turns', async () => {
    const context = await fixture()
    const { service, host, config } = context
    config.continuousWork = true
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: 'Review the authorized goal' })
    const started = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working' && host.sends.length === 1)
    const sessionId = started.state.nodes[0]!.sessionId!
    host.loseCompletion(sessionId)
    await confirmStopped(context)
    const review = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working' && host.sends.length === 2)
    const reviewSessionId = review.state.nodes[0]!.sessionId!
    expect(reviewSessionId).not.toBe(sessionId)
    expect(host.sends[1]!.message).toContain('Do not automatically rerun')
    host.loseCompletion(reviewSessionId)
    await confirmStopped(context)
    const failed = await service.get('alpha')
    expect(failed.state.nodes[0]).toMatchObject({ status: 'error', sessionId: undefined })
    expect((await loadSuperAgentDocument(join(context.root, 'alpha'))).pendingTurns).toHaveLength(0)
    context.advance(1_000)
    await service.tick()
    expect(host.sends).toHaveLength(2)
  })

  test('retains the continuous work idle inspection after lost-event recovery and coordinator review', async () => {
    const context = await fixture()
    const { service, host, config } = context
    config.continuousWork = true
    await service.save('alpha', config)
    const task = await startTask(context)
    host.loseCompletion(task.sessionId!)
    await confirmStopped(context)
    const reviewing = await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working' && host.sends.length === 2)
    host.complete(reviewing.state.nodes.find(node => node.nodeId === 'main')!.sessionId!, 'Recorded the blocker and remaining verification.')
    await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'idle')
    context.advance(config.idleInspectionMinutes * 60_000 - 1)
    await service.tick()
    expect(host.sends).toHaveLength(2)
    context.advance(1)
    await service.tick()
    const inspection = await until(() => service.get('alpha'), () => host.sends.length === 3)
    expect(inspection.state.lastInspectionAt).toBe(context.now())
    expect(host.sends[2]!.message).toContain('持续工作后台自检')
    expect(host.sends.filter(send => send.sessionId === task.sessionId)).toHaveLength(1)
    const document = await loadSuperAgentDocument(join(context.root, 'alpha'))
    expect(document.pendingTurns.find(turn => turn.kind === 'inspection')).toMatchObject({ backgroundInspection: true })
  })
})
