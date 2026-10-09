import { expect, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SuperAgentService } from './SuperAgentService'
import { SuperAgentTestHost, superAgentFixture, until } from './SuperAgentTestSupport'
import { loadSuperAgentDocument, saveSuperAgentDocument, superAgentDependencySatisfied, withSuperAgentOrchestrator } from '@craft-agent/shared/super-agent'

async function running(f: Awaited<ReturnType<typeof superAgentFixture>>, id = 'job') {
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'task', id, title: 'Work', instructions: 'Continue the original authorized task', nodeId: 'worker' })
  const snapshot = await until(() => f.service.get('alpha'), state => state.state.tasks.some(task => task.id === id && task.status === 'running') && f.host.sends.length > 0)
  return { task: snapshot.state.tasks.find(task => task.id === id)!, sessionId: f.host.sends.at(-1)!.sessionId }
}
const checkpoint = (taskId: string, nextStep = 'Build the report', revision = 0) => ({ action: 'checkpoint', taskId, expectedRevision: revision, completedSteps: [], nextStep })
const actions = (value: unknown) => `<super_agent_actions>${JSON.stringify(value)}</super_agent_actions>`
async function finishNode(f: Awaited<ReturnType<typeof superAgentFixture>>, nodeId: string, text: string) {
  f.advance(2000); await f.service.tick()
  const active = await until(() => f.service.get('alpha'), state => state.state.nodes.some(node => node.nodeId === nodeId && node.status === 'working'
    && f.host.sends.some(send => send.sessionId === node.sessionId)))
  f.host.complete(active.state.nodes.find(node => node.nodeId === nodeId)!.sessionId!, text)
  return f.service.get('alpha')
}

test('checkpoints are versioned, persist mid-turn, preserve completed steps, and cannot be written by another node', async () => {
  const f = await superAgentFixture()
  f.config.nodes.push({ ...f.config.nodes[1]!, id: 'other' })
  const job = await running(f)
  await f.service.updateNodeTask('alpha', job.sessionId, { ...checkpoint('job'), completedSteps: ['Inputs verified'] })
  const saved = await loadSuperAgentDocument(join(f.root, 'alpha'))
  expect(saved.state.tasks[0]!.checkpoint).toMatchObject({ revision: 1, completedSteps: ['Inputs verified'] })
  await expect(f.service.updateNodeTask('alpha', job.sessionId, checkpoint('job'))).rejects.toThrow('Checkpoint changed')
  await expect(f.service.updateNodeTask('alpha', job.sessionId, checkpoint('job', 'Next', 1))).rejects.toThrow('discarded')
  await f.service.command('alpha', { type: 'task', id: 'other-job', title: 'Other', instructions: 'Independent work', nodeId: 'other' })
  const other = await until(() => f.service.get('alpha'), () => f.host.sends.length === 2)
  await expect(f.service.updateNodeTask('alpha', other.state.tasks.find(task => task.id === 'other-job')!.sessionId!, checkpoint('job'))).rejects.toThrow('assigned')
})

test('waiting on a board revision resumes the same task from its checkpoint and preserves visible instructions', async () => {
  const f = await superAgentFixture(); f.config.continuousWork = true
  const job = await running(f)
  await f.service.updateNodeTask('alpha', job.sessionId, checkpoint('job'))
  await f.service.updateNodeTask('alpha', job.sessionId, { action: 'wait', taskId: 'job', reason: 'Need verified input', condition: { kind: 'board', itemId: 'input', afterRevision: 0 } })
  f.host.complete(job.sessionId, 'Waiting for the declared input')
  await until(() => f.service.get('alpha'), state => state.state.tasks[0]!.phase === 'waiting' && state.state.tasks[0]!.status === 'queued')
  f.advance(5000); await f.service.tick()
  expect(f.host.sends.filter(send => send.sessionId === job.sessionId)).toHaveLength(1)
  await f.service.command('alpha', { type: 'board-upsert', item: { id: 'input', title: 'Input', content: 'Verified input' }, expectedRevision: 0 })
  f.advance(5000); await f.service.tick()
  const resumed = await until(() => f.service.get('alpha'), state => state.state.metrics?.resumptions === 1 && f.host.sends.filter(send => send.sessionId === job.sessionId).length === 2)
  expect(resumed.state.tasks).toHaveLength(1)
  expect(f.host.sends.at(-1)!.message).toBe(job.task.instructions)
  expect(f.host.sends.at(-1)!.context).toContain('Build the report')
})

test('restart resumes a checkpoint with no unsettled side effects but never replays an unknown operation', async () => {
  for (const unknown of [false, true]) {
    const f = await superAgentFixture(); f.config.continuousWork = true
    const job = await running(f)
    await f.service.updateNodeTask('alpha', job.sessionId, checkpoint('job'))
    if (unknown) await f.service.prepareNodeOperation('alpha', job.sessionId, { toolName: 'mcp__mail__send_email', input: { body: 'secret-payload' }, invocationId: 'send-1' })
    await f.service.cleanup()
    const host = new SuperAgentTestHost()
    const restarted = new SuperAgentService({ host, rootForWorkspace: id => join(f.root, id), autoTick: false })
    try {
      const snapshot = await restarted.get('alpha')
      if (unknown) {
        expect(snapshot.state.tasks[0]!.status).toBe('failed')
        expect(snapshot.state.operations![0]!.status).toBe('unknown')
        await expect(restarted.command('alpha', { type: 'task-resume', taskId: 'job' })).rejects.toThrow('unknown operation')
        expect(host.sends).toHaveLength(0)
      } else {
        await until(() => restarted.get('alpha'), () => host.sends.length > 0)
        expect(host.sends[0]!.message).toBe(job.task.instructions)
        expect(host.sends[0]!.context).toContain('Build the report')
      }
    } finally { await restarted.cleanup() }
  }
})

test('durable operation identities suppress completed/unknown replays and do not persist raw arguments', async () => {
  const f = await superAgentFixture(); const job = await running(f)
  await f.service.updateNodeTask('alpha', job.sessionId, checkpoint('job'))
  const operation = { toolName: 'mcp__mail__send_email', input: { body: 'do-not-persist-secret', to: 'customer' }, invocationId: 'send-1' }
  await f.service.prepareNodeOperation('alpha', job.sessionId, operation)
  await f.service.prepareNodeOperation('alpha', job.sessionId, operation) // Provider precheck retry before dispatch.
  await expect(f.service.prepareNodeOperation('alpha', job.sessionId, { ...operation, invocationId: 'send-2' })).rejects.toThrow('prepared')
  f.host.emit({ type: 'tool_result', sessionId: job.sessionId, toolUseId: 'send-1', toolName: operation.toolName, result: 'Message sent' })
  const snapshot = await until(() => f.service.get('alpha'), state => state.state.operations?.[0]?.status === 'completed')
  expect(snapshot.state.operations).toHaveLength(1)
  await expect(f.service.prepareNodeOperation('alpha', job.sessionId, { ...operation, invocationId: 'send-3' })).rejects.toThrow('completed')
  const stored = await readFile(join(f.root, 'alpha', 'super-agent', 'state.json'), 'utf8')
  expect(stored).not.toContain('do-not-persist-secret')
  await f.service.updateNodeTask('alpha', job.sessionId, { ...checkpoint('job', 'Send the separately requested second message', 1), completedSteps: ['First message sent'] })
  await f.service.prepareNodeOperation('alpha', job.sessionId, { ...operation, invocationId: 'send-4' })
  expect((await f.service.get('alpha')).state.operations).toHaveLength(2)
})

test('a changed artifact invalidates its acceptance and the downstream accepted result', async () => {
  const f = await superAgentFixture(); const job = await running(f)
  const path = join(f.workingDirectory, 'report.txt'); await writeFile(path, 'version one')
  await f.service.updateNodeTask('alpha', job.sessionId, { action: 'artifact', taskId: 'job', id: 'report', path, description: 'Verified report' })
  f.host.complete(job.sessionId, 'Report submitted')
  await until(() => f.service.get('alpha'), state => state.state.tasks[0]!.status === 'completed')
  await f.service.cleanup()
  const saved = await loadSuperAgentDocument(join(f.root, 'alpha'))
  const task = saved.state.tasks[0]!
  task.acceptance = { status: 'accepted', evidenceTaskId: task.id, note: 'Checked v1', reviewedBy: 'main', reviewedAt: 1 }
  saved.state.tasks.push({ ...task, id: 'downstream', dependsOn: ['job'], artifactIds: [], acceptance: { ...task.acceptance, evidenceTaskId: 'downstream' } })
  await saveSuperAgentDocument(join(f.root, 'alpha'), saved)
  await writeFile(path, 'version two')
  const restarted = new SuperAgentService({ host: new SuperAgentTestHost(), rootForWorkspace: id => join(f.root, id), autoTick: false })
  try {
    await restarted.get('alpha'); await restarted.tick()
    const changed = await restarted.get('alpha')
    expect(changed.state.tasks.map(task => task.acceptance?.status)).toEqual(['stale', 'stale'])
    expect(superAgentDependencySatisfied(changed.state.tasks[0]!)).toBe(false)
    expect(changed.state.artifacts![0]!.revision).toBe(2)
  } finally { await restarted.cleanup() }
})

test('connection concurrency and rate budgets apply across different workers', async () => {
  const f = await superAgentFixture()
  f.config.nodes.push({ ...f.config.nodes[1]!, id: 'second' })
  f.config.execution = { connectionConcurrency: 1, connectionCallsPerMinute: 1, stallMinutes: 60, maxResumeAttempts: 3 }
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'task', id: 'first', title: 'First', instructions: 'First work', nodeId: 'worker' })
  await f.service.command('alpha', { type: 'task', id: 'second-job', title: 'Second', instructions: 'Second work', nodeId: 'second' })
  await until(() => f.service.get('alpha'), () => f.host.sends.length === 1)
  expect((await f.service.get('alpha')).state.tasks.filter(task => task.status === 'running')).toHaveLength(1)
  f.host.complete(f.host.sends[0]!.sessionId, 'Done')
  await f.service.get('alpha'); f.advance(5000); await f.service.tick()
  expect(f.host.sends).toHaveLength(1)
  f.advance(60_000); await f.service.tick()
  await until(() => f.service.get('alpha'), () => f.host.sends.length === 2)
})

test('capability requirements select a matching worker and reject an explicit mismatch', async () => {
  const f = await superAgentFixture(); f.config.nodes[1]!.capabilities = ['coding']
  f.config.nodes.push({ ...f.config.nodes[1]!, id: 'tester', capabilities: ['testing'] })
  await f.service.save('alpha', f.config)
  await expect(f.service.command('alpha', { type: 'task', title: 'Verify', instructions: 'Run tests', nodeId: 'worker', requiredCapabilities: ['testing'] })).rejects.toThrow('capability')
  const snapshot = await f.service.command('alpha', { type: 'task', title: 'Verify', instructions: 'Run tests', requiredCapabilities: ['testing'] })
  expect(snapshot.state.tasks[0]!.nodeId).toBe('tester')
})

test('a corrupt compatibility snapshot recovers from the synced commit file', async () => {
  const f = await superAgentFixture(); await running(f)
  await writeFile(join(f.root, 'alpha', 'super-agent', 'state.json'), '{broken')
  const restored = await loadSuperAgentDocument(join(f.root, 'alpha'))
  expect(restored.state.tasks[0]!.id).toBe('job')
})

test('identical checkpoints and note changes cannot create a new operation stage or hide a stall', async () => {
  const f = await superAgentFixture(); const job = await running(f)
  await f.service.updateNodeTask('alpha', job.sessionId, checkpoint('job'))
  const progress = (await f.service.get('alpha')).state.tasks[0]!.lastProgressAt
  f.advance(10_000)
  await f.service.updateNodeTask('alpha', job.sessionId, { ...checkpoint('job', 'Build the report', 1), note: 'Still working' })
  const current = (await f.service.get('alpha')).state.tasks[0]!
  expect(current.checkpoint!.revision).toBe(1)
  expect(current.lastProgressAt).toBe(progress)
})

test('explicit stop removes waiting checkpoints so later conditions cannot resurrect the task', async () => {
  const f = await superAgentFixture(); f.config.continuousWork = true
  const job = await running(f)
  await f.service.updateNodeTask('alpha', job.sessionId, checkpoint('job'))
  await f.service.updateNodeTask('alpha', job.sessionId, { action: 'wait', taskId: 'job', reason: 'Need input', condition: { kind: 'time', notBefore: f.now() + 5000 } })
  f.host.complete(job.sessionId, 'Waiting')
  await until(() => f.service.get('alpha'), state => state.state.tasks[0]!.status === 'queued')
  await f.service.command('alpha', { type: 'cancel', taskId: 'job' })
  f.advance(5000); await f.service.tick()
  const stopped = (await f.service.get('alpha')).state.tasks[0]!
  expect(stopped.status).toBe('cancelled')
  expect(stopped.checkpoint).toBeUndefined()
  await expect(f.service.command('alpha', { type: 'task-resume', taskId: 'job' })).rejects.toThrow('stopped task')
  expect(f.host.sends.filter(send => send.sessionId === job.sessionId)).toHaveLength(1)
})

test('file and time waits do not poll the model and automatic resumption has a bounded attempt count', async () => {
  for (const kind of ['file', 'time'] as const) {
    const f = await superAgentFixture(); f.config.continuousWork = true
    f.config.execution = { connectionConcurrency: 4, connectionCallsPerMinute: 60, stallMinutes: 60, maxResumeAttempts: 1 }
    const job = await running(f)
    await f.service.updateNodeTask('alpha', job.sessionId, checkpoint('job'))
    const condition = kind === 'file' ? { kind, path: 'input.txt' } : { kind, notBefore: f.now() + 10_000 }
    await f.service.updateNodeTask('alpha', job.sessionId, { action: 'wait', taskId: 'job', reason: 'Await input', condition })
    f.host.complete(job.sessionId, 'Awaiting input')
    await until(() => f.service.get('alpha'), state => state.state.tasks[0]!.status === 'queued')
    f.advance(5000); await f.service.tick()
    expect(f.host.sends.filter(send => send.sessionId === job.sessionId)).toHaveLength(1)
    if (kind === 'file') await writeFile(join(f.workingDirectory, 'input.txt'), 'Ready')
    f.advance(5000); await f.service.tick()
    await until(() => f.service.get('alpha'), () => f.host.sends.filter(send => send.sessionId === job.sessionId).length === 2)
    await f.service.updateNodeTask('alpha', job.sessionId, { action: 'wait', taskId: 'job', reason: 'Another input', condition })
    f.host.complete(job.sessionId, 'Waiting again')
    await until(() => f.service.get('alpha'), state => state.state.tasks[0]!.status === 'queued')
    f.advance(5000); await f.service.tick()
    const limited = await f.service.get('alpha')
    expect(limited.state.metrics!.resumptions).toBe(1)
    expect(limited.state.tasks[0]!.phase).toBe('waiting')
    const revision = limited.state.revision
    f.advance(5000); await f.service.tick()
    expect((await f.service.get('alpha')).state.revision).toBe(revision)
    await f.service.command('alpha', { type: 'task-resume', taskId: 'job' })
    await until(() => f.service.get('alpha'), () => f.host.sends.filter(send => send.sessionId === job.sessionId).length === 3)
    await f.service.updateNodeTask('alpha', job.sessionId, { ...checkpoint('job', 'Build the second phase', 1), completedSteps: ['First phase completed'] })
    expect((await f.service.get('alpha')).state.tasks[0]!.attempt).toBe(0)
  }
})

test('a quiet active task is reported once without cancelling it or treating repeated results as progress', async () => {
  const f = await superAgentFixture(); f.config.continuousWork = true
  f.config.execution = { connectionConcurrency: 4, connectionCallsPerMinute: 60, stallMinutes: 1, maxResumeAttempts: 3 }
  const job = await running(f)
  await f.service.updateNodeTask('alpha', job.sessionId, checkpoint('job'))
  f.host.emit({ type: 'tool_result', sessionId: job.sessionId, toolUseId: 'read-1', toolName: 'Read', result: 'same data' })
  await f.service.get('alpha')
  f.advance(61_000); await f.service.tick()
  const stalled = await f.service.get('alpha')
  expect(stalled.state.metrics!.stalls).toBe(1)
  expect(stalled.state.tasks[0]!.status).toBe('running')
  expect(f.host.cancelled).toHaveLength(0)
  f.host.emit({ type: 'tool_result', sessionId: job.sessionId, toolUseId: 'read-2', toolName: 'Read', result: 'same data' })
  await f.service.get('alpha'); f.advance(61_000); await f.service.tick()
  expect((await f.service.get('alpha')).state.metrics!.stalls).toBe(1)
})

test('unknown effects retain declared resource locks while a dedicated read-only verifier can proceed', async () => {
  const f = await superAgentFixture(); f.config.nodes.push({ ...f.config.nodes[1]!, id: 'verifier' })
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'task', id: 'original', title: 'Update', instructions: 'Update record', nodeId: 'worker', resources: ['external:record'] })
  const active = await until(() => f.service.get('alpha'), state => state.state.tasks[0]!.status === 'running' && f.host.sends.length > 0)
  const sessionId = active.state.tasks[0]!.sessionId!
  await f.service.prepareNodeOperation('alpha', sessionId, { toolName: 'mcp__crm__update', input: { id: 1 }, invocationId: 'update-1' })
  f.host.complete(sessionId, 'Transport lost', 'error', { canRetry: true, errorCode: 'network_error' })
  const failed = await until(() => f.service.get('alpha'), state => state.state.tasks[0]!.status === 'failed')
  const operationId = failed.state.operations![0]!.id
  await f.service.command('alpha', { type: 'task', id: 'next', title: 'Next', instructions: 'Another update', nodeId: 'worker', resources: ['external:record'] })
  await f.service.command('alpha', { type: 'task', id: 'verify', title: 'Verify', instructions: `Read external receipt for ${operationId}`, nodeId: 'verifier' })
  const checking = await until(() => f.service.get('alpha'), state => state.state.tasks.find(task => task.id === 'verify')?.status === 'running')
  expect(checking.state.tasks.find(task => task.id === 'next')!.status).toBe('queued')
  const verifierSession = checking.state.tasks.find(task => task.id === 'verify')!.sessionId!
  await expect(f.service.updateNodeTask('alpha', verifierSession, { action: 'reconcile', operationId, evidenceTaskId: 'verify', outcome: 'completed', note: 'Checked receipt' })).rejects.toThrow('completed dedicated')
  f.host.complete(verifierSession, 'External receipt confirms the update')
  await until(() => f.service.get('alpha'), state => state.state.tasks.find(task => task.id === 'verify')!.status === 'completed')
  f.advance(2000)
  await f.service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'verifier', body: 'Record the verified outcome' })
  await until(() => f.service.get('alpha'), () => f.host.sends.filter(send => send.sessionId === verifierSession).length === 2)
  await f.service.updateNodeTask('alpha', verifierSession, { action: 'reconcile', operationId, evidenceTaskId: 'verify', outcome: 'completed', note: 'External receipt confirms the update' })
  await f.service.tick()
  const reconciled = await until(() => f.service.get('alpha'), state => state.state.tasks.find(task => task.id === 'next')!.status === 'running')
  expect(reconciled.state.operations![0]!.status).toBe('reconciled')
  expect(reconciled.state.tasks[0]!.phase).toBe('executing')
})

test('goals require current accepted coverage of every criterion and retain identity across requirement changes', async () => {
  const f = await superAgentFixture(); f.config = withSuperAgentOrchestrator(f.config)
  await f.service.save('alpha', f.config)
  const intent = { goal: 'Deliver two verified files', constraints: [], deliverables: ['first.txt', 'second.txt'], acceptanceCriteria: ['First verified', 'Second verified'] }
  await f.service.command('alpha', { type: 'chat', text: intent.goal })
  const handedOff = await finishNode(f, 'main', actions({ intent }))
  const goalId = handedOff.state.intents![0]!.id
  const task = (id: string, criterion: number) => ({ id, title: id, instructions: `Produce and verify ${id}`, nodeId: 'worker', goalId, goalCriteria: [criterion] })
  await finishNode(f, 'orchestrator', actions({ tasks: [task('first', 0)] }))
  const submitted = await finishNode(f, 'worker', 'First file verified')
  const firstPlan = submitted.state.plans.find(plan => plan.id === submitted.state.tasks[0]!.planId)!
  const completePlan = (plan: typeof firstPlan) => ({ ...plan, goalRevision: undefined, revision: undefined, updatedBy: undefined, updatedAt: undefined, status: 'completed', expectedRevision: plan.revision })
  const partial = await finishNode(f, 'orchestrator', actions({ acceptances: [{ taskId: 'first', evidenceTaskId: 'first', status: 'accepted', note: 'First verified' }], plans: [completePlan(firstPlan)] }))
  expect(partial.state.intents![0]!.status).toBe('active')
  await f.service.command('alpha', { type: 'task', ...task('second', 1) })
  const second = await finishNode(f, 'worker', 'Second file verified')
  const secondPlan = second.state.plans.find(plan => plan.id === second.state.tasks.find(task => task.id === 'second')!.planId)!
  const delivered = await finishNode(f, 'orchestrator', actions({ acceptances: [{ taskId: 'second', evidenceTaskId: 'second', status: 'accepted', note: 'Second verified' }], plans: [completePlan(secondPlan)] }))
  expect(delivered.state.intents![0]!.status).toBe('delivered')
  await f.service.command('alpha', { type: 'chat', text: 'Add third file while keeping the previous requirements' })
  const updated = await finishNode(f, 'main', actions({ intent: { ...intent, id: goalId, expectedRevision: 1, deliverables: [...intent.deliverables, 'third.txt'], acceptanceCriteria: [...intent.acceptanceCriteria, 'Third verified'] } }))
  expect(updated.state.intents).toHaveLength(1)
  expect(updated.state.intents![0]).toMatchObject({ id: goalId, revision: 2, status: 'active' })
  expect(updated.state.tasks.map(task => task.acceptance!.status)).toEqual(['stale', 'stale'])
  await expect(f.service.command('alpha', { type: 'task', ...task('old-plan-task', 0), planId: firstPlan.id })).rejects.toThrow('Refresh the plan contract')
  await finishNode(f, 'orchestrator', actions({ acceptances: [{ taskId: 'first', evidenceTaskId: 'first', status: 'accepted', note: 'Old verification' }] }))
  expect((await f.service.get('alpha')).state.tasks[0]!.acceptance!.status).toBe('stale')
})

test('an independent verifier cannot accept an artifact changed after its input version was bound', async () => {
  const f = await superAgentFixture(); f.config = withSuperAgentOrchestrator(f.config)
  f.config.nodes.push({ ...f.config.nodes.find(node => node.role === 'worker')!, id: 'verifier' })
  const job = await running(f)
  const path = join(f.workingDirectory, 'artifact.txt'); await writeFile(path, 'Original')
  await f.service.updateNodeTask('alpha', job.sessionId, { action: 'artifact', taskId: 'job', id: 'artifact', path })
  await finishNode(f, 'worker', 'Original artifact produced')
  await f.service.command('alpha', { type: 'task', id: 'review', title: 'Review', instructions: 'Independently verify the current artifact', nodeId: 'verifier', dependsOn: ['job'], reviewOf: 'job' })
  const verified = await finishNode(f, 'verifier', 'Original artifact independently verified')
  const oldHash = verified.state.tasks.find(task => task.id === 'review')!.inputArtifacts![0]!.sha256
  await writeFile(path, 'Changed after verification')
  f.advance(5000); await f.service.tick()
  const changed = await f.service.get('alpha')
  expect(changed.state.artifacts![0]!.sha256).not.toBe(oldHash)
  const refused = await finishNode(f, 'orchestrator', actions({ acceptances: [{ taskId: 'job', evidenceTaskId: 'review', status: 'accepted', note: 'Old verification' }] }))
  expect(refused.state.tasks.find(task => task.id === 'job')!.acceptance).toBeUndefined()
  expect(refused.state.messages.some(message => message.body.includes('Evidence does not verify the current artifact'))).toBe(true)
})
