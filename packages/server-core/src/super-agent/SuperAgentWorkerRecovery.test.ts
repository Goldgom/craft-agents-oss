import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { loadSuperAgentDocument, saveSuperAgentDocument, superAgentResourceBlockers, rebuildSuperAgentConfig } from '@tokenbird/shared/super-agent'
import { PiEventAdapter } from '../../../shared/src/agent/backend/pi/event-adapter'
import { SuperAgentService } from './SuperAgentService'
import { SuperAgentTestHost, superAgentFixture, until } from './SuperAgentTestSupport'
import { operationInputHash } from './SuperAgentOperationIdentity'
import { completeReceipt, prepareReceipt, legacyReadIdentityRepair } from './SuperAgentReceiptArchive'

type Fixture = Awaited<ReturnType<typeof superAgentFixture>>
async function start(f: Fixture, id = 'job', nodeId = 'worker', resources = ['repository']) {
  await f.service.command('alpha', { type: 'task', id, title: id, instructions: 'Continue only the remaining authorized steps', nodeId, resources })
  const snapshot = await until(() => f.service.get('alpha'), snapshot => snapshot.state.tasks.some(task => task.id === id && task.status === 'running')
    && f.host.sends.some(send => send.sessionId === snapshot.state.tasks.find(task => task.id === id)?.sessionId))
  return snapshot.state.tasks.find(task => task.id === id)!.sessionId!
}

test('recovery rebuilds every worker, preserves management sessions, progress, board and committed communication', async () => {
  const f = await superAgentFixture()
  f.config.nodes.push({ ...f.config.nodes[1]!, id: 'other' })
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'chat', text: 'Authorized original request' })
  const main = await until(() => f.service.get('alpha'), snapshot => snapshot.state.nodes.some(node => node.nodeId === 'main' && node.status === 'working'))
  const mainSession = main.state.nodes.find(node => node.nodeId === 'main')!.sessionId!
  f.host.complete(mainSession, 'Original plan retained')
  await until(() => f.service.get('alpha'), snapshot => snapshot.state.nodes.find(node => node.nodeId === 'main')!.status === 'idle')
  const first = await start(f)
  const second = await start(f, 'other-job', 'other', ['desktop'])
  await f.service.updateNodeTask('alpha', first, { action: 'checkpoint', taskId: 'job', expectedRevision: 0, completedSteps: ['Initial patch saved'], nextStep: 'Verify existing patch' })
  await f.service.command('alpha', { type: 'board-upsert', item: { id: 'notes', title: 'Notes', content: 'Persistent contract' }, expectedRevision: 0 })
  const before = await f.service.get('alpha')
  const recovered = await f.service.command('alpha', { type: 'recover-workers', requestId: 'recover-once' })
  expect(recovered.recovery).toMatchObject({ id: 'recover-once', generation: 1, phase: 'ready' })
  expect(f.host.cancelled).toEqual(expect.arrayContaining([first, second]))
  expect(recovered.state.nodes.find(node => node.nodeId === 'main')!.sessionId).toBe(mainSession)
  expect(recovered.state.board).toEqual(before.state.board)
  expect(recovered.state.messages).toEqual(expect.arrayContaining(before.state.messages))
  expect(recovered.state.tasks.find(task => task.id === 'job')!.checkpoint?.completedSteps).toEqual(['Initial patch saved'])
  expect(recovered.state.tasks).toHaveLength(2)
  f.advance(2000); await f.service.tick()
  const continued = await until(() => f.service.get('alpha'), snapshot => snapshot.state.tasks.every(task => task.sessionId !== first && task.sessionId !== second))
  expect(continued.state.tasks[0]!.executionAttempts).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: first, status: 'interrupted' })]))
  expect(f.host.sessions.has(first)).toBe(true)
  const count = f.host.cancelled.length
  await f.service.command('alpha', { type: 'recover-workers', requestId: 'recover-once' })
  expect(f.host.cancelled).toHaveLength(count)
  await expect(f.service.prepareNodeOperation('alpha', first, { toolName: 'Bash', input: { command: 'old' }, invocationId: 'stale' })).rejects.toThrow('active node')
})

test('restart continues unfinished work without a model checkpoint or continuous work setting', async () => {
  const f = await superAgentFixture()
  await f.service.save('alpha', f.config)
  const old = await start(f)
  await f.service.cleanup()
  const document = await loadSuperAgentDocument(join(f.root, 'alpha'))
  delete document.state.tasks[0]!.executionAttempts // Simulate a document from the previous release.
  await saveSuperAgentDocument(join(f.root, 'alpha'), document)
  const host = new SuperAgentTestHost()
  const service = new SuperAgentService({ host, rootForWorkspace: id => join(f.root, id), autoTick: false, now: f.now })
  try {
    await service.get('alpha')
    await until(() => service.get('alpha'), snapshot => snapshot.recovery?.phase === 'ready')
    f.advance(2000); await service.tick()
    const snapshot = await until(() => service.get('alpha'), snapshot => snapshot.recovery?.phase === 'ready' && host.sends.length > 0)
    expect(snapshot.config!.continuousWork).toBe(false)
    expect(snapshot.state.tasks).toHaveLength(1)
    expect(snapshot.state.tasks[0]!.id).toBe('job')
    expect(snapshot.recovery!.reason).toBe('restart')
    expect(host.sends[0]!.context).toContain('remaining')
    expect(snapshot.state.tasks[0]!.executionAttempts?.[0]).toMatchObject({ sessionId: old, status: 'interrupted' })
  } finally { await service.cleanup() }
})

test('unknown writes retain only their task resources; independent tasks continue and late evidence resumes the original task', async () => {
  const f = await superAgentFixture()
  f.config.nodes.push({ ...f.config.nodes[1]!, id: 'other' })
  await f.service.save('alpha', f.config)
  const old = await start(f)
  await f.service.prepareNodeOperation('alpha', old, { toolName: 'mcp__crm__update', input: { id: 'record' }, invocationId: 'write-1' })
  const recovered = await f.service.command('alpha', { type: 'recover-workers', requestId: 'unknown-write' })
  expect(recovered.state.tasks[0]).toMatchObject({ status: 'failed', phase: 'outcome-unknown' })
  const operation = recovered.state.operations![0]!
  await start(f, 'independent', 'other', ['unrelated'])
  expect(superAgentResourceBlockers(recovered.state, { ...recovered.state.tasks[0]!, id: 'conflict' })).toEqual([expect.objectContaining({ taskId: 'job' })])
  f.advance(2000)
  f.host.emit({ type: 'tool_result', sessionId: old, toolUseId: 'write-1', toolName: 'mcp__crm__update', result: 'Original write confirmed' })
  const resumed = await until(() => f.service.get('alpha'), snapshot => snapshot.state.operations?.[0]?.status === 'completed'
    && snapshot.state.tasks[0]!.sessionId !== old)
  expect(resumed.state.operations![0]!.id).toBe(operation.id)
  expect(resumed.state.operations![0]!.executionOutcome).toBe('succeeded')
  expect(resumed.state.tasks).toHaveLength(2)
  expect(resumed.recovery!.unresolvedOperationIds).toEqual([])
})

test('unknown native reads end their old attempt without claiming successful execution or retaining write locks', async () => {
  const f = await superAgentFixture()
  await f.service.save('alpha', f.config)
  const old = await start(f)
  await f.service.prepareNodeOperation('alpha', old, { toolName: 'Read', input: { file_path: 'notes.txt' }, invocationId: 'read-1' })
  const snapshot = await f.service.command('alpha', { type: 'recover-workers', requestId: 'read-recovery' })
  expect(snapshot.state.operations![0]).toMatchObject({ status: 'completed', executionOutcome: 'interrupted', resourceClaims: [] })
  expect(snapshot.recovery!.unresolvedOperationIds).toEqual([])
  f.advance(2000); await f.service.tick()
  await until(() => f.service.get('alpha'), snapshot => snapshot.state.tasks[0]!.sessionId !== old)
})

test('late evidence across another restart cannot reset an expired continuation deadline', async () => {
  const f = await superAgentFixture()
  await f.service.save('alpha', f.config)
  const old = await start(f)
  await f.service.prepareNodeOperation('alpha', old, { toolName: 'mcp__crm__update', input: { id: 'record' }, invocationId: 'delayed-write' })
  await f.service.command('alpha', { type: 'recover-workers', requestId: 'await-receipt' })
  await f.service.cleanup()
  const root = join(f.root, 'alpha')
  const document = await loadSuperAgentDocument(root)
  const turn = document.workerRecovery!.turns.find(turn => turn.taskId === 'job')!
  turn.retryDeadline = f.now() + 1000; turn.retryAttempt = 2
  await saveSuperAgentDocument(root, document)
  const service = new SuperAgentService({ host: f.host, rootForWorkspace: id => join(f.root, id), autoTick: false, now: f.now })
  try {
    await service.get('alpha')
    await until(() => service.get('alpha'), value => value.recovery?.phase === 'ready')
    f.advance(2000)
    f.host.emit({ type: 'tool_result', sessionId: old, toolUseId: 'delayed-write', toolName: 'mcp__crm__update', result: 'Original write confirmed' })
    const snapshot = await until(() => service.get('alpha'), value => value.state.operations![0]!.status === 'completed')
    expect(snapshot.state.tasks[0]!.status).toBe('failed')
    expect(snapshot.state.tasks[0]!.error).toContain('expired')
    expect((await loadSuperAgentDocument(root)).failedTurns).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: 'job', retryAttempt: 2, retryDeadline: turn.retryDeadline })]))
    expect(f.host.sends).toHaveLength(1)
  } finally { await service.cleanup() }
})

test('stop during recovery wins over the saved worker continuation', async () => {
  const f = await superAgentFixture()
  await f.service.save('alpha', f.config)
  await start(f)
  let release!: () => void
  const stopped = new Promise<void>(resolve => { release = resolve })
  const cancel = f.host.cancelProcessing.bind(f.host)
  f.host.cancelProcessing = async id => { await stopped; await cancel(id) }
  const recovery = f.service.command('alpha', { type: 'recover-workers', requestId: 'cancel-race' })
  await until(() => f.service.get('alpha'), snapshot => snapshot.recovery?.phase === 'stopping')
  await f.service.command('alpha', { type: 'cancel' })
  release()
  const snapshot = await recovery
  expect(snapshot.recoverySuspended).toBe(true)
  expect(snapshot.state.tasks[0]!.status).toBe('cancelled')
  expect(f.host.sends).toHaveLength(1)
})

test('original journal repairs the historical Bash/Read display hash but rejects unrelated tampering', async () => {
  const f = await superAgentFixture()
  await f.service.save('alpha', f.config)
  const old = await start(f)
  const input = { command: 'cat notes.txt' }
  await f.service.prepareNodeOperation('alpha', old, { toolName: 'Bash', input, invocationId: 'cat-1' })
  await f.service.cleanup()
  const root = join(f.root, 'alpha')
  const document = await loadSuperAgentDocument(root)
  const operation = document.state.operations![0]!
  // Reconstruct the exact legacy bug: private journal Bash, event-derived hash Read.
  operation.inputHashVersion = undefined
  operation.inputHash = operationInputHash('Bash', input)
  await prepareReceipt(root, 'alpha', operation, input)
  await completeReceipt(root, 'alpha', operation, 'saved contents', false, f.now())
  operation.status = 'unknown'
  operation.resultHash = createHash('sha256').update('Read\nsaved contents').digest('hex')
  expect(await legacyReadIdentityRepair(root, 'alpha', { ...operation, resultHash: '0'.repeat(64) })).toBeUndefined()
  await expect(legacyReadIdentityRepair(root, 'alpha', { ...operation, inputHash: '0'.repeat(64) })).rejects.toThrow('identity mismatch')
  await saveSuperAgentDocument(root, document)
  const service = new SuperAgentService({ host: new SuperAgentTestHost(), rootForWorkspace: id => join(f.root, id), autoTick: false, now: f.now })
  try {
    const snapshot = await service.get('alpha')
    expect(snapshot.state.operations![0]).toMatchObject({ status: 'completed', executionOutcome: 'succeeded' })
    expect(snapshot.state.operations![0]!.recovery).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: 'host-identity-repair' })]))
  } finally { await service.cleanup() }
})

test('Pi Bash read events and durable host receipts share an execution identity', async () => {
  const f = await superAgentFixture()
  await f.service.save('alpha', f.config)
  const sessionId = await start(f)
  const input = { command: 'cat notes.txt', _intent: 'Inspect notes' }
  await f.service.prepareNodeOperation('alpha', sessionId, { toolName: 'Bash', input, invocationId: 'pi-cat' })
  const adapter = new PiEventAdapter(); adapter.startTurn()
  for (const event of adapter.adaptEvent({ type: 'tool_execution_start', toolCallId: 'pi-cat', toolName: 'bash', args: input } as any)) {
    if (event.type === 'tool_start') f.host.emit({ type: 'tool_start', sessionId, toolUseId: event.toolUseId, toolName: event.toolName, toolInput: event.input })
  }
  for (const event of adapter.adaptEvent({ type: 'tool_execution_end', toolCallId: 'pi-cat', result: 'contents', isError: false } as any)) {
    if (event.type === 'tool_result') f.host.emit({ type: 'tool_result', sessionId, toolUseId: event.toolUseId, toolName: event.toolName!, result: event.result ?? '' })
  }
  const snapshot = await until(() => f.service.get('alpha'), snapshot => snapshot.state.operations![0]!.status === 'completed')
  expect(snapshot.state.operations![0]!.executionOutcome).toBe('succeeded')
  expect(operationInputHash('Read', { path: 'notes.txt', _intent: 'Read' }, 2)).toBe(operationInputHash('Read', { file_path: 'notes.txt' }, 2))
})

test('a real host process exits after a write; recovery preserves its effect and resumes without replay', async () => {
  const f = await superAgentFixture()
  const configFile = join(f.root, 'crash-config.json')
  await writeFile(configFile, JSON.stringify(f.config))
  const exit = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dir, 'fixtures', 'worker-recovery-crash.ts'), f.root, configFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ code, output }))
  })
  expect(exit).toEqual({ code: 0, output: '' })
  const before = await loadSuperAgentDocument(join(f.root, 'alpha'))
  expect(before.state.tasks[0]!.status).toBe('running')
  expect(before.state.operations![0]!.status).toBe('prepared')
  const service = new SuperAgentService({ host: f.host, rootForWorkspace: id => join(f.root, id), autoTick: false, now: () => Date.now() + 2000 })
  try {
    await service.get('alpha')
    const restored = await until(() => service.get('alpha'), snapshot => snapshot.recovery?.phase === 'ready' && f.host.sends.length > 0)
    expect(restored.state.tasks[0]!.id).toBe('crash-job')
    expect(restored.state.operations![0]).toMatchObject({ status: 'completed', executionOutcome: 'succeeded' })
    expect(await readFile(join(f.workingDirectory, 'effect-count.txt'), 'utf8')).toBe('1')
    expect(f.host.sends).toHaveLength(1)
    expect(f.host.sends[0]!.context).toContain('do not repeat completed')
    await expect(service.prepareNodeOperation('alpha', restored.state.tasks[0]!.sessionId!, {
      toolName: 'Write', input: { file_path: join(f.workingDirectory, 'effect-count.txt'), content: '1' }, invocationId: 'replay-write',
    })).rejects.toThrow('completed')
  } finally { await service.cleanup() }
}, 30_000)

test('a blocked recovery persists its identity and attempts across host restart', async () => {
  const f = await superAgentFixture()
  await f.service.save('alpha', f.config)
  const original = await start(f)
  const cancel = f.host.cancelProcessing.bind(f.host)
  f.host.cancelProcessing = async () => {}
  const blocked = await f.service.command('alpha', { type: 'recover-workers', requestId: 'persistent-recovery' })
  expect(blocked.recovery).toMatchObject({ id: 'persistent-recovery', phase: 'blocked', attempts: 1 })
  expect(blocked.recovery!.error).toContain('still active')
  await f.service.cleanup()
  f.host.cancelProcessing = cancel
  const service = new SuperAgentService({ host: f.host, rootForWorkspace: id => join(f.root, id), autoTick: false, now: f.now })
  try {
    const retained = await service.get('alpha')
    expect(retained.recovery).toMatchObject({ id: 'persistent-recovery', phase: 'blocked', attempts: 1, generation: 1 })
    f.advance(6000); await service.tick()
    const restored = await until(() => service.get('alpha'), snapshot => snapshot.recovery?.phase === 'ready')
    expect(restored.recovery).toMatchObject({ id: 'persistent-recovery', attempts: 2, generation: 1 })
    expect(f.host.cancelled).toContain(original)
  } finally { await service.cleanup() }
})

test('worker recovery confirms a real managed local script has exited before resuming', async () => {
  const f = await superAgentFixture()
  await writeFile(join(f.workingDirectory, 'long.cjs'), 'require("node:fs").writeFileSync("script-pid.txt", String(process.pid)); setInterval(() => {}, 1000)')
  f.config.scripts = [{ id: 'long', name: 'Long running', path: 'long.cjs', args: [], nodeId: 'worker', timeoutSeconds: 30 }]
  await f.service.save('alpha', f.config)
  await start(f)
  await f.service.command('alpha', { type: 'script-run', scriptId: 'long' })
  const pid = await until(async () => Number(await readFile(join(f.workingDirectory, 'script-pid.txt'), 'utf8').catch(() => '0')), value => value > 0)
  const snapshot = await f.service.command('alpha', { type: 'recover-workers', requestId: 'stop-local-script' })
  expect(snapshot.recovery!.phase).toBe('ready')
  expect(snapshot.state.scripts[0]!.status).toBe('stopped')
  expect(() => process.kill(pid, 0)).toThrow()
})

test('all three management sessions, report cursors, plans and completed tasks survive worker recovery', async () => {
  const f = await superAgentFixture()
  f.config = rebuildSuperAgentConfig(f.config)
  await f.service.save('alpha', f.config)
  const working = async (role: string) => {
    f.advance(2000); await f.service.tick()
    const snapshot = await until(() => f.service.get('alpha'), value => value.state.nodes.some(node => node.status === 'working'
      && value.config!.nodes.find(config => config.id === node.nodeId)?.role === role
      && f.host.sends.some(send => send.sessionId === node.sessionId)))
    return snapshot.state.nodes.find(node => node.status === 'working' && snapshot.config!.nodes.find(config => config.id === node.nodeId)?.role === role)!.sessionId!
  }
  await f.service.command('alpha', { type: 'chat', text: 'Complete the authorized implementation' })
  const main = await working('coordinator')
  await f.service.callNodeActionTool('alpha', main, 'super_agent_submit_request', { requestId: 'submit' })
  f.host.complete(main, '')
  const planner = await working('planner')
  const request = (await f.service.get('alpha')).state.requests![0]!
  await f.service.callNodeActionTool('alpha', planner, 'super_agent_intent', { requestId: 'goal', sourceRequestId: request.id,
    goal: 'Complete implementation', constraints: [], deliverables: ['Working code'], acceptanceCriteria: ['Self-check passes'] })
  const goal = (await f.service.get('alpha')).state.intents![0]!
  await f.service.callNodeActionTool('alpha', planner, 'super_agent_plan', { requestId: 'plan', id: 'implementation', goalId: goal.id,
    title: 'Implement', instructions: 'Implement and self-check', status: 'planned', priority: 1, note: '', expectedRevision: 0 })
  f.host.complete(planner, '')
  const dispatcher = await working('orchestrator')
  const plan = (await f.service.get('alpha')).state.plans[0]!
  await f.service.callNodeActionTool('alpha', dispatcher, 'super_agent_dispatch', { requestId: 'job', id: 'job', title: 'Job', instructions: 'Continue remaining work',
    goalId: goal.id, goalRevision: goal.revision, planId: plan.id, planRevision: plan.contractRevision ?? plan.revision,
    modelEntryId: f.config.modelPool![0]!.id, thinkingLevel: 'medium', goalCriteria: [0] })
  f.host.complete(dispatcher, '')
  await working('worker')
  await until(() => f.service.get('alpha'), snapshot => snapshot.state.tasks[0]?.status === 'running' && f.host.sends.length > 0)
  await f.service.cleanup()
  const document = await loadSuperAgentDocument(join(f.root, 'alpha'))
  const majorIds = new Set(document.config!.nodes.filter(node => node.role !== 'worker').map(node => node.id))
  document.pendingTurns = document.pendingTurns.filter(turn => !majorIds.has(turn.nodeId))
  document.failedTurns = (document.failedTurns ?? []).filter(turn => !majorIds.has(turn.nodeId))
  for (const runtime of document.state.nodes.filter(node => majorIds.has(node.nodeId))) {
    const session = await f.host.createSession('alpha', {})
    runtime.sessionId = session.id; runtime.status = 'idle'
  }
  document.state.tasks.push({ ...document.state.tasks[0]!, id: 'finished', status: 'completed', phase: 'submitted', output: 'Existing finished artifact', executionAttempts: [] })
  document.state.reportCursors = { main: 1, planner: 1, orchestrator: 1 }
  document.state.eventCursors = { planner: 1, orchestrator: 1 }
  document.state.reportSequence = 1
  document.state.reports = [{ id: 'report_saved', sequence: 1, nodeId: document.state.tasks[0]!.nodeId, turnId: 'old_turn', taskId: 'job', recipientNodeId: 'orchestrator',
    kind: 'progress', content: 'Existing progress', verification: 'unverified', artifactIds: [], createdAt: f.now() }]
  await saveSuperAgentDocument(join(f.root, 'alpha'), document)
  const service = new SuperAgentService({ host: f.host, rootForWorkspace: id => join(f.root, id), autoTick: false, now: f.now })
  try {
    await service.get('alpha')
    const snapshot = await until(() => service.get('alpha'), snapshot => snapshot.recovery?.phase === 'ready')
    for (const runtime of document.state.nodes.filter(node => majorIds.has(node.nodeId))) {
      expect(snapshot.state.nodes.find(node => node.nodeId === runtime.nodeId)!.sessionId).toBe(runtime.sessionId)
    }
    expect(snapshot.state.reportCursors).toEqual(document.state.reportCursors)
    expect(snapshot.state.eventCursors).toEqual(document.state.eventCursors)
    expect(snapshot.state.reports).toEqual(document.state.reports)
    expect(snapshot.state.plans).toEqual(document.state.plans)
    expect(snapshot.state.tasks.find(task => task.id === 'finished')).toEqual(document.state.tasks[1])
    const backup = JSON.parse(await readFile(join(f.root, 'alpha', 'super-agent', 'history', 'recovery', `${snapshot.recovery!.id}.json`), 'utf8'))
    expect(backup.state.tasks.find((task: { id: string }) => task.id === 'finished').output).toBe('Existing finished artifact')
  } finally { await service.cleanup() }
})
