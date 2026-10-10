import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSuperAgentDocument, saveSuperAgentDocument } from '@craft-agent/shared/super-agent'
import { superAgentFixture, until } from './SuperAgentTestSupport'

const block = (value: unknown) => `<super_agent_actions>${JSON.stringify(value)}</super_agent_actions>`

async function fixture(running = false, sourceAccepted = true) {
  const f = await superAgentFixture()
  f.config.nodes.push({ ...f.config.nodes[1]!, id: 'verifier' })
  const document = await loadSuperAgentDocument(join(f.root, 'alpha'))
  document.config = f.config
  document.state.nodes = f.config.nodes.map(node => ({ nodeId: node.id, status: 'idle' }))
  document.state.plans = [{ id: 'plan', title: 'Report', instructions: 'Produce a verified report', status: 'active', priority: 1, note: '', revision: 1, updatedBy: 'main', updatedAt: 100 }]
  const base = { planId: 'plan', title: 'Report', instructions: 'Keep verified findings', status: 'completed' as const, createdAt: 100, output: 'Recorded findings' }
  document.state.tasks = [
    { ...base, id: 'source', nodeId: 'worker', requiresIndependentReview: true, acceptance: { status: sourceAccepted ? 'accepted' : 'rejected', evidenceTaskId: 'review', note: 'Original acceptance', reviewedBy: 'main', reviewedAt: 200 } },
    { ...base, id: 'review', nodeId: 'verifier', reviewOf: 'source', dependsOn: ['source'] },
    { ...base, id: 'integration', nodeId: 'worker', dependsOn: ['source'], startedAt: 300, acceptance: { status: 'accepted', evidenceTaskId: 'integration', note: 'Downstream acceptance', reviewedBy: 'main', reviewedAt: 400 } },
    { ...base, id: 'delivery', nodeId: 'worker', dependsOn: ['integration'], startedAt: 400, acceptance: { status: 'accepted', evidenceTaskId: 'delivery', note: 'Final acceptance', reviewedBy: 'main', reviewedAt: 500 } },
    { ...base, id: 'queued', nodeId: 'worker', status: 'queued', dependsOn: ['source'] },
    { ...base, id: 'other-review', nodeId: 'verifier', reviewOf: 'source', dependsOn: ['source'] },
  ]
  let workerSessionId: string | undefined
  if (running) {
    const worker = await f.host.createSession('alpha', {})
    workerSessionId = worker.id
    f.host.sessions.get(worker.id)!.isProcessing = true
    document.state.nodes[1] = { nodeId: 'worker', status: 'working', activeTaskId: 'integration', sessionId: worker.id }
    document.state.tasks[2]!.status = 'running'
    document.state.tasks[2]!.checkpoint = { revision: 1, completedSteps: ['Read source'], nextStep: 'Verify report', note: '', updatedAt: 300 }
    document.state.operations = [{ id: 'inflight', key: 'a'.repeat(64), taskId: 'integration', turnId: 'integration-turn', nodeId: 'worker', sessionId: worker.id, invocationId: 'pending-call', toolName: 'Bash', status: 'running', createdAt: 300, updatedAt: 300 }]
    document.pendingTurns.push({ id: 'integration-turn', nodeId: 'worker', kind: 'task', taskId: 'integration', text: 'Integrate source', depth: 1, chainId: 'integration-chain', createdAt: 300, startedAt: 300 })
  }
  await saveSuperAgentDocument(join(f.root, 'alpha'), document)
  await f.service.get('alpha')
  await f.service.command('alpha', { type: 'chat', text: 'Reconcile the source review' })
  const active = await until(() => f.service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
  return { ...f, sessionId: active.state.nodes[0]!.sessionId!, workerSessionId }
}

describe('Corrections to accepted evidence', () => {
  test('rejects mistaken acceptance, invalidates transitive results and still delivers the following message', async () => {
    const f = await fixture()
    f.host.complete(f.sessionId, block({ acceptances: [{ taskId: 'source', evidenceTaskId: 'review', status: 'rejected', note: 'Source coverage was incomplete' }], messages: [{ toNodeId: 'worker', body: 'Preserve valid findings and report missing coverage' }] }))
    const result = await until(() => f.service.get('alpha'), value => value.state.tasks[0]?.acceptance?.status === 'rejected')
    expect(result.state.tasks[1]!.acceptance).toBeUndefined()
    expect(result.state.tasks[2]!.acceptance?.status).toBe('stale')
    expect(result.state.tasks[3]!.acceptance?.status).toBe('stale')
    expect(result.state.tasks[2]!.output).toBe('Recorded findings')
    expect(result.state.tasks[4]!.status).toBe('queued')
    expect(result.state.plans[0]!.status).toBe('blocked')
    expect(result.state.messages.some(message => message.body === 'Preserve valid findings and report missing coverage')).toBe(true)
    expect(result.state.messages.findLast(message => message.actionReceipt)?.actionReceipt?.status).toBe('applied')
    expect((await loadSuperAgentDocument(join(f.root, 'alpha'))).state.tasks[3]!.acceptance?.status).toBe('stale')
  })

  test('stops an active dependent, preserves its checkpoint and cannot resurrect it through a late completion', async () => {
    const f = await fixture(true)
    f.host.complete(f.sessionId, block({ acceptances: [{ taskId: 'source', evidenceTaskId: 'review', status: 'rejected', note: 'Incomplete source qualification' }] }))
    const result = await until(() => f.service.get('alpha'), value => value.state.tasks[0]?.acceptance?.status === 'rejected' && value.state.tasks[2]?.status === 'failed')
    expect(f.host.cancelled).toContain(f.workerSessionId!)
    expect(result.state.tasks[2]!.checkpoint?.completedSteps).toEqual(['Read source'])
    expect(result.state.tasks[2]!.acceptance?.status).toBe('stale')
    f.host.complete(f.workerSessionId!, 'Late success should not be applied')
    f.advance(1001); await f.service.tick()
    const saved = await loadSuperAgentDocument(join(f.root, 'alpha'))
    expect(saved.state.tasks[2]!.status).toBe('failed')
    expect(saved.state.operations![0]!.status).toBe('unknown')
    expect(saved.state.tasks[2]!.phase).toBe('outcome-unknown')
    expect(saved.pendingTurns.some(turn => turn.taskId === 'integration')).toBe(false)
    expect(saved.state.tasks[4]!.status).toBe('queued')
  })

  test('repeating acceptance of the same evidence is idempotent even after downstream dispatch', async () => {
    const f = await fixture()
    f.host.complete(f.sessionId, block({ acceptances: [{ taskId: 'source', evidenceTaskId: 'review', status: 'accepted', note: 'Original acceptance' }] }))
    const result = await until(() => f.service.get('alpha'), value => value.state.messages.some(message => message.actionReceipt))
    expect(result.state.messages.findLast(message => message.actionReceipt)?.actionReceipt?.status).toBe('applied')
    expect(result.state.tasks[0]!.acceptance?.reviewedAt).toBe(200)
    expect(result.state.tasks[2]!.acceptance?.status).toBe('accepted')
  })

  test('replacing evidence after downstream dispatch still requires a versioned task', async () => {
    const f = await fixture()
    f.host.complete(f.sessionId, block({ acceptances: [{ taskId: 'source', evidenceTaskId: 'other-review', status: 'accepted', note: 'Replacement evidence' }] }))
    const result = await until(() => f.service.get('alpha'), value => value.state.messages.some(message => message.actionReceipt?.status === 'rejected'))
    expect(result.state.tasks[0]!.acceptance?.evidenceTaskId).toBe('review')
    expect(result.state.messages.findLast(message => message.actionReceipt)?.actionReceipt?.rejected?.error).toContain('new versioned task')
  })

  test('a downstream result cannot be accepted while its source acceptance is rejected', async () => {
    const f = await fixture(false, false)
    f.host.complete(f.sessionId, block({ acceptances: [{ taskId: 'integration', evidenceTaskId: 'integration', status: 'accepted', note: 'Ignore rejected upstream' }] }))
    const result = await until(() => f.service.get('alpha'), value => value.state.messages.some(message => message.actionReceipt?.status === 'rejected'))
    expect(result.state.tasks[2]!.acceptance?.reviewedAt).toBe(400)
    expect(result.state.messages.findLast(message => message.actionReceipt)?.actionReceipt?.rejected?.error).toContain('unaccepted dependency')
  })
})
