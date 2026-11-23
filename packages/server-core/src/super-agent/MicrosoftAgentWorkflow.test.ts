import { afterEach, describe, expect, test } from 'bun:test'
import { MicrosoftAgentWorkflow, type SuperAgentWorkflowEvent } from './MicrosoftAgentWorkflow'
import { superAgentFixture, until } from './SuperAgentTestSupport'
import { loadSuperAgentDocument, withSuperAgentOrchestrator } from '@tokenbird/shared/super-agent'
import { join } from 'node:path'

const workflows: MicrosoftAgentWorkflow[] = []
afterEach(() => { for (const workflow of workflows.splice(0)) workflow.close() })
const nodes = [{ id: 'main', role: 'coordinator' as const }, { id: 'worker', role: 'worker' as const }, { id: 'reviewer', role: 'worker' as const }]
function workflow() { const value = new MicrosoftAgentWorkflow(); workflows.push(value); return value }

// An explicit interpreter opts into the real SDK integration suite on developer/CI hosts.
describe.skipIf(!process.env.TOKENBIRD_AGENT_FRAMEWORK_PYTHON)('Microsoft Agent Framework session orchestration', () => {
  test('suspends for an external session response, streams SDK events, then resumes without reinvocation', async () => {
    const engine = workflow()
    await engine.prepare()
    const events: SuperAgentWorkflowEvent[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    let completed = false
    const execution = engine.run({ nodeId: 'worker', kind: 'task', nodes }, async () => { calls++; await gate }, event => events.push(event)).then(() => { completed = true })
    await until(async () => calls, value => value === 1)
    await until(async () => events, values => values.some(event => event.type === 'status' && event.state === 'IDLE_WITH_PENDING_REQUESTS'))
    expect(completed).toBe(false)
    expect(events.some(event => event.executorId === 'team-router')).toBe(true)
    release()
    await execution
    expect(calls).toBe(1)
    expect(events.filter(event => event.type === 'executor_invoked' && event.executorId === 'session:worker')).toHaveLength(2)
    expect(events.some(event => event.type === 'status' && event.state === 'IDLE')).toBe(true)
  }, 150_000)
  test('runs intent, orchestration and execution through the real three-role graph', async () => {
    const engine = workflow()
    await engine.prepare()
    const f = await superAgentFixture({ workflow: engine })
    f.config = withSuperAgentOrchestrator(f.config)
    await f.service.save('alpha', f.config)
    await f.service.command('alpha', { type: 'chat', text: 'Deliver a verified report.' })
    await until(() => f.service.get('alpha'), () => f.host.sends.length === 1)
    const intent = { goal: 'Deliver a verified report.', constraints: [], deliverables: ['report.md'], acceptanceCriteria: ['Cite sources'] }
    f.host.complete(f.host.sends[0]!.sessionId, `<super_agent_actions>${JSON.stringify({ intent })}</super_agent_actions>`)
    await until(() => f.service.get('alpha'), () => f.host.sends.length === 2)
    expect(JSON.parse(f.host.sends[1]!.message).goal).toBe(intent.goal)
    expect(f.host.sends[1]!.message).toBe(JSON.stringify(intent))
    expect(f.host.policies.get(f.host.sends[1]!.sessionId)!.role).toBe('orchestrator')
    expect(f.host.policies.get(f.host.sends[1]!.sessionId)!.runPrograms).toBe(false)
    f.host.complete(f.host.sends[1]!.sessionId, `<super_agent_actions>${JSON.stringify({ tasks: [{ id: 'report', title: 'Report', instructions: 'Prepare report.md with checked sources.', nodeId: 'worker' }] })}</super_agent_actions>`)
    await until(() => f.service.get('alpha'), () => f.host.sends.length === 3)
    expect(f.host.sends[2]!.message).toBe('Prepare report.md with checked sources.')
    expect(f.host.sends[2]!.context).toContain('"fromNodeId":"orchestrator"')
    f.host.complete(f.host.sends[2]!.sessionId, 'Verified report.md with checked sources.')
    expect((await until(() => f.service.get('alpha'), s => s.state.tasks[0]?.status === 'completed')).state.tasks[0]!.id).toBe('report')
    const failure = await engine.run({ nodeId: 'orchestrator', kind: 'task', nodes: f.config.nodes }, async () => { throw new Error('Must not execute') }).catch(error => error)
    expect(failure.message).toContain('Tasks must execute on worker nodes')
  }, 150_000)
  test('routes all four roles and rejects an incomplete planning topology before invocation', async () => {
    const engine = workflow()
    const team = [...nodes, { id: 'planner', role: 'planner' as const }, { id: 'dispatch', role: 'orchestrator' as const }]
    const calls: string[] = []
    for (const node of team) {
      await engine.run({ nodes: team, nodeId: node.id, kind: node.role === 'worker' ? 'task' : 'message' }, async () => { calls.push(node.id) })
    }
    const failure = await engine.run({ nodes: team.filter(n => n.role !== 'orchestrator'), nodeId: 'planner', kind: 'message' },
      async () => { calls.push('unexpected') }).catch(error => error)
    expect(failure.message).toContain('Invalid orchestration topology')
    expect(calls).toEqual(team.map(node => node.id))
  }, 150_000)

  test('executes independent node workflows concurrently and propagates session errors', async () => {
    const engine = workflow()
    const invoked: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = engine.run({ nodeId: 'worker', kind: 'task', nodes }, async () => { invoked.push('worker'); await gate })
    const second = engine.run({ nodeId: 'reviewer', kind: 'task', nodes }, async () => { invoked.push('reviewer'); release() })
    await Promise.all([first, second])
    expect(invoked.sort()).toEqual(['reviewer', 'worker'])
    // Await subprocess I/O before synchronous assertions (Bun's .rejects can stall pipe flushes).
    const failure = await engine.run({ nodeId: 'worker', kind: 'task', nodes }, async () => { throw new Error('SESSION_FAILURE_EVIDENCE') }).catch(error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain('SESSION_FAILURE_EVIDENCE')
    let illegalCalls = 0
    const coordinatorFailure = await engine.run({ nodeId: 'main', kind: 'task', nodes }, async () => { illegalCalls++ }).catch(error => error)
    expect(coordinatorFailure.message).toContain('Tasks must execute on worker nodes')
    const unknownFailure = await engine.run({ nodeId: 'missing', kind: 'message', nodes }, async () => { illegalCalls++ }).catch(error => error)
    expect(unknownFailure.message).toContain('Unknown workflow target')
    expect(illegalCalls).toBe(0)
  }, 150_000)

  test('routes a coordinator assignment through the real framework with only upstream text visible', async () => {
    const context = await superAgentFixture({ workflow: workflow() })
    await context.service.save('alpha', context.config)
    await context.service.command('alpha', { type: 'chat', text: 'Prepare a bounded report' })
    // SDK startup is allowed a longer deadline than ordinary deterministic scheduler tests.
    for (let i = 0; i < 600 && !context.host.sends.length; i++) await new Promise(resolve => setTimeout(resolve, 200))
    expect(context.host.sends[0]!.message).toBe('Prepare a bounded report')
    const main = context.host.sends[0]!.sessionId
    const instructions = 'Read the assigned input and write the agreed report.'
    context.host.complete(main, `<super_agent_actions>${JSON.stringify({ tasks: [{ nodeId: 'worker', title: 'Bounded report', instructions }] })}</super_agent_actions>`)
    await until(() => context.service.get('alpha'), () => context.host.sends.length === 2)
    const worker = context.host.sends[1]!
    expect(worker.message).toBe(instructions)
    expect(worker.message).not.toContain('Current team state')
    expect(worker.context).toContain('"fromNodeId":"main"')
    expect(context.host.options.get(worker.sessionId)!.agentSystemPrompt).toContain('长期分工')
    await until(() => context.service.get('alpha'), state => !!state.state.nodes.find(node => node.nodeId === 'worker')?.workflow?.events.some(event => event.type === 'status'))
    const persisted = await loadSuperAgentDocument(join(context.root, 'alpha'))
    expect(persisted.state.nodes.find(node => node.nodeId === 'worker')!.workflow!.events.length).toBeGreaterThan(0)
    context.host.complete(worker.sessionId, '已验证完成：report.md；证据：输入逐项核对。')
    expect((await until(() => context.service.get('alpha'), state => state.state.tasks[0]?.status === 'completed')).state.tasks[0]!.output).toContain('report.md')
  }, 150_000)
})

test('an unavailable Python runtime fails without executing a node', async () => {
  const engine = new MicrosoftAgentWorkflow('tokenbird-nonexistent-python-runtime')
  workflows.push(engine)
  let calls = 0
  await expect(engine.run({ nodeId: 'worker', kind: 'task', nodes }, async () => { calls++ })).rejects.toThrow('TOKENBIRD_AGENT_FRAMEWORK_PYTHON')
  expect(calls).toBe(0)
})
