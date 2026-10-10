import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSuperAgentDocument, saveSuperAgentDocument } from '@craft-agent/shared/super-agent'
import { superAgentFixture, until } from './SuperAgentTestSupport'

async function queued(reason: 'goal' | 'cancelled' | 'waiting' | 'ready') {
  const f = await superAgentFixture()
  const document = await loadSuperAgentDocument(join(f.root, 'alpha'))
  document.config = { ...f.config, continuousWork: true }
  document.state.lastUserActivityAt = f.now()
  document.state.nodes = f.config.nodes.map(node => ({ nodeId: node.id, status: 'idle' }))
  document.state.intents = [{ id: 'goal', revision: 3, status: 'active', goal: 'Current request', constraints: [], deliverables: [], acceptanceCriteria: [], createdAt: 1, sourceTurnId: 'user-turn' }]
  document.state.tasks = [
    { id: 'source', title: 'Source research', instructions: '', nodeId: 'worker', status: reason === 'cancelled' ? 'cancelled' : reason === 'waiting' ? 'failed' : 'completed', createdAt: 1 },
    { id: 'queued', title: 'Continue research', instructions: 'Only remaining work', nodeId: 'worker', status: 'queued', goalId: 'goal', goalRevision: reason === 'goal' ? 1 : 3, dependsOn: reason === 'ready' ? [] : ['source'], createdAt: 1 },
  ]
  document.pendingTurns = [{ id: 'turn', nodeId: 'worker', kind: 'task', text: 'Continue', taskId: 'queued', createdAt: 1, depth: 4, chainId: 'old-chain' }]
  await saveSuperAgentDocument(join(f.root, 'alpha'), document)
  await f.service.get('alpha')
  return f
}

for (const reason of ['goal', 'cancelled'] as const) test(`retires an impossible ${reason} queue once and asks the planner to reconcile`, async () => {
  const f = await queued(reason)
  await f.service.tick()
  await until(() => f.service.get('alpha'), () => f.host.sends.length === 1)
  const state = (await f.service.get('alpha')).state
  expect(state.tasks.find(task => task.id === 'queued')?.status).toBe('cancelled')
  expect(f.host.sends[0]!.message).toContain('Retired obsolete queued tasks')
  const saved = await loadSuperAgentDocument(join(f.root, 'alpha'))
  expect(saved.pendingTurns.some(turn => turn.taskId === 'queued')).toBe(false)
  expect(saved.pendingTurns[0]!.depth).toBe(0)
  await f.service.tick()
  expect(f.host.sends).toHaveLength(1)
})

test('failed dependencies stay queued without suppressing continuous idle inspection', async () => {
  const f = await queued('waiting')
  await f.service.tick()
  expect(f.host.sends).toHaveLength(0)
  expect((await f.service.get('alpha')).state.tasks[1]!.status).toBe('queued')
  f.advance(60_001)
  await f.service.tick()
  await until(() => f.service.get('alpha'), () => f.host.sends.length === 1)
  expect(f.host.sends[0]!.message).toContain('后台自检')
  expect((await f.service.get('alpha')).state.tasks[1]!.status).toBe('queued')
})

test('a valid queued task dispatches normally and does not trigger idle inspection', async () => {
  const f = await queued('ready')
  await f.service.tick()
  await until(() => f.service.get('alpha'), () => f.host.sends.length === 1)
  expect((await f.service.get('alpha')).state.tasks[1]!.status).toBe('running')
  f.advance(60_001)
  await f.service.tick()
  expect(f.host.sends).toHaveLength(1)
})
