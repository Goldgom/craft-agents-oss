import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { loadSuperAgentDocument, saveSuperAgentDocument, type SuperAgentPlanItem } from '@craft-agent/shared/super-agent'
import { superAgentFixture as fixture, until } from './SuperAgentTestSupport'
import { SUPER_AGENT_RECOVERY_WINDOW_MS } from './SuperAgentRetry'

class ScriptProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  close(code: number) { this.exitCode = code; this.emit('close', code) }
}

async function scriptFixture(options: { stopError?: string; launchError?: string } = {}) {
  const processes: ScriptProcess[] = []
  const f = await fixture({
    resolveEnvironment: async (_workspaceId, environment) => ({ workingDirectory: environment.workingDirectory,
      status: { available: true, isolation: 'container', detail: 'Deterministic managed executor' } }),
    spawnScript: async () => {
      if (options.launchError) throw new Error(options.launchError)
      const child = new ScriptProcess(); processes.push(child)
      return { child: child as unknown as ChildProcess, stop: async () => { if (options.stopError) throw new Error(options.stopError) } }
    },
  })
  f.config.environment.kind = 'sandbox'; f.config.environment.sandbox = { runtime: 'docker', image: 'test-executor' }
  f.config.scripts = [{ id: 'check', name: 'Check', path: 'check.cjs', args: [], nodeId: 'worker', timeoutSeconds: 60 }]
  await writeFile(join(f.workingDirectory, 'check.cjs'), 'console.log("test output")')
  await f.service.save('alpha', f.config)
  const assign = async () => {
    await f.service.command('alpha', { type: 'task', title: 'Validate artifact', instructions: 'Run the required script and submit its artifact.' })
    const active = await until(() => f.service.get('alpha'), value => value.state.tasks.at(-1)?.status === 'running')
    f.host.complete(active.state.tasks.at(-1)!.sessionId!, 'Artifact submitted; script is still running.\n<super_agent_actions>{"runScripts":["check"]}</super_agent_actions>')
    return until(() => f.service.get('alpha'), value => value.state.tasks.at(-1)?.status === 'completed' && value.state.scripts[0]?.runId != null)
  }
  return { ...f, processes, assign }
}

const editPlan = (plan: SuperAgentPlanItem, status: SuperAgentPlanItem['status']) => ({ type: 'plan-upsert' as const,
  item: { id: plan.id, title: plan.title, instructions: plan.instructions, status, priority: plan.priority, note: 'Verified output' }, expectedRevision: plan.revision })

async function acknowledgeResult(f: Pick<Awaited<ReturnType<typeof scriptFixture>>, 'service' | 'host' | 'advance'>, runId: string) {
  for (let turn = 0; turn < 4; turn++) {
    const current = await until(() => f.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    const main = current.state.nodes.find(node => node.nodeId === 'main')!
    const isResult = f.host.sends.findLast(send => send.sessionId === main.sessionId)?.message.includes(`Run: ${runId}`)
    f.host.complete(main.sessionId!, 'Script evidence reviewed; preserve the original task result and update only the linked plan.')
    await until(() => f.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'idle')
    if (isResult) return f.service.get('alpha')
    f.advance(1_001); await f.service.tick()
  }
  throw new Error('The script result did not reach coordinator review')
}

describe('required asynchronous script results', () => {
  for (const errorCode of ['network_error', 'invalid_api_key']) {
    test(`suspends ${errorCode} result delivery without resetting recovery and permits manual review`, async () => {
      const context = await scriptFixture()
      context.config.idleInspectionMinutes = 1440
      await context.service.save('alpha', context.config)
      const submitted = await context.assign()
      const summary = await until(() => context.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
      const sessionId = summary.state.nodes.find(node => node.nodeId === 'main')!.sessionId!
      context.host.complete(sessionId, 'Waiting for script result.')
      await until(() => context.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'idle')
      context.processes[0]!.close(0)
      context.advance(1001); await context.service.tick()
      await until(() => context.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working'
        && context.host.sends.findLast(send => send.sessionId === sessionId)?.message.includes('This asynchronous script result') === true)
      context.host.complete(sessionId, errorCode === 'network_error' ? 'fetch failed' : 'Invalid API key', 'error', { errorCode })
      await until(() => context.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === (errorCode === 'network_error' ? 'recovering' : 'error'))
      context.advance(SUPER_AGENT_RECOVERY_WINDOW_MS); await context.service.tick()
      const expired = await context.service.get('alpha')
      expect(expired.state.nodes.find(node => node.nodeId === 'main')!.status).toBe('error')
      expect(expired.state.scripts[0]).toMatchObject({ resultPending: true, resultDeliveryPaused: true, resultDeliveryAttempts: 1 })
      const sends = context.host.sends.length
      await context.service.tick()
      expect(context.host.sends).toHaveLength(sends)
      await context.service.command('alpha', { type: 'node-refresh', nodeId: 'main' })
      await until(() => context.service.get('alpha'), () => context.host.sends.length === sends + 1)
      expect(context.host.sends.at(-1)!.message).toContain('do not repeat completed operations or restart scripts')
      context.host.complete(sessionId, 'Script evidence checked.')
      const reviewed = await until(() => context.service.get('alpha'), value => value.state.scripts[0]!.resultReportedAt != null)
      expect(reviewed.state.tasks[0]).toEqual(submitted.state.tasks[0])
      expect(context.processes).toHaveLength(1)
    })
  }

  test('network recovery retains the same result review without acknowledging it or restarting its script', async () => {
    const f = await scriptFixture()
    const submitted = await f.assign()
    const summary = await until(() => f.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    const sessionId = summary.state.nodes.find(node => node.nodeId === 'main')!.sessionId!
    f.host.complete(sessionId, 'Waiting for recorded script evidence.')
    await until(() => f.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'idle')
    f.processes[0]!.close(0)
    f.advance(1001)
    await f.service.tick()
    await until(() => f.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working'
      && f.host.sends.findLast(send => send.sessionId === sessionId)?.message.includes('This asynchronous script result') === true)
    const before = await loadSuperAgentDocument(join(f.root, 'alpha'))
    const review = before.pendingTurns.find(turn => turn.scriptRunId === submitted.state.scripts[0]!.runId)!
    f.host.complete(sessionId, 'Connection Error: Could not reach the AI service.', 'error', { errorCode: 'network_error', canRetry: true })
    const waiting = await until(() => f.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'recovering')
    expect(waiting.state.tasks[0]).toEqual(submitted.state.tasks[0])
    expect(waiting.state.scripts[0]).toMatchObject({ status: 'completed', resultDeliveryAttempts: 1 })
    expect(waiting.state.scripts[0]!.resultReportedAt).toBeUndefined()
    const durable = await loadSuperAgentDocument(join(f.root, 'alpha'))
    expect(durable.pendingTurns.find(turn => turn.scriptRunId === review.scriptRunId)).toMatchObject({ id: review.id, retryAttempt: 1 })
    f.advance(2000)
    await f.service.tick()
    await until(() => f.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working'
      && f.host.sends.findLast(send => send.sessionId === sessionId)?.message.includes('Continue this same authorized turn') === true)
    f.host.complete(sessionId, 'Recorded script result verified.')
    const delivered = await until(() => f.service.get('alpha'), value => value.state.scripts[0]?.resultReportedAt != null)
    expect(delivered.state.tasks[0]).toEqual(submitted.state.tasks[0])
    expect(delivered.state.scripts[0]!.resultDeliveryAttempts).toBe(1)
    expect(f.processes).toHaveLength(1)
  })

  test('binds a run to its assignment and prevents premature plan acceptance or deletion', async () => {
    const { service, root, assign } = await scriptFixture()
    const active = await assign()
    const task = active.state.tasks[0]!
    const runtime = active.state.scripts[0]!
    expect(runtime).toMatchObject({ status: 'running', taskId: task.id, planId: task.planId })
    expect(runtime.runId).toMatch(/^run_/)
    const persisted = await loadSuperAgentDocument(join(root, 'alpha'))
    expect(persisted.state.scripts[0]).toMatchObject({ runId: runtime.runId, taskId: task.id, planId: task.planId })
    await expect(service.command('alpha', editPlan(active.state.plans[0]!, 'completed'))).rejects.toThrow('linked scripts')
    await expect(service.command('alpha', { type: 'plan-delete', id: task.planId!, expectedRevision: active.state.plans[0]!.revision })).rejects.toThrow('linked script')
  })

  test('delivers failure directly to the coordinator on a fresh chain and leaves the submitted task intact', async () => {
    const { service, root, host, processes, assign, advance } = await scriptFixture()
    const submitted = await assign()
    const task = submitted.state.tasks[0]!
    processes[0]!.stderr.write('validation failed: artifact checksum mismatch')
    processes[0]!.close(1)
    const failed = await until(() => service.get('alpha'), value => value.state.scripts[0]?.status === 'failed')
    expect(failed.state.plans[0]!.status).toBe('blocked')
    const document = await loadSuperAgentDocument(join(root, 'alpha'))
    const result = document.pendingTurns.find(turn => turn.text.includes(`Run: ${failed.state.scripts[0]!.runId}`))!
    expect(result).toMatchObject({ nodeId: 'main', kind: 'summary', depth: 0 })
    expect(result.taskId).toBeUndefined()
    expect(result.text).toContain(task.id)
    expect(result.text).toContain('checksum mismatch')
    expect(document.pendingTurns.some(turn => turn.nodeId === 'worker' && turn.kind === 'script')).toBe(false)
    await expect(service.command('alpha', editPlan(failed.state.plans[0]!, 'completed'))).rejects.toThrow('linked scripts')
    const reviewing = await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    const main = reviewing.state.nodes.find(node => node.nodeId === 'main')!
    host.complete(main.sessionId!, 'Review the script when its execution finishes.')
    await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'idle')
    advance(1_001); await service.tick()
    await until(() => service.get('alpha'), () => host.sends.some(send => send.message.includes(`Run: ${failed.state.scripts[0]!.runId}`)))
    host.complete(main.sessionId!, 'Failure verified. Keep the linked plan blocked until authorized recovery work is assigned.')
    const reviewed = await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status !== 'working')
    expect(reviewed.state.tasks[0]).toEqual(task)
    expect(reviewed.state.plans[0]!.status).toBe('blocked')
    expect(reviewed.state.scripts[0]!.resultReportedAt).toBeDefined()
    await expect(service.command('alpha', editPlan(reviewed.state.plans[0]!, 'completed'))).rejects.toThrow('failed or stopped')
  })

  test('a successful script preserves a blocker reported by another task in the same plan', async () => {
    const { service, host, config, processes, assign } = await scriptFixture()
    config.nodes.push({ ...config.nodes[1]!, id: 'worker-two', name: 'Second worker' })
    await service.save('alpha', config)
    const submitted = await assign()
    await service.command('alpha', { type: 'task', title: 'Review', instructions: 'Review the artifact', nodeId: 'worker-two', planId: submitted.state.plans[0]!.id })
    let snapshot = await until(() => service.get('alpha'), value => value.state.tasks[1]?.status === 'running')
    host.complete(snapshot.state.tasks[1]!.sessionId!, 'Review failed', 'error')
    snapshot = await until(() => service.get('alpha'), value => value.state.plans[0]?.status === 'blocked')
    const blockedPlan = { ...snapshot.state.plans[0]! }
    processes[0]!.close(0)
    snapshot = await until(() => service.get('alpha'), value => value.state.scripts[0]?.status === 'completed')
    expect(snapshot.state.plans[0]).toEqual(blockedPlan)
    expect(snapshot.state.scripts[0]!.resultQueuedAt).toBeDefined()
  })

  test('a successful run remains active until its output is verified', async () => {
    const f = await scriptFixture()
    const { service, processes, assign } = f
    await assign()
    processes[0]!.stdout.write('validated artifact revision 12')
    processes[0]!.close(0)
    const completed = await until(() => service.get('alpha'), value => value.state.scripts[0]?.status === 'completed')
    expect(completed.state.plans[0]!.status).toBe('active')
    expect(completed.state.plans[0]!.note).toContain('verify its output')
    expect(completed.state.scripts[0]!.resultReportedAt).toBeUndefined()
    await expect(service.command('alpha', editPlan(completed.state.plans[0]!, 'completed'))).rejects.toThrow('linked scripts')
    const reviewed = await acknowledgeResult(f, completed.state.scripts[0]!.runId!)
    const verified = await service.command('alpha', editPlan(reviewed.state.plans[0]!, 'completed'))
    expect(verified.state.plans[0]!.status).toBe('completed')
  })

  test('stopping an assigned run blocks acceptance and emits only one terminal report after close', async () => {
    const f = await scriptFixture()
    const { service, root, processes, assign } = f
    await assign()
    const stopped = await service.command('alpha', { type: 'script-stop', scriptId: 'check' })
    expect(stopped.state.scripts[0]!.status).toBe('stopped')
    expect(stopped.state.plans[0]!.status).toBe('blocked')
    const runId = stopped.state.scripts[0]!.runId!
    processes[0]!.close(1); processes[0]!.close(1)
    await until(() => service.get('alpha'), value => value.state.scripts[0]?.exitCode === 1)
    const document = await loadSuperAgentDocument(join(root, 'alpha'))
    expect(document.pendingTurns.filter(turn => turn.text.includes(`Run: ${runId}`))).toHaveLength(1)
    expect(document.state.messages.filter(message => message.toNodeId === 'main' && message.body.includes(`Run: ${runId}`))).toHaveLength(1)
    const reviewed = await acknowledgeResult(f, runId)
    await expect(service.command('alpha', editPlan(reviewed.state.plans[0]!, 'completed'))).rejects.toThrow('failed or stopped')
    const cancelled = await service.command('alpha', editPlan(reviewed.state.plans[0]!, 'cancelled'))
    expect(cancelled.state.plans[0]!.status).toBe('cancelled')
  })

  test('an unconfirmed remote exit blocks the plan and prevents starting another run', async () => {
    const { service, processes, assign } = await scriptFixture({ stopError: 'Remote executor unavailable' })
    await assign(); processes[0]!.close(0)
    const untracked = await until(() => service.get('alpha'), value => value.state.scripts[0]?.status === 'untracked')
    expect(untracked.state.plans[0]!.status).toBe('blocked')
    expect(untracked.state.scripts[0]!.error).toContain('Remote executor unavailable')
    await expect(service.command('alpha', editPlan(untracked.state.plans[0]!, 'completed'))).rejects.toThrow('linked scripts')
    await expect(service.command('alpha', { type: 'script-run', scriptId: 'check' })).rejects.toThrow('untracked')
  })

  test('an adapter launch failure becomes a blocked result and a rejected action receipt', async () => {
    const { service, assign, root } = await scriptFixture({ launchError: 'Cannot launch managed executor' })
    const failed = await assign()
    expect(failed.state.scripts[0]).toMatchObject({ status: 'failed', taskId: failed.state.tasks[0]!.id, error: 'Cannot launch managed executor' })
    expect(failed.state.plans[0]!.status).toBe('blocked')
    expect(failed.state.tasks[0]!.actionReceipt).toMatchObject({ status: 'rejected', rejected: { type: 'script-run', error: 'Cannot launch managed executor' } })
    const persisted = await loadSuperAgentDocument(join(root, 'alpha'))
    expect(persisted.state.tasks[0]!.actionReceipt).toEqual(failed.state.tasks[0]!.actionReceipt)
    expect(persisted.pendingTurns.some(turn => turn.nodeId === 'main' && turn.text.includes('Cannot launch managed executor'))).toBe(true)
    await expect(service.command('alpha', editPlan(failed.state.plans[0]!, 'completed'))).rejects.toThrow('linked scripts')
  })

  test('manual runs carry no assignment and cannot block unrelated plans', async () => {
    const { service, processes } = await scriptFixture()
    const planned = await service.command('alpha', { type: 'plan-upsert', item: { id: 'other-plan', title: 'Other artifact', instructions: 'Verify unrelated output', status: 'active', priority: 3, note: '' }, expectedRevision: 0 })
    await service.command('alpha', { type: 'script-run', scriptId: 'check' })
    expect((await service.get('alpha')).state.scripts[0]!.taskId).toBeUndefined()
    const accepted = await service.command('alpha', editPlan(planned.state.plans[0]!, 'completed'))
    expect(accepted.state.plans[0]!.status).toBe('completed')
    processes[0]!.close(1)
    const failed = await until(() => service.get('alpha'), value => value.state.scripts[0]?.status === 'failed')
    expect(failed.state.plans[0]!.status).toBe('completed')
    expect(failed.state.scripts[0]!.planId).toBeUndefined()
  })

  test('restores legacy running associations as blocked and queues inspection without replaying the script', async () => {
    const { service, root, config } = await fixture()
    config.scripts = [{ id: 'legacy-check', name: 'Legacy check', path: 'check.cjs', args: [], nodeId: 'worker', timeoutSeconds: 60 }]
    const document = await loadSuperAgentDocument(join(root, 'alpha'))
    document.config = config
    document.state.nodes = config.nodes.map(node => ({ nodeId: node.id, status: 'idle' }))
    document.state.tasks = [{ id: 'legacy-task', planId: 'legacy-plan', title: 'Legacy artifact', instructions: 'Validate artifact', nodeId: 'worker', status: 'completed', createdAt: 1, completedAt: 2 }]
    document.state.plans = [{ id: 'legacy-plan', title: 'Legacy artifact', instructions: 'Validate artifact', status: 'completed', priority: 3, note: 'Accepted too early', revision: 1, updatedBy: 'main', updatedAt: 2 }]
    document.state.scripts = [{ scriptId: 'legacy-check', taskId: 'legacy-task', status: 'running', startedAt: 1 }]
    await saveSuperAgentDocument(join(root, 'alpha'), document)
    const recovered = await service.get('alpha')
    expect(recovered.state.scripts[0]).toMatchObject({ status: 'untracked', taskId: 'legacy-task', planId: 'legacy-plan' })
    expect(recovered.state.plans[0]!.status).toBe('blocked')
    const saved = await loadSuperAgentDocument(join(root, 'alpha'))
    expect(saved.pendingTurns.find(turn => turn.text.includes('legacy-check'))).toMatchObject({ nodeId: 'main', kind: 'summary', depth: 0 })
    await expect(service.command('alpha', { type: 'script-run', scriptId: 'legacy-check' })).rejects.toThrow('untracked')
    expect((await service.get('alpha')).state.tasks[0]!.status).toBe('completed')
  })

  test('holds a terminal report durably when the queue is full and flushes it after a slot opens', async () => {
    const { service, root, config, host } = await fixture()
    config.environment.permissions.runPrograms = false
    config.scripts = [{ id: 'check', name: 'Check', path: 'check.cjs', args: [], nodeId: 'worker', timeoutSeconds: 60 }]
    const session = await host.createSession('alpha', {}); host.sessions.get(session.id)!.isProcessing = true
    const document = await loadSuperAgentDocument(join(root, 'alpha'))
    document.config = config
    document.state.nodes = [{ nodeId: 'main', sessionId: session.id, status: 'working' }, { nodeId: 'worker', status: 'idle' }]
    document.state.plans = [{ id: 'plan-one', title: 'Required check', instructions: 'Validate artifact', status: 'blocked', priority: 3, note: 'Failure', revision: 1, updatedBy: 'system', updatedAt: 1 }]
    document.state.scripts = [{ scriptId: 'check', runId: 'run_one', planId: 'plan-one', status: 'failed', completedAt: 1, resultPending: true, error: 'queued result' }]
    document.pendingTurns = Array.from({ length: 200 }, (_, index) => ({ id: `turn_${index}`, nodeId: 'main', kind: 'chat' as const, text: 'Already queued work', createdAt: 1, depth: 0, chainId: `turn_${index}`, ...(index === 0 ? { startedAt: 1 } : {}) }))
    await saveSuperAgentDocument(join(root, 'alpha'), document)
    const full = await service.get('alpha')
    expect(full.state.scripts[0]!.resultPending).toBe(true)
    expect((await loadSuperAgentDocument(join(root, 'alpha'))).pendingTurns).toHaveLength(200)
    await expect(service.command('alpha', { type: 'script-run', scriptId: 'check' })).rejects.toThrow('previous script result')
    host.complete(session.id, 'Current turn finished.')
    const delivered = await until(() => service.get('alpha'), value => value.state.scripts[0]?.resultQueuedAt != null)
    expect(delivered.state.scripts[0]!.resultPending).toBe(false)
    expect(delivered.state.scripts[0]!.resultReportedAt).toBeUndefined()
    const saved = await loadSuperAgentDocument(join(root, 'alpha'))
    expect(saved.pendingTurns.filter(turn => turn.text.includes('Run: run_one'))).toHaveLength(1)
    expect(saved.pendingTurns).toHaveLength(200)
    await service.tick()
    expect((await loadSuperAgentDocument(join(root, 'alpha'))).pendingTurns.filter(turn => turn.text.includes('Run: run_one'))).toHaveLength(1)
  })

  test('bounds rejected coordinator sends, retains the result and resumes only after explicit inspection', async () => {
    const f = await scriptFixture()
    await f.assign()
    const initial = await until(() => f.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    const mainId = initial.state.nodes.find(node => node.nodeId === 'main')!.sessionId!
    f.host.complete(mainId, 'Waiting for script evidence.')
    await until(() => f.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'idle')
    const send = f.host.sendMessage.bind(f.host)
    let rejected = 0
    f.host.sendMessage = async (sessionId, text) => {
      if (text.includes('This asynchronous script result')) { rejected++; throw new Error('Provider unavailable during result delivery') }
      await send(sessionId, text)
    }
    f.processes[0]!.close(0)
    for (let attempt = 1; attempt <= 3; attempt++) {
      f.advance(1_001); await f.service.tick()
      await until(() => f.service.get('alpha'), value => rejected === attempt
        && value.state.nodes.find(node => node.nodeId === 'main')?.status === 'error')
    }
    const exhausted = await f.service.get('alpha')
    expect(rejected).toBe(3)
    expect(exhausted.state.scripts[0]).toMatchObject({ status: 'completed', resultPending: true, resultDeliveryAttempts: 3 })
    expect(exhausted.state.scripts[0]!.resultReportedAt).toBeUndefined()
    expect(exhausted.state.plans[0]!.status).toBe('blocked')
    expect(exhausted.state.messages.some(message => message.toNodeId === 'user' && message.body.includes('automatic delivery is suspended'))).toBe(true)
    for (let tick = 0; tick < 3; tick++) { f.advance(1_001); await f.service.tick() }
    expect(rejected).toBe(3)
    const persisted = await loadSuperAgentDocument(join(f.root, 'alpha'))
    expect(persisted.pendingTurns.some(turn => turn.scriptRunId === exhausted.state.scripts[0]!.runId)).toBe(false)
    expect(persisted.state.scripts[0]!.resultDeliveryError).toContain('Provider unavailable')
    f.host.sendMessage = send
    await f.service.command('alpha', { type: 'inspect' })
    f.advance(1_001); await f.service.tick()
    const acknowledged = await acknowledgeResult(f, exhausted.state.scripts[0]!.runId!)
    expect(acknowledged.state.scripts[0]!.resultReportedAt).toBeDefined()
    expect(acknowledged.state.scripts[0]!.resultDeliveryAttempts).toBe(1)
    expect(f.processes).toHaveLength(1)
  })

  test('requeues an interrupted result review after restart without acknowledging or rerunning its task', async () => {
    const { service, root, host, config } = await fixture()
    const main = await host.createSession('alpha', {})
    config.scripts = [{ id: 'check', name: 'Check', path: 'check.cjs', args: [], nodeId: 'worker', timeoutSeconds: 60 }]
    const document = await loadSuperAgentDocument(join(root, 'alpha'))
    document.config = config
    document.state.nodes = [{ nodeId: 'main', sessionId: main.id, status: 'working' }, { nodeId: 'worker', status: 'idle' }]
    const task = { id: 'task-original', planId: 'plan-one', title: 'Required artifact', instructions: 'Run validation', nodeId: 'worker', status: 'completed' as const, createdAt: 1, completedAt: 2, output: 'Original submitted evidence' }
    document.state.tasks = [task]
    document.state.plans = [{ id: 'plan-one', title: task.title, instructions: task.instructions, status: 'active', priority: 3, note: 'Awaiting verification', revision: 1, updatedBy: 'worker', updatedAt: 2 }]
    document.state.scripts = [{ scriptId: 'check', runId: 'run_original', taskId: task.id, planId: 'plan-one', status: 'completed', exitCode: 0, completedAt: 2, output: 'Result artifact checksum A', resultQueuedAt: 3, resultDeliveryAttempts: 1 }]
    document.pendingTurns = [{ id: 'turn_interrupted', nodeId: 'main', kind: 'summary', text: 'Lost result review', scriptRunId: 'run_original', createdAt: 3, startedAt: 4, depth: 0, chainId: 'turn_interrupted' }]
    await saveSuperAgentDocument(join(root, 'alpha'), document)
    const recovered = await service.get('alpha')
    expect(recovered.state.scripts[0]).toMatchObject({ status: 'completed', resultDeliveryAttempts: 2 })
    expect(recovered.state.scripts[0]!.resultReportedAt).toBeUndefined()
    expect(recovered.state.plans[0]!.status).toBe('blocked')
    const saved = await loadSuperAgentDocument(join(root, 'alpha'))
    expect(saved.pendingTurns.some(turn => turn.id === 'turn_interrupted')).toBe(false)
    expect(saved.pendingTurns.filter(turn => turn.scriptRunId === 'run_original')).toHaveLength(1)
    expect(saved.pendingTurns[0]!.text).toContain('Result artifact checksum A')
    const working = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    expect(working.state.nodes[0]!.sessionId).not.toBe(main.id)
    host.complete(main.id, 'Late completion from the interrupted result review.')
    const afterLate = await service.get('alpha')
    expect(afterLate.state.scripts[0]!.resultReportedAt).toBeUndefined()
    expect(afterLate.state.nodes[0]).toMatchObject({ status: 'working', sessionId: working.state.nodes[0]!.sessionId })
    host.complete(working.state.nodes[0]!.sessionId!, 'Recovered script evidence reviewed successfully.')
    const reported = await until(() => service.get('alpha'), value => value.state.scripts[0]?.resultReportedAt != null)
    expect(reported.state.tasks[0]).toEqual(task)
    expect((await loadSuperAgentDocument(join(root, 'alpha'))).pendingTurns.some(turn => turn.scriptRunId === 'run_original')).toBe(false)
    host.complete(main.id, 'Duplicate late completion should not schedule another review.')
    expect((await service.get('alpha')).state.scripts[0]!.resultReportedAt).toBe(reported.state.scripts[0]!.resultReportedAt)
    expect((await service.get('alpha')).state.tasks[0]).toEqual(task)
  })

  test('a user stop pauses a running script result and explicit inspection delivers it without rerunning', async () => {
    const f = await scriptFixture()
    const active = await f.assign()
    await f.service.command('alpha', { type: 'cancel' })
    f.processes[0]!.close(0)
    const held = await until(() => f.service.get('alpha'), value => value.state.scripts[0]?.status === 'completed')
    expect(held.state.scripts[0]).toMatchObject({ resultPending: true, resultDeliveryPaused: true })
    expect(held.state.scripts[0]!.resultQueuedAt).toBeUndefined()
    const sentBeforeTick = f.host.sends.length
    f.advance(60_001); await f.service.tick()
    expect(f.host.sends).toHaveLength(sentBeforeTick)
    expect((await loadSuperAgentDocument(join(f.root, 'alpha'))).pendingTurns.some(turn => turn.scriptRunId === active.state.scripts[0]!.runId)).toBe(false)
    await f.service.command('alpha', { type: 'inspect' })
    f.advance(1_001); await f.service.tick()
    const acknowledged = await acknowledgeResult(f, active.state.scripts[0]!.runId!)
    expect(acknowledged.state.scripts[0]).toMatchObject({ resultPending: false, resultDeliveryPaused: false })
    expect(acknowledged.state.scripts[0]!.resultReportedAt).toBeDefined()
    expect(f.processes).toHaveLength(1)
  })

  for (const coordinatorState of ['working', 'preparing'] as const) {
    test(`partial task cancellation removes its script review without cancelling unrelated coordinator work that is ${coordinatorState}`, async () => {
      const f = await scriptFixture()
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const ensureSettings = f.host.ensureSuperAgentSessionSettings.bind(f.host)
      f.host.ensureSuperAgentSessionSettings = async (sessionId, settings) => {
        if (coordinatorState === 'preparing' && f.host.policies.get(sessionId)?.role === 'coordinator') await gate
        await ensureSettings(sessionId, settings)
      }
      try {
        const active = await f.assign()
        const mainState = await until(() => f.service.get('alpha'), value => {
          const main = value.state.nodes.find(node => node.nodeId === 'main')
          return main?.status === coordinatorState && main.sessionId != null
        })
        const mainId = mainState.state.nodes.find(node => node.nodeId === 'main')!.sessionId!
        f.processes[0]!.close(0)
        await until(() => f.service.get('alpha'), value => value.state.scripts[0]?.resultQueuedAt != null)
        await f.service.command('alpha', { type: 'cancel', taskId: active.state.tasks[0]!.id })
        const cancelled = await f.service.get('alpha')
        expect(cancelled.state.scripts[0]).toMatchObject({ resultPending: true, resultDeliveryPaused: true })
        expect(cancelled.state.scripts[0]!.resultQueuedAt).toBeUndefined()
        expect(cancelled.state.nodes.find(node => node.nodeId === 'main')).toMatchObject({ status: coordinatorState, sessionId: mainId })
        expect(f.host.cancelled).not.toContain(mainId)
        const saved = await loadSuperAgentDocument(join(f.root, 'alpha'))
        expect(saved.pendingTurns.some(turn => turn.scriptRunId === active.state.scripts[0]!.runId)).toBe(false)
        expect(saved.pendingTurns.some(turn => turn.nodeId === 'main' && turn.text.includes('Worker worker finished task'))).toBe(true)
        release()
        await until(() => f.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
        f.host.complete(mainId, 'The unrelated worker result has been recorded.')
        await until(() => f.service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'idle')
        f.advance(5_001); await f.service.tick()
        const held = await f.service.get('alpha')
        expect(held.state.scripts[0]!.resultReportedAt).toBeUndefined()
        expect(held.state.tasks[0]).toEqual(active.state.tasks[0])
      } finally { release() }
    })
  }

  test('a failed stop immediately reports an untracked run and blocks its plan', async () => {
    const f = await scriptFixture({ stopError: 'Stop request timed out' })
    await f.assign()
    await expect(f.service.command('alpha', { type: 'script-stop', scriptId: 'check' })).rejects.toThrow('Stop request timed out')
    const stopped = await f.service.get('alpha')
    expect(stopped.state.scripts[0]!.status).toBe('untracked')
    expect(stopped.state.plans[0]!.status).toBe('blocked')
    const saved = await loadSuperAgentDocument(join(f.root, 'alpha'))
    expect(saved.pendingTurns.some(turn => turn.scriptRunId === stopped.state.scripts[0]!.runId && turn.text.includes('Stop request timed out'))).toBe(true)
    f.processes[0]!.close(1)
    await until(() => f.service.get('alpha'), value => value.state.scripts[0]?.exitCode === 1)
    expect((await loadSuperAgentDocument(join(f.root, 'alpha'))).pendingTurns.filter(turn => turn.scriptRunId === stopped.state.scripts[0]!.runId)).toHaveLength(1)
  })

  for (const status of ['completed', 'failed', 'stopped'] as const) {
    test(`a missing file preserves a ${status} run before and after review`, async () => {
      const f = await fixture()
      const path = join(f.workingDirectory, 'check.cjs')
      await writeFile(path, 'console.log("original script")')
      f.config.scripts = [{ id: 'check', name: 'Check', path: 'check.cjs', args: [], nodeId: 'worker', timeoutSeconds: 60 }]
      const document = await loadSuperAgentDocument(join(f.root, 'alpha'))
      document.config = f.config
      document.state.nodes = f.config.nodes.map(node => ({ nodeId: node.id, status: 'idle' }))
      document.state.tasks = [{ id: 'task-one', planId: 'plan-one', title: 'Required check', instructions: 'Verify artifact', nodeId: 'worker', status: 'completed', createdAt: 1, completedAt: 2 }]
      document.state.plans = [{ id: 'plan-one', title: 'Required check', instructions: 'Verify artifact', status: status === 'completed' ? 'active' : 'blocked', priority: 3, note: 'Review required', revision: 1, updatedBy: 'system', updatedAt: 2 }]
      document.state.scripts = [{ scriptId: 'check', runId: 'run_one', taskId: 'task-one', planId: 'plan-one', status, exitCode: status === 'completed' ? 0 : 1, completedAt: 2, output: 'immutable execution evidence', ...(status === 'failed' ? { error: 'original validation failure' } : {}), resultPending: true }]
      await saveSuperAgentDocument(join(f.root, 'alpha'), document)
      const initial = await f.service.get('alpha')
      await unlink(path)
      f.advance(5_001); await f.service.tick()
      const missing = await f.service.get('alpha')
      expect(missing.state.scripts[0]).toEqual(initial.state.scripts[0])
      const scanNotices = missing.state.messages.filter(message => message.toNodeId === 'main' && message.body.includes('Cannot inspect script file'))
      expect(scanNotices).toHaveLength(1)
      expect(scanNotices[0]!.body).toContain(`remains ${status}`)
      f.advance(5_001); await f.service.tick()
      expect((await f.service.get('alpha')).state.messages.filter(message => message.toNodeId === 'main' && message.body.includes('Cannot inspect script file'))).toHaveLength(1)
      const reviewed = await acknowledgeResult(f, 'run_one')
      expect(reviewed.state.scripts[0]).toMatchObject({ status, runId: 'run_one', output: 'immutable execution evidence' })
      f.advance(5_001); await f.service.tick()
      const afterReview = await f.service.get('alpha')
      expect(afterReview.state.scripts[0]).toEqual(reviewed.state.scripts[0])
      if (status === 'completed') {
        expect((await f.service.command('alpha', editPlan(afterReview.state.plans[0]!, 'completed'))).state.plans[0]!.status).toBe('completed')
      } else {
        await expect(f.service.command('alpha', editPlan(afterReview.state.plans[0]!, 'completed'))).rejects.toThrow('failed or stopped')
      }
    })
  }
})
