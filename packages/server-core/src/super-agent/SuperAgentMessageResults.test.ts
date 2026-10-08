import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSuperAgentDocument, type SuperAgentDocument } from '@craft-agent/shared/super-agent'
import { superAgentFixture, until } from './SuperAgentTestSupport'

const actions = (value: object) => `<super_agent_actions>${JSON.stringify(value)}</super_agent_actions>`

describe('Super Agent message-result liveness', () => {
  test('delivers a worker message result immediately and lets the coordinator dispatch the next step', async () => {
    const context = await superAgentFixture()
    context.config.continuousWork = true; context.config.idleInspectionMinutes = 30
    await context.service.save('alpha', context.config)
    await context.service.command('alpha', { type: 'chat', text: 'Review the current specification and continue implementation.' })
    await until(() => context.service.get('alpha'), () => context.host.sends.length === 1)
    const coordinatorSession = context.host.sends[0]!.sessionId
    context.host.complete(coordinatorSession, actions({ messages: [{ toNodeId: 'worker', body: 'Review the specification already provided and return the next implementable step.' }] }))
    await until(() => context.service.get('alpha'), () => context.host.sends.length === 2)
    const workerSession = context.host.sends[1]!.sessionId
    context.host.complete(workerSession, 'Specification review completed: implement the verified minimal interface; no training has run.')
    const saved = await until(() => loadSuperAgentDocument(join(context.root, 'alpha')), value => value.pendingTurns.some(turn => turn.nodeId === 'main' && turn.kind === 'summary'))
    expect(saved.pendingTurns.find(turn => turn.nodeId === 'main')!.text).toContain('Specification review completed')
    expect(saved.state.messages.at(-1)).toMatchObject({ fromNodeId: 'worker', toNodeId: 'main', kind: 'message' })
    expect(saved.state.tasks).toHaveLength(0)
    context.advance(1000); await context.service.tick()
    await until(() => context.service.get('alpha'), () => context.host.sends.length === 3)
    expect(context.host.sends[2]!.sessionId).toBe(coordinatorSession)
    expect(context.host.sends[2]!.message).toContain('do not repeat completed work, restart scripts')
    context.host.complete(coordinatorSession, actions({ tasks: [{ nodeId: 'worker', title: 'Implement interface', instructions: 'Implement only the authorized reviewed interface.' }] }))
    await until(() => context.service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    expect(context.host.sends).toHaveLength(4)
    expect(context.now()).toBeLessThan(30 * 60_000)
  })

  test('reuses an explicit queued coordinator notice while retaining the worker final result in context', async () => {
    const context = await superAgentFixture()
    await context.service.save('alpha', context.config)
    await context.service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'worker', body: 'Return verification evidence.' })
    await until(() => context.service.get('alpha'), () => context.host.sends.length === 1)
    context.host.complete(context.host.sends[0]!.sessionId, 'The artifact passed independent verification.\n' + actions({ messages: [{ toNodeId: 'main', body: 'Verification report is ready.' }] }))
    const saved = await until(() => loadSuperAgentDocument(join(context.root, 'alpha')), value => value.pendingTurns.some(turn => turn.nodeId === 'main'))
    expect(saved.pendingTurns.filter(turn => turn.nodeId === 'main')).toHaveLength(1)
    await until(() => context.service.get('alpha'), () => context.host.sends.length === 2)
    expect(context.host.sends[1]!.message).toContain('The artifact passed independent verification.')
  })

  test('reports terminal message errors without replaying failed actions', async () => {
    const context = await superAgentFixture()
    await context.service.save('alpha', context.config)
    await context.service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'worker', body: 'Check the current progress.' })
    await until(() => context.service.get('alpha'), () => context.host.sends.length === 1)
    context.host.complete(context.host.sends[0]!.sessionId, 'API key expired\n' + actions({ board: [{ title: 'Must not apply', content: 'Failed response', expectedRevision: 0 }] }), 'error', { errorCode: 'invalid_api_key', canRetry: false })
    const saved = await until(() => loadSuperAgentDocument(join(context.root, 'alpha')), value => value.pendingTurns.some(turn => turn.nodeId === 'main'))
    expect(saved.pendingTurns.find(turn => turn.nodeId === 'main')!.text).toContain('API key expired')
    expect(saved.state.board).toHaveLength(0)
    expect(saved.state.tasks).toHaveLength(0)
  })

  test('does not wake the coordinator for an empty actions-only worker reply or a cancelled turn', async () => {
    for (const cancelled of [false, true]) {
      const context = await superAgentFixture()
      await context.service.save('alpha', context.config)
      await context.service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'worker', body: 'No response needed if unchanged.' })
      await until(() => context.service.get('alpha'), () => context.host.sends.length === 1)
      const sessionId = context.host.sends[0]!.sessionId
      if (cancelled) await context.service.command('alpha', { type: 'cancel' })
      context.host.complete(sessionId, cancelled ? 'Late result must not resume work.' : actions({}))
      await until(() => context.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'worker')!.status === 'idle')
      context.advance(1000); await context.service.tick()
      const saved = await loadSuperAgentDocument(join(context.root, 'alpha'))
      expect(saved.pendingTurns).toHaveLength(0)
      expect(context.host.sends).toHaveLength(1)
    }
  })

  for (const continuousWork of [false, true]) {
    test(`handles exhausted message chains without bypassing continuation policy (${continuousWork})`, async () => {
      const context = await superAgentFixture()
      context.config.continuousWork = continuousWork
      await context.service.save('alpha', context.config)
      await context.service.command('alpha', { type: 'plan-upsert', item: { id: 'goal', title: 'Authorized goal', instructions: 'Continue only this goal.', status: 'active', priority: 3, note: '' }, expectedRevision: 0 })
      await context.service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'worker', body: 'Review dependency for goal.' })
      await until(() => context.service.get('alpha'), () => context.host.sends.length === 1)
      const document = (context.service as unknown as { documents: Map<string, SuperAgentDocument> }).documents.get('alpha')!
      const turn = document.pendingTurns[0]!
      const chainId = turn.chainId
      turn.depth = 6; document.chainCounts[chainId] = 32
      context.host.complete(context.host.sends[0]!.sessionId, 'Dependency has been verified; coordinator review is required.')
      await until(() => context.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'worker')!.status === 'idle')
      const saved = await loadSuperAgentDocument(join(context.root, 'alpha'))
      if (continuousWork) {
        expect(saved.pendingTurns[0]).toMatchObject({ nodeId: 'main', kind: 'summary', depth: 0 })
        expect(saved.pendingTurns[0]!.chainId).not.toBe(chainId)
      } else {
        expect(saved.pendingTurns).toHaveLength(0)
      }
    })
  }
})
