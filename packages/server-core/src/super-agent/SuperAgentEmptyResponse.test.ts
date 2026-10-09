import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSuperAgentDocument, saveSuperAgentDocument } from '@craft-agent/shared/super-agent'
import { resolveSessionTurnCompletion } from '../sessions/session-turn-completion'
import { canRecoverSuperAgentTurn } from './SuperAgentRetry'
import { SuperAgentService } from './SuperAgentService'
import { superAgentFixture, until } from './SuperAgentTestSupport'

type Fixture = Awaited<ReturnType<typeof superAgentFixture>>

function emptyCompletion() {
  const oldAnswer = { id: 'old', role: 'assistant', content: '<super_agent_actions>{"board":[{"title":"old action","content":"must not replay","expectedRevision":0}]}</super_agent_actions>' }
  const user = { id: 'current', role: 'user', content: 'Continue the authorized GPU pilot' }
  return resolveSessionTurnCompletion([oldAnswer, user], 'complete', 'old', 'old')
}

function completeEmpty(context: Fixture, sessionId: string) {
  const completion = emptyCompletion()
  context.host.complete(sessionId, completion.finalText!, completion.reason, completion)
}

async function startTask(context: Fixture) {
  context.config.idleInspectionMinutes = 1440
  await context.service.save('alpha', context.config)
  await context.service.command('alpha', { type: 'task', title: 'Continue GPU pilot', instructions: 'Review downloaded weights and existing training logs before continuing.' })
  const snapshot = await until(() => context.service.get('alpha'), value => value.state.tasks[0]?.status === 'running' && context.host.sends.length === 1)
  return snapshot.state.tasks[0]!
}

async function recovering(context: Fixture) {
  return until(() => context.service.get('alpha'), value => value.state.nodes.some(node => node.status === 'recovering'))
}

async function resume(context: Fixture, sessionId: string, expectedSends: number) {
  const document = await loadSuperAgentDocument(join(context.root, 'alpha'))
  const turn = document.pendingTurns.find(item => item.nodeId === 'worker')!
  context.advance(Math.max(0, turn.retryAt! - context.now()))
  await context.service.tick()
  await until(() => context.service.get('alpha'), () => context.host.sends.filter(send => send.sessionId === sessionId).length === expectedSends)
}

describe('Super Agent empty-response recovery', () => {
  test('classifies only explicit empty responses and keeps their retry budget separate from network failures', () => {
    const empty = emptyCompletion()
    expect(canRecoverSuperAgentTurn(empty, 0)).toBe(true)
    expect(canRecoverSuperAgentTurn(empty, 2)).toBe(true)
    expect(canRecoverSuperAgentTurn(empty, 3)).toBe(false)
    expect(canRecoverSuperAgentTurn({ ...empty, canRetry: false }, 0)).toBe(false)
    expect(canRecoverSuperAgentTurn({ ...empty, reason: 'interrupted' }, 0)).toBe(false)
    expect(canRecoverSuperAgentTurn({ reason: 'error', finalText: empty.finalText }, 0)).toBe(false)
    expect(canRecoverSuperAgentTurn({ reason: 'error', errorCode: 'network_error', canRetry: true }, 3)).toBe(true)
    expect(canRecoverSuperAgentTurn({ reason: 'error', finalText: 'Execution outcome unknown' }, 0)).toBe(false)
  })

  test('continues the same task and session without replaying historical actions or accepting an old answer', async () => {
    const context = await superAgentFixture()
    const task = await startTask(context)
    const original = await loadSuperAgentDocument(join(context.root, 'alpha'))
    const sessionCount = context.host.options.size
    context.host.finalText = '<super_agent_actions>{"board":[{"title":"stale action","content":"must not replay","expectedRevision":0}]}</super_agent_actions>'
    completeEmpty(context, task.sessionId!)
    const waiting = await recovering(context)
    expect(waiting.state.tasks[0]).toMatchObject({ id: task.id, status: 'running', sessionId: task.sessionId, startedAt: task.startedAt })
    expect(waiting.state.plans[0]!.status).toBe('active')
    expect(waiting.state.board).toHaveLength(0)
    expect(waiting.state.messages.some(message => message.kind === 'error')).toBe(false)
    const durable = await loadSuperAgentDocument(join(context.root, 'alpha'))
    expect(durable.pendingTurns[0]).toMatchObject({ id: original.pendingTurns[0]!.id, emptyResponseRetryAttempt: 1 })
    expect(durable.chainCounts).toEqual(original.chainCounts)
    context.advance(1999)
    await context.service.tick()
    expect(context.host.sends).toHaveLength(1)
    await resume(context, task.sessionId!, 2)
    expect(context.host.options.size).toBe(sessionCount)
    expect(context.host.sends[1]!.sessionId).toBe(task.sessionId!)
    expect(context.host.sends[1]!.context).toContain('do not repeat completed operations or restart scripts')
    expect(context.host.sends[1]!.context).toContain('Provide a non-empty final response')
    expect(context.host.finalTextReads).toBe(0)
    context.host.complete(task.sessionId!, 'Verified existing weights and logs; the authorized work is complete.')
    const finished = await until(() => context.service.get('alpha'), value => value.state.tasks[0]!.status === 'completed')
    expect(finished.state.tasks[0]!.output).toBe('Verified existing weights and logs; the authorized work is complete.')
    expect(finished.state.board).toHaveLength(0)
    expect(context.host.finalTextReads).toBe(0)
  })

  test('stops after three automatic continuations and preserves a visible failure', async () => {
    const context = await superAgentFixture()
    const task = await startTask(context)
    for (let attempt = 1; attempt <= 3; attempt++) {
      completeEmpty(context, task.sessionId!)
      await recovering(context)
      const document = await loadSuperAgentDocument(join(context.root, 'alpha'))
      expect(document.pendingTurns.find(turn => turn.taskId === task.id)!.emptyResponseRetryAttempt).toBe(attempt)
      await resume(context, task.sessionId!, attempt + 1)
    }
    completeEmpty(context, task.sessionId!)
    const failed = await until(() => context.service.get('alpha'), value => value.state.tasks[0]!.status === 'failed')
    expect(failed.state.tasks[0]!.error).toContain('3 automatic recovery attempts')
    expect(failed.state.plans[0]!.status).toBe('blocked')
    expect(failed.state.nodes.find(node => node.nodeId === 'worker')!.status).toBe('error')
    expect((await loadSuperAgentDocument(join(context.root, 'alpha'))).pendingTurns.some(turn => turn.taskId === task.id)).toBe(false)
    context.advance(120000)
    await context.service.tick()
    expect(context.host.sends.filter(send => send.sessionId === task.sessionId)).toHaveLength(4)
  })

  test('counts an empty completion and rejection of the same send only once', async () => {
    const context = await superAgentFixture()
    let rejectSend!: (reason: Error) => void
    const pending = new Promise<void>((_resolve, reject) => { rejectSend = reject })
    const send = context.host.sendMessage.bind(context.host)
    context.host.sendMessage = async (sessionId, message) => { await send(sessionId, message); await pending }
    const task = await startTask(context)
    completeEmpty(context, task.sessionId!)
    rejectSend(new Error('Turn completed without a new final assistant response.'))
    await recovering(context)
    const durable = await loadSuperAgentDocument(join(context.root, 'alpha'))
    expect(durable.pendingTurns.find(turn => turn.taskId === task.id)).toMatchObject({ retryAttempt: 1, emptyResponseRetryAttempt: 1 })
    context.host.sendMessage = send
  })

  test('cancellation removes the pending empty-response continuation', async () => {
    const context = await superAgentFixture()
    const task = await startTask(context)
    completeEmpty(context, task.sessionId!)
    await recovering(context)
    const cancelled = await context.service.command('alpha', { type: 'cancel', taskId: task.id })
    expect(cancelled.state.tasks[0]!.status).toBe('cancelled')
    expect((await loadSuperAgentDocument(join(context.root, 'alpha'))).pendingTurns.some(turn => turn.taskId === task.id)).toBe(false)
    context.advance(120000)
    await context.service.tick()
    expect(context.host.sends.filter(send => send.sessionId === task.sessionId)).toHaveLength(1)
  })

  test('persists the empty-response budget across a service restart', async () => {
    const context = await superAgentFixture()
    const task = await startTask(context)
    completeEmpty(context, task.sessionId!)
    await recovering(context)
    const durable = await loadSuperAgentDocument(join(context.root, 'alpha'))
    expect(durable.pendingTurns[0]!.emptyResponseRetryAttempt).toBe(1)
    await context.service.cleanup()
    await saveSuperAgentDocument(join(context.root, 'alpha'), durable)
    const restarted = new SuperAgentService({ host: context.host, rootForWorkspace: id => join(context.root, id), now: context.now, autoTick: false })
    const recovered = { ...context, service: restarted }
    try {
      await restarted.get('alpha')
      await resume(recovered, task.sessionId!, 2)
      for (let attempt = 2; attempt <= 3; attempt++) {
        completeEmpty(recovered, task.sessionId!)
        await recovering(recovered)
        expect((await loadSuperAgentDocument(join(context.root, 'alpha'))).pendingTurns[0]!.emptyResponseRetryAttempt).toBe(attempt)
        await resume(recovered, task.sessionId!, attempt + 1)
      }
      completeEmpty(recovered, task.sessionId!)
      const failed = await until(() => restarted.get('alpha'), value => value.state.tasks[0]!.status === 'failed')
      expect(failed.state.tasks[0]!.error).toContain('3 automatic recovery attempts')
      expect(context.host.sends.filter(send => send.sessionId === task.sessionId)).toHaveLength(4)
    } finally { await restarted.cleanup() }
  })
})
