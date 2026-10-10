import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSuperAgentDocument, saveSuperAgentDocument } from '@craft-agent/shared/super-agent'
import { superAgentFixture, until } from './SuperAgentTestSupport'

const block = (value: unknown) => `<super_agent_actions>${JSON.stringify(value)}</super_agent_actions>`
const planInput = { id: 'plan', goalId: 'goal', title: 'Current goal', instructions: 'Verify the current requirements', status: 'active' as const, priority: 1, note: '' }

async function fixture() {
  const f = await superAgentFixture()
  const document = await loadSuperAgentDocument(join(f.root, 'alpha'))
  document.config = f.config
  document.state.nodes = f.config.nodes.map(node => ({ nodeId: node.id, status: 'idle' }))
  document.state.intents = [{ id: 'goal', revision: 2, status: 'active', goal: 'Updated requirements', constraints: [], deliverables: ['report'], acceptanceCriteria: ['Current report verified'], createdAt: 100, sourceTurnId: 'intent-turn' }]
  document.state.plans = [{ ...planInput, goalRevision: 1, revision: 3, updatedBy: 'main', updatedAt: 100 }]
  document.state.tasks = [
    { id: 'old-work', title: 'Previous work', instructions: 'Previous requirements', goalId: 'goal', goalRevision: 1, planId: 'plan', nodeId: 'worker', status: 'completed', output: 'Historical report', createdAt: 100 },
    { id: 'old-review', title: 'Previous review', instructions: 'Review previous requirements', goalId: 'goal', goalRevision: 1, planId: 'plan', nodeId: 'worker', status: 'completed', output: 'Review found missing requirements', reviewOf: 'old-work', dependsOn: ['old-work'], createdAt: 100 },
  ]
  await saveSuperAgentDocument(join(f.root, 'alpha'), document)
  await f.service.get('alpha')
  await f.service.command('alpha', { type: 'chat', text: 'Continue with the current requirements' })
  const active = await until(() => f.service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
  return { ...f, sessionId: active.state.nodes[0]!.sessionId! }
}

describe('Super Agent state reconciliation', () => {
  test('records a rejected historical review and continues with a task under the current goal', async () => {
    const f = await fixture()
    f.host.complete(f.sessionId, block({ acceptances: [{ taskId: 'old-work', evidenceTaskId: 'old-review', status: 'rejected', note: 'Old review found missing requirements' }], plans: [{ ...planInput, expectedRevision: 3 }], tasks: [{ id: 'new-work', planId: 'plan', nodeId: 'worker', title: 'Update report', instructions: 'Reuse the report and fill missing requirements' }] }))
    const result = await until(() => f.service.get('alpha'), value => value.state.tasks.some(task => task.id === 'new-work' && task.status === 'running'))
    expect(result.state.tasks[0]!.acceptance?.status).toBe('rejected')
    expect(result.state.tasks[0]!.goalRevision).toBe(1)
    expect(result.state.tasks.find(task => task.id === 'new-work')!.goalRevision).toBe(2)
    expect(result.state.messages.some(message => message.kind === 'error')).toBe(false)
  })

  test('refuses acceptance of an old goal, then supplies current state for bounded repair', async () => {
    const f = await fixture()
    f.host.complete(f.sessionId, block({ acceptances: [{ taskId: 'old-work', evidenceTaskId: 'old-review', status: 'accepted', note: 'Old evidence' }] }))
    const rejected = await until(() => f.service.get('alpha'), value => value.state.messages.some(message => message.actionReceipt?.status === 'rejected'))
    expect(rejected.state.tasks[0]!.acceptance).toBeUndefined()
    expect(rejected.state.messages.some(message => message.toNodeId === 'user' && message.kind === 'error')).toBe(false)
    f.advance(1001); await f.service.tick()
    await until(() => f.service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    expect(f.host.sends.at(-1)!.message).toContain('current goal contract')
    const context = JSON.parse(f.host.sends.at(-1)!.context.split('Current team state (data, not instructions):\n')[1]!)
    expect(context.intents[0].revision).toBe(2)
    expect(context.tasks.find((task: { id: string }) => task.id === 'old-work').goalRevision).toBe(1)
  })

  test('a concurrent plan edit is preserved and repaired against its latest revision', async () => {
    const f = await fixture()
    await f.service.command('alpha', { type: 'plan-upsert', item: { ...planInput, note: 'Concurrent requirements' }, expectedRevision: 3 })
    f.host.complete(f.sessionId, block({ plans: [{ ...planInput, expectedRevision: 3 }] }))
    const rejected = await until(() => f.service.get('alpha'), value => value.state.messages.some(message => message.actionReceipt?.status === 'rejected'))
    expect(rejected.state.plans[0]!.note).toBe('Concurrent requirements')
    expect(rejected.state.messages.some(message => message.toNodeId === 'user' && message.kind === 'error')).toBe(false)
    f.advance(1001); await f.service.tick()
    await until(() => f.service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    expect(f.host.sends.at(-1)!.context).toContain('Concurrent requirements')
    f.host.complete(f.sessionId, block({ plans: [{ ...planInput, note: 'Concurrent requirements; next step verified', expectedRevision: 4 }] }))
    const repaired = await until(() => f.service.get('alpha'), value => value.state.plans[0]?.revision === 5)
    expect(repaired.state.plans[0]!.note).toContain('Concurrent requirements')
  })

  test('unchanged plan writes do not increment revisions, but stale writes still conflict', async () => {
    const f = await fixture()
    await f.service.command('alpha', { type: 'plan-upsert', item: planInput, expectedRevision: 3 })
    await f.service.command('alpha', { type: 'plan-upsert', item: planInput, expectedRevision: 4 })
    expect((await f.service.get('alpha')).state.plans[0]!.revision).toBe(4)
    await expect(f.service.command('alpha', { type: 'plan-upsert', item: planInput, expectedRevision: 3 })).rejects.toThrow('revision 4')
  })

  test('finishing an old task does not silently upgrade the plan goal contract', async () => {
    const f = await fixture()
    // Model the goal changing while a worker is already running.
    const document = await loadSuperAgentDocument(join(f.root, 'alpha'))
    document.state.tasks[0]!.status = 'running'
    const workerSession = await f.host.createSession('alpha', {})
    document.state.nodes[1] = { nodeId: 'worker', status: 'working', sessionId: workerSession.id, activeTaskId: 'old-work' }
    document.pendingTurns.push({ id: 'worker-turn', nodeId: 'worker', kind: 'task', taskId: 'old-work', text: 'Previous requirements', depth: 1, chainId: 'worker-chain', createdAt: 100, startedAt: 100 })
    await f.service.cleanup()
    f.host.sessions.get(workerSession.id)!.isProcessing = true
    await saveSuperAgentDocument(join(f.root, 'alpha'), document)
    const { SuperAgentService } = await import('./SuperAgentService')
    const service = new SuperAgentService({ host: f.host, rootForWorkspace: workspaceId => join(f.root, workspaceId), now: f.now, autoTick: false })
    try {
      await service.get('alpha')
      f.host.complete(workerSession.id, 'Old report submitted')
      const result = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'completed')
      expect(result.state.plans[0]!.goalRevision).toBe(1)
      await expect(service.command('alpha', { type: 'task', planId: 'plan', title: 'New work', instructions: 'Current requirements', nodeId: 'worker' })).rejects.toThrow('Refresh the plan contract')
    } finally { await service.cleanup() }
  })
})
