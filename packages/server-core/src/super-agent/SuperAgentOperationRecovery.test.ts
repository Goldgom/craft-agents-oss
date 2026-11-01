import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { loadSuperAgentDocument, saveSuperAgentDocument } from '@tokenbird/shared/super-agent'
import { SuperAgentService } from './SuperAgentService'
import { operationReceipt } from './SuperAgentOperationReceipts'
import { superAgentFixture, until } from './SuperAgentTestSupport'

const actions = (value: unknown) => `<super_agent_actions>${JSON.stringify(value)}</super_agent_actions>`
type Fixture = Awaited<ReturnType<typeof superAgentFixture>>
async function active(f: Fixture, nodeId: string) {
  f.advance(2000); await f.service.tick()
  const snapshot = await until(() => f.service.get('alpha'), snapshot => snapshot.state.nodes.some(node => node.nodeId === nodeId && node.status === 'working'))
  return snapshot.state.nodes.find(node => node.nodeId === nodeId)!.sessionId!
}
async function submitted(f: Fixture, nodeId: string, text: string) {
  f.host.complete(await active(f, nodeId), text)
  return until(() => f.service.get('alpha'), snapshot => snapshot.state.nodes.find(node => node.nodeId === nodeId)!.status !== 'working')
}
async function original(unknown = true, receipt?: string) {
  const f = await superAgentFixture()
  f.config.nodes.push({ ...f.config.nodes[1]!, id: 'verifier' })
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'task', id: 'original', title: 'Deliver', instructions: 'Deliver the authorized result',
    nodeId: 'worker', acceptanceCriteria: ['Result verified'] })
  const sessionId = await active(f, 'worker')
  await f.service.prepareNodeOperation('alpha', sessionId, { toolName: 'mcp__crm__update', input: { id: 'record' }, invocationId: 'original-call' })
  if (receipt !== undefined) {
    f.host.sessions.get(sessionId)!.messages = [{ id: 'original-receipt', role: 'tool', content: '', timestamp: f.now(),
      toolName: 'mcp__crm__update', toolUseId: 'original-call', toolInput: { id: 'record' },
      toolResult: receipt, toolStatus: 'error', isError: true }]
    f.host.emit({ type: 'tool_result', sessionId, toolName: 'mcp__crm__update', toolUseId: 'original-call', result: receipt, isError: true })
  }
  if (!unknown) f.host.emit({ type: 'tool_result', sessionId, toolName: 'mcp__crm__update', toolUseId: 'original-call', result: 'Confirmed' })
  f.host.complete(sessionId, 'Submitted deliverable')
  const snapshot = await until(() => f.service.get('alpha'), snapshot => snapshot.state.tasks[0]!.status === (unknown ? 'failed' : 'completed'))
  return { f, operationId: snapshot.state.operations![0]!.id, sessionId }
}
const accept = (evidenceTaskId = 'original') => ({ taskId: 'original', evidenceTaskId, status: 'accepted', note: 'Verified result' })

test('unknown acceptance repairs through independent verification and a follow-up reconciliation without replay', async () => {
  const { f, operationId, sessionId } = await original()
  // The rejected acceptance prevents the following task from being attempted.
  const rejected = await submitted(f, 'main', actions({ acceptances: [accept()], tasks: [{ id: 'later', title: 'Next', instructions: 'Downstream work', nodeId: 'worker' }] }))
  const receipt = rejected.state.messages.findLast(message => message.actionReceipt)?.actionReceipt!
  expect(receipt.status).toBe('rejected')
  expect(receipt.applied).toHaveLength(0)
  expect(receipt.rejected?.error).toContain(operationId)
  expect(receipt.notAttempted?.[0]?.type).toBe('task')
  expect(rejected.state.tasks).toHaveLength(1)
  expect(rejected.state.tasks[0]!.acceptance).toBeUndefined()
  expect(rejected.state.operations![0]!.status).toBe('unknown')
  expect(rejected.state.messages.some(message => message.toNodeId === 'user' && message.body.includes('Communication action rejected'))).toBe(false)

  await active(f, 'main')
  expect(f.host.sends.at(-1)!.message).toContain('Do not retry the blocked acceptance')
  expect(f.host.sends.at(-1)!.message).toContain(operationId)
  f.host.complete(f.host.sends.at(-1)!.sessionId, actions({ tasks: [{ id: 'verify', title: 'Verify outcome', nodeId: 'verifier',
    instructions: `Independently inspect the external receipt for ${operationId} without replaying it` }] }))
  const verifierSession = await active(f, 'verifier')
  const visible = await f.service.updateNodeTask('alpha', verifierSession, { action: 'get', taskId: 'original' })
  if (!('tasks' in visible)) throw new Error('Expected task snapshot')
  expect(visible.tasks.map(task => task.id)).toEqual(['original'])
  expect(visible.operations?.map(operation => operation.id)).toEqual([operationId])
  const reconcile = { action: 'reconcile', operationId, evidenceTaskId: 'verify', outcome: 'completed', note: 'External receipt independently confirms execution' }
  await expect(f.service.updateNodeTask('alpha', verifierSession, reconcile)).rejects.toThrow('completed dedicated')
  f.host.complete(verifierSession, 'Independent external receipt confirms execution')
  await until(() => f.service.get('alpha'), snapshot => snapshot.state.tasks.find(task => task.id === 'verify')?.status === 'completed')
  // Finishing a verification report does not itself settle a side effect.
  expect((await f.service.get('alpha')).state.operations![0]!.status).toBe('unknown')
  await submitted(f, 'main', actions({ messages: [{ toNodeId: 'verifier', body: `Reconcile ${operationId} using completed evidence task verify` }] }))
  await active(f, 'verifier')
  const followup = await f.service.updateNodeTask('alpha', verifierSession, { action: 'get', taskId: 'original' })
  if (!('operations' in followup)) throw new Error('Expected task state from action=get')
  expect(followup.operations?.[0]?.id).toBe(operationId)
  await f.service.updateNodeTask('alpha', verifierSession, reconcile)
  f.host.complete(verifierSession, 'Recorded verified outcome')
  const reconciled = await until(() => f.service.get('alpha'), snapshot => snapshot.state.nodes.find(node => node.nodeId === 'verifier')!.status !== 'working')
  expect(reconciled.state.operations![0]!).toMatchObject({ status: 'reconciled', reconciliation: { evidenceTaskId: 'verify', outcome: 'completed' } })
  expect(reconciled.state.tasks[0]!.phase).toBe('submitted')
  const accepted = await submitted(f, 'main', actions({ acceptances: [accept('verify')] }))
  expect(accepted.state.tasks[0]!.acceptance?.status).toBe('accepted')
  expect(accepted.state.operations).toHaveLength(1)
  expect(f.host.sends.filter(send => send.sessionId === sessionId)).toHaveLength(1)
})

test('independent verification reads original host receipts without replay and can settle a proven non-execution', async () => {
  const { f, operationId, sessionId } = await original(true, 'Connection failed before dispatch')
  await f.service.command('alpha', { type: 'task', id: 'verify', title: 'Verify', nodeId: 'verifier', instructions: `Verify ${operationId}` })
  const verifierSession = await active(f, 'verifier')
  const visible = await f.service.updateNodeTask('alpha', verifierSession, { action: 'get', taskId: 'original', operationId })
  if (!('operationReceipts' in visible)) throw new Error('Expected receipt snapshot')
  expect(visible.operationReceipts).toEqual([expect.objectContaining({ operationId, sessionId, invocationId: 'original-call',
    availability: 'available', messageId: 'original-receipt', inputJson: '{"id":"record"}', result: 'Connection failed before dispatch',
    isError: true, inputTruncated: false, resultTruncated: false })])
  expect((await f.service.get('alpha')).state.operations![0]!.status).toBe('unknown')
  // Only a separate completed evidence task can interpret this receipt and settle the operation.
  f.host.complete(verifierSession, 'Original receipt and independent external audit confirm the request was never dispatched')
  await until(() => f.service.get('alpha'), snapshot => snapshot.state.tasks.find(task => task.id === 'verify')?.status === 'completed')
  await submitted(f, 'main', actions({ messages: [{ toNodeId: 'verifier', body: `Reconcile ${operationId}` }] }))
  await active(f, 'verifier')
  const followup = await f.service.updateNodeTask('alpha', verifierSession, { action: 'get', operationId })
  if (!('operationReceipts' in followup)) throw new Error('Expected receipt snapshot')
  expect(followup.operationReceipts?.[0]?.availability).toBe('available')
  await f.service.updateNodeTask('alpha', verifierSession, { action: 'reconcile', operationId, evidenceTaskId: 'verify',
    outcome: 'not-executed', note: 'Original receipt and independent external audit prove no dispatch' })
  expect((await f.service.get('alpha')).state.operations![0]!.reconciliation?.outcome).toBe('not-executed')
  expect(f.host.sends.filter(send => send.sessionId === sessionId)).toHaveLength(1)
})

test('receipt lookup respects operation visibility and rejects changed or cross-workspace transcripts', async () => {
  const { f, operationId, sessionId } = await original(true, 'Original failure')
  await f.service.command('alpha', { type: 'task', id: 'verify', title: 'Verify', nodeId: 'verifier', instructions: 'Unrelated review' })
  const verifierSession = await active(f, 'verifier')
  f.host.sessionQueries.length = 0
  const denied = await f.service.updateNodeTask('alpha', verifierSession, { action: 'get', operationId })
  if (!('operationReceipts' in denied)) throw new Error('Expected receipt snapshot')
  expect(denied.operations).toEqual([])
  expect(denied.operationReceipts).toEqual([])
  expect(f.host.sessionQueries).not.toContain(sessionId)
  const operation = (await f.service.get('alpha')).state.operations![0]!
  const session = f.host.sessions.get(sessionId)!
  session.messages![0]!.toolResult = 'Changed result'
  expect(operationReceipt(operation, session, 'alpha').availability).toBe('hash-mismatch')
  expect(operationReceipt(operation, { ...session, workspaceId: 'beta' }, 'alpha').availability).toBe('missing')
  expect(operationReceipt(operation, { ...session, messages: [] }, 'alpha').availability).toBe('missing')
})

test('large original receipts have explicit truncation and retain the original full-result hash', async () => {
  const { f, operationId, sessionId } = await original(true, 'x'.repeat(40_000))
  const operation = (await f.service.get('alpha')).state.operations![0]!
  const session = f.host.sessions.get(sessionId)!
  session.messages![0]!.toolInput = { value: 'y'.repeat(20_000) }
  const receipt = operationReceipt(operation, session, 'alpha')
  expect(receipt).toMatchObject({ operationId, availability: 'available', resultTruncated: true, inputTruncated: true,
    resultHash: createHash('sha256').update(`mcp__crm__update\n${'x'.repeat(40_000)}`).digest('hex') })
  if (receipt.availability !== 'available') throw new Error('Expected receipt')
  expect(receipt.result).toHaveLength(32_000)
  expect(receipt.inputJson).toHaveLength(16_000)
})

test('operation verification can read only referenced operations and cannot change the original checkpoint', async () => {
  const { f, operationId } = await original()
  await f.service.command('alpha', { type: 'task', id: 'unrelated', title: 'Unrelated', nodeId: 'worker', instructions: 'Other work' })
  const workerSession = await active(f, 'worker')
  await f.service.prepareNodeOperation('alpha', workerSession, { toolName: 'mcp__crm__update', input: { id: 'other' }, invocationId: 'unrelated-call' })
  await f.service.command('alpha', { type: 'task', id: 'verify', title: 'Verify', nodeId: 'verifier', instructions: `Verify ${operationId}` })
  const verifierSession = await active(f, 'verifier')
  const visible = await f.service.updateNodeTask('alpha', verifierSession, { action: 'get' })
  if (!('tasks' in visible)) throw new Error('Expected task snapshot')
  expect(visible.tasks.map(task => task.id).sort()).toEqual(['original', 'verify'])
  expect(visible.operations?.map(operation => operation.id)).toEqual([operationId])
  const unrelated = await f.service.updateNodeTask('alpha', verifierSession, { action: 'get', taskId: 'unrelated' })
  if (!('tasks' in unrelated)) throw new Error('Expected task snapshot')
  expect(unrelated.tasks).toHaveLength(0)
  await expect(f.service.updateNodeTask('alpha', verifierSession, { action: 'checkpoint', taskId: 'original', expectedRevision: 0,
    completedSteps: [], nextStep: 'Skip verification' })).rejects.toThrow('assigned')
})

test.each([true, false])('evidence with its own unknown outcome cannot settle an operation or support acceptance (original unknown: %s)', async originalUnknown => {
  const { f, operationId } = await original(originalUnknown)
  await f.service.command('alpha', { type: 'task', id: 'verify', title: 'Verify', nodeId: 'verifier', instructions: `Verify ${operationId}` })
  const verifierSession = await active(f, 'verifier')
  await f.service.prepareNodeOperation('alpha', verifierSession, { toolName: 'mcp__crm__inspect', input: {}, invocationId: 'verification-call' })
  f.host.emit({ type: 'tool_result', sessionId: verifierSession, toolName: 'mcp__crm__inspect', toolUseId: 'verification-call', result: 'Transport failure', isError: true })
  f.host.complete(verifierSession, 'Claimed verification')
  const checked = await until(() => f.service.get('alpha'), snapshot => snapshot.state.tasks.find(task => task.id === 'verify')?.status === 'failed')
  const unknown = checked.state.operations!.find(operation => operation.taskId === 'verify')!
  expect(unknown.status).toBe('unknown')
  const rejected = await submitted(f, 'main', actions({ acceptances: [accept('verify')] }))
  expect(rejected.state.tasks[0]!.acceptance).toBeUndefined()
  expect(rejected.state.messages.findLast(message => message.actionReceipt)?.actionReceipt?.rejected?.error).toContain(originalUnknown ? operationId : unknown.id)
  // The same unsettled report must not be used to reconcile another operation.
  await f.service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'verifier', body: 'Record verification' })
  await active(f, 'verifier')
  await expect(f.service.updateNodeTask('alpha', verifierSession, { action: 'reconcile', operationId,
    evidenceTaskId: 'verify', outcome: 'not-executed', note: 'Assumed no effect' })).rejects.toThrow('completed dedicated')
  expect((await f.service.get('alpha')).state.operations!.find(operation => operation.id === unknown.id)!.status).toBe('unknown')
})

test('exhausted acceptance repair automatically verifies, reconciles and resumes without user inspection or replay', async () => {
  const { f, operationId } = await original()
  for (let hop = 1; hop <= 6; hop++) {
    const snapshot = await submitted(f, 'main', actions({ acceptances: [accept()] }))
    expect(snapshot.state.tasks[0]!.acceptance).toBeUndefined()
    expect(snapshot.state.messages.some(message => message.toNodeId === 'user' && message.body.includes('Communication action rejected'))).toBe(false)
  }
  const snapshot = await f.service.get('alpha')
  expect(snapshot.config!.continuousWork).toBe(false)
  const evidence = snapshot.state.tasks.find(task => task.id !== 'original')!
  expect(evidence).toMatchObject({ nodeId: 'verifier', status: 'queued' })
  expect(evidence.instructions).toContain(operationId)
  const verifierSession = await active(f, 'verifier')
  f.host.complete(verifierSession, 'Independent audit proves the operation did not execute')
  await until(() => f.service.get('alpha'), snapshot => snapshot.state.tasks.find(task => task.id === evidence.id)?.status === 'completed')
  // Completed dedicated evidence proceeds directly to reconciliation, without a planner click/turn.
  await active(f, 'verifier')
  expect(f.host.sends.at(-1)!.message).toContain(`evidenceTaskId=${evidence.id}`)
  await f.service.updateNodeTask('alpha', verifierSession, { action: 'reconcile', operationId, evidenceTaskId: evidence.id,
    outcome: 'not-executed', note: 'Independent audit confirms non-execution' })
  const settled = await f.service.get('alpha')
  expect(settled.state.plans.find(plan => plan.id === evidence.planId)?.status).toBe('completed')
  expect(settled.state.tasks.find(task => task.id === evidence.id)?.acceptance?.status).toBe('accepted')
  expect(settled.state.tasks[0]!.acceptance).toBeUndefined()
  f.host.complete(verifierSession, 'Recorded verified non-execution')
  await until(() => f.service.get('alpha'), snapshot => snapshot.state.nodes.find(node => node.nodeId === 'verifier')!.status !== 'working')
  const accepted = await submitted(f, 'main', actions({ acceptances: [accept(evidence.id)] }))
  expect(accepted.state.tasks[0]!.acceptance?.status).toBe('accepted')
  expect(accepted.state.operations).toHaveLength(1)
  expect(f.host.sends.filter(send => send.sessionId === snapshot.state.operations![0]!.sessionId)).toHaveLength(1)
})

test('legacy receipts recover a unique terminal transcript hash without trusting conflicts or pending results', async () => {
  const { f, operationId, sessionId } = await original(true, 'Original error with uncertain external effect')
  const operation = (await f.service.get('alpha')).state.operations!.find(item => item.id === operationId)!
  const session = f.host.sessions.get(sessionId)!
  const legacy = { ...operation, resultHash: undefined }
  const recovered = operationReceipt(legacy, session, 'alpha')
  expect(recovered).toMatchObject({ availability: 'available', hashSource: 'transcript', isError: true })
  expect(operationReceipt({ ...legacy, resultHash: '0'.repeat(64) }, session, 'alpha').availability).toBe('hash-mismatch')
  expect(operationReceipt(legacy, { ...session, workspaceId: 'other' }, 'alpha').availability).toBe('missing')
  expect(operationReceipt(legacy, { ...session, messages: [...session.messages!, { ...session.messages![0]!, id: 'duplicate' }] }, 'alpha').availability).toBe('hash-mismatch')
  expect(operationReceipt(legacy, { ...session, messages: [{ ...session.messages![0]!, toolStatus: 'executing' }] }, 'alpha').availability).not.toBe('available')
})

test('a terminal shell bridge error ends the invocation while external transport errors remain unknown', async () => {
  const f = await superAgentFixture()
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'task', id: 'shell', title: 'Inspect', instructions: 'Inspect original receipts', nodeId: 'worker' })
  const sessionId = await active(f, 'worker')
  for (const [invocationId, toolName, result, status] of [
    ['shell-1', 'mcp__session__runshell', '[ERROR] [executed on server] cwd=C:\\work\nexit code 1\n\nSTDOUT:\nno matching command', 'completed'],
    ['shell-2', 'Bash', 'Network failed before result delivery', 'unknown'],
    ['crm-1', 'mcp__crm__update', '[ERROR] [executed on server]\nexit code 1\n', 'unknown'],
  ] as const) {
    await f.service.prepareNodeOperation('alpha', sessionId, { invocationId, toolName, input: { command: invocationId } })
    f.host.emit({ type: 'tool_result', sessionId, toolUseId: invocationId, toolName, result, isError: true })
    const snapshot = await until(() => f.service.get('alpha'), value => value.state.operations?.find(item => item.invocationId === invocationId)?.resultHash != null)
    expect(snapshot.state.operations?.find(item => item.invocationId === invocationId)).toMatchObject({ status, resultIsError: true })
    expect(snapshot.state.tasks[0]!.acceptance).toBeUndefined()
  }
})

test('goal revisions do not abandon unknown historical operations or accept obsolete deliverables', async () => {
  const { f, operationId } = await original()
  await f.service.cleanup()
  const document = await loadSuperAgentDocument(join(f.root, 'alpha'))
  document.pendingTurns = []
  document.state.intents = [{ id: 'goal', revision: 2, status: 'active', goal: 'Install the revised deliverable', constraints: [], deliverables: [], acceptanceCriteria: ['Installed'], createdAt: f.now(), sourceTurnId: 'user-turn' }]
  document.state.tasks[0]!.goalId = 'goal'; document.state.tasks[0]!.goalRevision = 1
  document.state.plans[0]!.goalId = 'goal'; document.state.plans[0]!.goalRevision = 1
  await saveSuperAgentDocument(join(f.root, 'alpha'), document)
  const service = new SuperAgentService({ host: f.host, rootForWorkspace: id => join(f.root, id), now: f.now, autoTick: false })
  try {
    const snapshot = await service.get('alpha')
    expect(snapshot.state.tasks.find(task => task.id !== 'original')).toMatchObject({ goalId: 'goal', goalRevision: 2 })
    expect(snapshot.state.tasks.find(task => task.id !== 'original')?.instructions).toContain(operationId)
    expect(snapshot.state.tasks[0]!.acceptance).toBeUndefined()
    expect(snapshot.state.intents?.[0]?.status).toBe('active')
  } finally { await service.cleanup() }
})

test('legacy system-blocked plans recover on restart and persist one evidence assignment and follow-up', async () => {
  const { f, operationId } = await original(true, 'Original transport failure')
  await f.service.cleanup()
  const document = await loadSuperAgentDocument(join(f.root, 'alpha'))
  document.pendingTurns = []
  const plan = document.state.plans[0]!
  plan.status = 'blocked'; plan.updatedBy = 'main'; plan.note = 'Unsettled operation outcomes must be verified before acceptance'
  await saveSuperAgentDocument(join(f.root, 'alpha'), document)
  const restart = () => new SuperAgentService({ host: f.host, rootForWorkspace: workspaceId => join(f.root, workspaceId), now: f.now, autoTick: false })
  let service = restart()
  try {
    const recovered = await service.get('alpha')
    const evidence = recovered.state.tasks.find(task => task.id !== 'original')!
    expect(evidence.instructions).toContain(operationId)
    expect(evidence.planId).not.toBe(plan.id)
    for (let scan = 0; scan < 3; scan++) { f.advance(2000); await service.tick() }
    expect((await service.get('alpha')).state.tasks).toHaveLength(2)
    const executing = await until(() => service.get('alpha'), snapshot => snapshot.state.nodes.find(node => node.nodeId === 'verifier')?.status === 'working' && !!snapshot.state.nodes.find(node => node.nodeId === 'verifier')?.sessionId)
    const sessionId = executing.state.nodes.find(node => node.nodeId === 'verifier')!.sessionId!
    f.host.complete(sessionId, 'Independent evidence confirms non-execution')
    await until(() => service.get('alpha'), snapshot => snapshot.state.tasks.find(task => task.id === evidence.id)?.status === 'completed')
    await until(() => loadSuperAgentDocument(join(f.root, 'alpha')), document => !!document.operationRecovery?.[operationId]?.followupTurnId)
    await service.cleanup()
    service = restart()
    const restored = await service.get('alpha')
    expect(restored.state.tasks).toHaveLength(2)
    const durable = await loadSuperAgentDocument(join(f.root, 'alpha'))
    expect(durable.pendingTurns.filter(turn => turn.nodeId === 'verifier' && turn.kind === 'message')).toHaveLength(1)
    expect(durable.operationRecovery?.[operationId]?.evidenceTaskId).toBe(evidence.id)
  } finally { await service.cleanup() }
})

test.each(['human', 'stop', 'cancelled-task'] as const)('automatic operation recovery respects %s', async mode => {
  const { f, operationId } = await original()
  if (mode === 'stop') await f.service.command('alpha', { type: 'cancel' })
  else {
    const snapshot = await f.service.get('alpha')
    const plan = snapshot.state.plans[0]!
    await submitted(f, 'main', actions({ plans: [{ ...plan, expectedRevision: plan.revision, status: 'blocked',
      blocker: { kind: 'user', summary: 'Missing authorization', userAction: 'Authorize access to the external audit log' } }] }))
    if (mode === 'cancelled-task') {
      await f.service.cleanup()
      const document = await loadSuperAgentDocument(join(f.root, 'alpha'))
      const target = document.state.tasks[0]!
      target.status = 'cancelled'
      document.state.plans[0]!.blocker = undefined
      document.state.plans[0]!.updatedBy = 'main'
      document.pendingTurns = []
      await saveSuperAgentDocument(join(f.root, 'alpha'), document)
      const service = new SuperAgentService({ host: f.host, rootForWorkspace: workspaceId => join(f.root, workspaceId), now: f.now, autoTick: false })
      try { expect((await service.get('alpha')).state.tasks).toHaveLength(1) } finally { await service.cleanup() }
      return
    }
  }
  for (let scan = 0; scan < 3; scan++) { f.advance(2000); await f.service.tick() }
  const snapshot = await f.service.get('alpha')
  expect(snapshot.state.tasks).toHaveLength(1)
  expect(snapshot.state.operations![0]).toMatchObject({ id: operationId, status: 'unknown' })
  if (mode === 'stop') {
    expect(snapshot.recoverySuspended).toBe(true)
    expect((await loadSuperAgentDocument(join(f.root, 'alpha'))).recoverySuspended).toBe(true)
  }
})

test('unchanged internal plan evidence receives one automatic review across ticks and restart', async () => {
  const f = await superAgentFixture()
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'plan-upsert', expectedRevision: 0, item: {
    id: 'internal', title: 'Recover internal dependency', instructions: 'Repair within current authorization', status: 'blocked', priority: 1, note: 'Internal dependency requires investigation',
    blocker: { kind: 'system', summary: 'A prerequisite result needs verification', systemAction: 'Inspect existing results and repair the dependency' },
  } })
  const session = await active(f, 'main')
  expect(f.host.sends.at(-1)!.message).toContain('Automatic internal recovery')
  f.host.complete(session, '')
  await until(() => f.service.get('alpha'), snapshot => snapshot.state.nodes[0]!.status === 'idle')
  const sends = f.host.sends.length
  for (let scan = 0; scan < 3; scan++) { f.advance(2000); await f.service.tick() }
  expect(f.host.sends).toHaveLength(sends)
  await f.service.cleanup()
  const service = new SuperAgentService({ host: f.host, rootForWorkspace: workspaceId => join(f.root, workspaceId), now: f.now, autoTick: false })
  try {
    await service.get('alpha')
    f.advance(2000); await service.tick()
    expect(f.host.sends).toHaveLength(sends)
    expect((await loadSuperAgentDocument(join(f.root, 'alpha'))).pendingTurns).toHaveLength(0)
  } finally { await service.cleanup() }
})
