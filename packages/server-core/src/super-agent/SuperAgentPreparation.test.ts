import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSuperAgentDocument, awaitSuperAgentPreparation, type SuperAgentDocument, type SuperAgentPreparationOptions, type SuperAgentSessionPolicy } from '@tokenbird/shared/super-agent'
import { superAgentFixture, until } from './SuperAgentTestSupport'
import { SuperAgentService } from './SuperAgentService'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
type Fixture = Awaited<ReturnType<typeof superAgentFixture>>
const worker = (snapshot: Awaited<ReturnType<Fixture['service']['get']>>) => snapshot.state.nodes.find(node => node.nodeId === 'worker')!
async function queue(context: Fixture) {
  context.config.idleInspectionMinutes = 1440
  context.config.execution = { connectionConcurrency: 30, connectionCallsPerMinute: 600, stallMinutes: 15, maxResumeAttempts: 3, preparationTimeoutSeconds: 10, preparationMaxRetries: 2, ...context.config.execution }
  await context.service.save('alpha', context.config)
  return context.service.command('alpha', { type: 'task', title: 'Preparation check', instructions: 'Verify the authorized scope once.' })
}

describe('Super Agent preparation supervisor', () => {
  test('the initial session lookup is inside the watchdog and does not lock polling', async () => {
    const context = await superAgentFixture()
    await queue(context)
    const first = await until(() => context.service.get('alpha'), snapshot => worker(snapshot).status === 'working')
    const sessionId = worker(first).sessionId!
    context.host.complete(sessionId, 'First task verified')
    await until(() => context.service.get('alpha'), snapshot => snapshot.state.tasks[0]?.status === 'completed')
    const gate = deferred<Awaited<ReturnType<typeof context.host.getSession>>>()
    const getSession = context.host.getSession.bind(context.host)
    let lookupStarted = false
    context.host.getSession = async id => { if (id === sessionId) { lookupStarted = true; return gate.promise }; return getSession(id) }
    context.advance(1001)
    await context.service.command('alpha', { type: 'task', title: 'Second task', instructions: 'Verify the second scope.' })
    await until(() => context.service.get('alpha'), snapshot => lookupStarted && worker(snapshot).preparation?.stage === 'session')
    context.advance(10_001); await context.service.tick()
    const failed = await until(() => context.service.get('alpha'), snapshot => worker(snapshot).preparation?.cleanupPending === true)
    expect(worker(failed).preparation?.stage).toBe('session')
    gate.resolve(context.host.sessions.get(sessionId)!)
    expect(context.host.sends.filter(send => send.sessionId === sessionId)).toHaveLength(1)
  })

  test('an unknown operation blocks automatic and manual retry even after a late wait stops', async () => {
    const context = await superAgentFixture()
    const gate = deferred()
    context.host.applySessionPolicy = async (_id, policy) => { if (policy.role === 'worker') await gate.promise }
    await queue(context)
    const preparing = await until(() => context.service.get('alpha'), snapshot => worker(snapshot).preparation?.stage === 'policy')
    const document = (context.service as unknown as { documents: Map<string, SuperAgentDocument> }).documents.get('alpha')!
    const turn = document.pendingTurns.find(turn => turn.nodeId === 'worker')!
    ;(document.state.operations ??= []).push({ id: 'unknown-effect', key: 'a'.repeat(64), nodeId: 'worker', sessionId: worker(preparing).sessionId!,
      taskId: turn.taskId, turnId: turn.id, invocationId: 'old-call', toolName: 'Write', status: 'unknown', createdAt: context.now(), updatedAt: context.now() })
    context.advance(10_001); await context.service.tick()
    await until(() => context.service.get('alpha'), snapshot => worker(snapshot).preparation?.cleanupPending === true)
    gate.resolve()
    await new Promise(resolve => setTimeout(resolve, 10))
    context.advance(30_000); await context.service.tick()
    expect(worker(await context.service.get('alpha')).preparation?.status).toBe('failed')
    await expect(context.service.command('alpha', { type: 'node-recover', nodeId: 'worker' })).rejects.toThrow('unknown operations')
    expect(context.host.sends.filter(send => send.sessionId === worker(preparing).sessionId)).toHaveLength(0)
  })

  test('health is bounded and scoped; the interaction node can recover the planner independently and idempotently', async () => {
    const context = await superAgentFixture()
    const gate = deferred()
    context.config.nodes.push({ ...context.config.nodes[1]!, id: 'orchestrator', role: 'orchestrator' })
    context.host.applySessionPolicy = async (_id, policy) => { if (policy.role === 'orchestrator') await gate.promise }
    context.config.idleInspectionMinutes = 1440
    context.config.execution = { connectionConcurrency: 30, connectionCallsPerMinute: 600, stallMinutes: 15, maxResumeAttempts: 3, preparationTimeoutSeconds: 10 }
    await context.service.save('alpha', context.config)
    await context.service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'orchestrator', body: 'Plan the authorized work.' })
    await until(() => context.service.get('alpha'), snapshot => snapshot.state.nodes.find(node => node.nodeId === 'orchestrator')?.preparation?.stage === 'policy')
    context.advance(10_001); await context.service.tick()
    await until(() => context.service.get('alpha'), snapshot => snapshot.state.nodes.find(node => node.nodeId === 'orchestrator')?.preparation?.cleanupPending === true)
    // The failure notification is queued directly for interaction, not behind the planner.
    await context.service.tick()
    const notifying = await until(() => context.service.get('alpha'), snapshot => snapshot.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    const main = notifying.state.nodes.find(node => node.nodeId === 'main')!.sessionId!
    const read = await context.service.callNodeActionTool('alpha', main, 'super_agent_health', { requestId: 'health-read', action: 'get', nodeId: 'orchestrator' })
    expect(read).toMatchObject({ data: { nodes: [{ nodeId: 'orchestrator', status: 'error', preparation: { stage: 'policy', cleanupPending: true } }] } })
    expect(JSON.stringify(read)).not.toContain('Plan the authorized work.')
    gate.resolve()
    await new Promise(resolve => setTimeout(resolve, 10))
    const input = { requestId: 'recover-once', action: 'recover', nodeId: 'orchestrator' }
    const first = await context.service.callNodeActionTool('alpha', main, 'super_agent_health', input)
    expect(first.receipt.status).toBe('applied')
    const second = await context.service.callNodeActionTool('alpha', main, 'super_agent_health', input)
    expect(second.receipt).toEqual(first.receipt)
    await expect(context.service.callNodeActionTool('beta', main, 'super_agent_health', { requestId: 'cross-workspace', action: 'get' })).rejects.toThrow()
  })

  test('workers can inspect only themselves and AI recovery cannot reset an exhausted budget', async () => {
    const context = await superAgentFixture()
    context.config.execution = { connectionConcurrency: 30, connectionCallsPerMinute: 600, stallMinutes: 15, maxResumeAttempts: 3, preparationMaxRetries: 0 }
    context.host.applySessionPolicy = async (_id, policy) => { if (policy.role === 'worker') throw new Error('Injected failure') }
    await queue(context)
    await until(() => context.service.get('alpha'), snapshot => worker(snapshot).preparation?.status === 'failed')
    await context.service.tick()
    const notifying = await until(() => context.service.get('alpha'), snapshot => snapshot.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    const main = notifying.state.nodes.find(node => node.nodeId === 'main')!.sessionId!
    await expect(context.service.callNodeActionTool('alpha', main, 'super_agent_health', { requestId: 'exhausted', action: 'recover', nodeId: 'worker' })).rejects.toThrow('budget exhausted')
    context.host.applySessionPolicy = async () => {}
    await context.service.command('alpha', { type: 'node-recover', nodeId: 'worker' })
    const running = await until(() => context.service.get('alpha'), snapshot => worker(snapshot).status === 'working')
    const own = await context.service.callNodeActionTool('alpha', worker(running).sessionId!, 'super_agent_health', { requestId: 'own-health', action: 'get' })
    expect(own).toMatchObject({ data: { nodes: [{ nodeId: 'worker' }] } })
    await expect(context.service.callNodeActionTool('alpha', worker(running).sessionId!, 'super_agent_health', { requestId: 'other-health', action: 'get', nodeId: 'main' })).rejects.toThrow('own health only')
  })

  test('restart retains a consumed preparation budget and never restarts an exhausted attempt', async () => {
    const context = await superAgentFixture()
    context.config.execution = { connectionConcurrency: 30, connectionCallsPerMinute: 600, stallMinutes: 15, maxResumeAttempts: 3, preparationMaxRetries: 0 }
    context.host.applySessionPolicy = async () => new Promise<void>(() => {})
    await queue(context)
    await until(() => context.service.get('alpha'), snapshot => worker(snapshot).preparation?.stage === 'policy')
    await context.service.cleanup()
    const restarted = new SuperAgentService({ host: context.host, rootForWorkspace: id => join(context.root, id), now: context.now, autoTick: false })
    try {
      const snapshot = await restarted.get('alpha')
      expect(worker(snapshot).preparation).toMatchObject({ attempt: 1, status: 'failed', cleanupPending: false })
      await restarted.tick()
      expect(context.host.sends).toHaveLength(0)
      expect((await loadSuperAgentDocument(join(context.root, 'alpha'))).pendingTurns.find(turn => turn.nodeId === 'worker')!.preparationAttempt).toBe(1)
    } finally { await restarted.cleanup() }
  })

  test('rebuilding another worker does not reset an exhausted preparation budget', async () => {
    const context = await superAgentFixture()
    context.config.nodes.push({ ...context.config.nodes[1]!, id: 'other' })
    context.config.execution = { connectionConcurrency: 30, connectionCallsPerMinute: 600, stallMinutes: 15, maxResumeAttempts: 3, preparationMaxRetries: 0 }
    await context.service.save('alpha', context.config)
    await context.service.command('alpha', { type: 'task', id: 'other-task', title: 'Other', instructions: 'Continue', nodeId: 'other' })
    await until(() => context.service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    context.host.applySessionPolicy = async () => new Promise<void>(() => {})
    await context.service.command('alpha', { type: 'task', id: 'preparing-task', title: 'Prepare', instructions: 'Continue', nodeId: 'worker' })
    await until(() => context.service.get('alpha'), value => worker(value).preparation?.stage === 'policy')
    await context.service.cleanup()
    const restarted = new SuperAgentService({ host: context.host, rootForWorkspace: id => join(context.root, id), now: context.now, autoTick: false })
    try {
      await restarted.get('alpha')
      const snapshot = await until(() => restarted.get('alpha'), value => value.recovery?.phase === 'ready')
      expect(worker(snapshot).preparation).toMatchObject({ attempt: 1, status: 'failed', cleanupPending: false })
      const saved = await loadSuperAgentDocument(join(context.root, 'alpha'))
      expect(saved.pendingTurns.find(turn => turn.taskId === 'preparing-task')?.preparationAttempt).toBe(1)
      expect(context.host.sends).toHaveLength(1)
    } finally { await restarted.cleanup() }
  })

  test('cancels a cooperative policy wait and retries the original task without consuming a model call', async () => {
    const context = await superAgentFixture()
    let calls = 0
    context.host.applySessionPolicy = async (_id: string, _policy: SuperAgentSessionPolicy, options?: SuperAgentPreparationOptions) => {
      if (_policy.role === 'worker' && ++calls === 1) await awaitSuperAgentPreparation(new Promise<void>(() => {}), options?.signal)
    }
    await queue(context)
    await until(() => context.service.get('alpha'), snapshot => worker(snapshot).preparation?.stage === 'policy' && calls === 1)
    context.advance(10_001); await context.service.tick()
    const failed = await until(() => context.service.get('alpha'), snapshot => worker(snapshot).preparation?.status === 'retrying')
    expect(worker(failed).preparation).toMatchObject({ attempt: 1, stage: 'policy', cleanupPending: false })
    expect(failed.state.metrics?.modelTurns ?? 0).toBe(0)
    expect(context.host.sends).toHaveLength(0)
    const before = await loadSuperAgentDocument(join(context.root, 'alpha'))
    const original = before.pendingTurns.find(turn => turn.nodeId === 'worker')!
    expect(original.startedAt).toBeUndefined()
    context.advance(5_001); await context.service.tick()
    const running = await until(() => context.service.get('alpha'), snapshot => worker(snapshot).status === 'working')
    expect(running.state.tasks).toHaveLength(1)
    const after = await loadSuperAgentDocument(join(context.root, 'alpha'))
    expect(after.pendingTurns.find(turn => turn.nodeId === 'worker')!.id).toBe(original.id)
    expect(worker(running).preparation).toMatchObject({ attempt: 2, status: 'completed' })
    expect(context.host.sends.filter(send => send.sessionId === worker(running).sessionId)).toHaveLength(1)
  })

  test('quarantines a noncooperative settings wait and ignores its late result before safe retry', async () => {
    const context = await superAgentFixture()
    const gate = deferred()
    let calls = 0
    context.host.ensureSuperAgentSessionSettings = async (id) => { if (context.host.options.get(id)?.name?.endsWith('worker') && ++calls === 1) await gate.promise }
    await queue(context)
    await until(() => context.service.get('alpha'), snapshot => worker(snapshot).preparation?.stage === 'settings' && calls === 1)
    context.advance(10_001); await context.service.tick()
    const failed = await until(() => context.service.get('alpha'), snapshot => worker(snapshot).preparation?.cleanupPending === true)
    expect(worker(failed).status).toBe('error')
    await expect(context.service.command('alpha', { type: 'node-recover', nodeId: 'worker' })).rejects.toThrow('still stopping')
    await expect(context.service.command('alpha', { type: 'node-reset', nodeId: 'worker', confirmed: true })).rejects.toThrow('still stopping')
    context.advance(120_000); await context.service.tick()
    expect(calls).toBe(1)
    expect(context.host.sends.filter(send => send.sessionId === worker(failed).sessionId)).toHaveLength(0)
    gate.resolve()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(context.host.sends.filter(send => send.sessionId === worker(failed).sessionId)).toHaveLength(0)
    await context.service.tick()
    await until(() => context.service.get('alpha'), snapshot => worker(snapshot).status === 'working')
    expect(calls).toBe(2)
    expect(context.host.sends.filter(send => send.sessionId === worker(failed).sessionId)).toHaveLength(1)
  })

  test('stops at the retry budget; explicit retry preserves the original task', async () => {
    const context = await superAgentFixture()
    let calls = 0
    let broken = true
    context.host.applySessionPolicy = async (_id, policy) => { if (policy.role === 'worker') { calls++; if (broken) throw new Error('Injected policy failure') } }
    await queue(context)
    for (let attempt = 1; attempt <= 3; attempt++) {
      await until(() => context.service.get('alpha'), snapshot => worker(snapshot).preparation?.attempt === attempt && ['retrying', 'failed'].includes(worker(snapshot).preparation!.status))
      context.advance(30_001); await context.service.tick()
    }
    expect(calls).toBe(3)
    expect(context.host.sends.filter(send => send.sessionId === context.host.sessions.keys().next().value)).toHaveLength(0)
    expect(worker(await context.service.get('alpha')).preparation?.status).toBe('failed')
    broken = false
    await context.service.command('alpha', { type: 'node-recover', nodeId: 'worker' })
    const running = await until(() => context.service.get('alpha'), snapshot => worker(snapshot).status === 'working')
    expect(running.state.tasks).toHaveLength(1)
    expect(worker(running).preparation?.attempt).toBe(1)
  })

  test('user stop cancels preparation and a late completion cannot send or resurrect the task', async () => {
    const context = await superAgentFixture()
    const gate = deferred()
    let calls = 0
    context.host.applySessionPolicy = async () => { calls++; await gate.promise }
    await queue(context)
    const snapshot = await until(() => context.service.get('alpha'), snapshot => calls === 1 && worker(snapshot).preparation?.stage === 'policy')
    await context.service.command('alpha', { type: 'cancel' })
    gate.resolve()
    await new Promise(resolve => setTimeout(resolve, 10))
    context.advance(600_000); await context.service.tick()
    const stopped = await context.service.get('alpha')
    expect(stopped.state.tasks[0]!.id).toBe(snapshot.state.tasks[0]!.id)
    expect(stopped.state.tasks[0]!.status).toBe('cancelled')
    expect(context.host.sends).toHaveLength(0)
    expect(worker(stopped).status).not.toBe('preparing')
  })

  test('uses the separate container deadline and keeps polling responsive during an environment stall', async () => {
    const gate = deferred<{ workingDirectory: string; status: { available: boolean; isolation: 'container'; detail: string } }>()
    let environmentStarted = false
    const context = await superAgentFixture({ prepareEnvironment: () => { environmentStarted = true; return gate.promise } })
    context.config.environment = { ...context.config.environment, kind: 'sandbox', sandbox: { runtime: 'docker', image: 'test-image' } }
    await queue(context)
    const preparing = await until(() => context.service.get('alpha'), snapshot => worker(snapshot).preparation?.stage === 'environment' && environmentStarted)
    expect(worker(preparing).preparation!.deadlineAt - worker(preparing).preparation!.startedAt).toBe(600_000)
    context.advance(599_000); await context.service.tick()
    expect(worker(await context.service.get('alpha')).status).toBe('preparing')
    context.advance(1001); await context.service.tick()
    await until(() => context.service.get('alpha'), snapshot => worker(snapshot).preparation?.cleanupPending === true)
    gate.resolve({ workingDirectory: context.workingDirectory, status: { available: true, isolation: 'container', detail: 'ready' } })
    expect(context.host.sends).toHaveLength(0)
  })
})
