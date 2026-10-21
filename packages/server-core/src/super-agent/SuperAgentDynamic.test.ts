import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { activeSuperAgentNodes, loadSuperAgentDocument, rebuildSuperAgentConfig } from '@tokenbird/shared/super-agent'
import { superAgentFixture, until } from './SuperAgentTestSupport'
import { appendSuperAgentReport } from './SuperAgentDynamic'
import { SuperAgentService } from './SuperAgentService'
import { readFile, readdir } from 'node:fs/promises'

async function fixture() {
  const f = await superAgentFixture()
  const config = rebuildSuperAgentConfig(f.config)
  config.maxConcurrentSubagents = 1
  config.reportCheckSeconds = 5
  await f.service.save('alpha', config)
  return { ...f, config }
}

async function working(f: Awaited<ReturnType<typeof fixture>>, role: string) {
  const snapshot = await until(() => f.service.get('alpha'), value => value.state.nodes.some(runtime =>
    runtime.status === 'working' && value.config?.nodes.find(node => node.id === runtime.nodeId)?.role === role
    && f.host.sends.some(send => send.sessionId === runtime.sessionId)))
  return snapshot.state.nodes.find(runtime => runtime.status === 'working' && snapshot.config?.nodes.find(node => node.id === runtime.nodeId)?.role === role)!.sessionId!
}

describe('Rebuilt Super Agent', () => {
  test('advances four submitted modules to integration and delivers the goal without extra review agents', async () => {
    const f = await fixture()
    f.config.maxConcurrentSubagents = 4
    await f.service.save('alpha', f.config)
    await f.service.command('alpha', { type: 'chat', text: 'Build and integrate four modules; self-check the result.' })
    const interaction = await working(f, 'coordinator')
    await f.service.callNodeActionTool('alpha', interaction, 'super_agent_intent', { requestId: 'goal',
      goal: 'Build and integrate four modules', constraints: [], deliverables: ['Integrated build'], acceptanceCriteria: ['Modules work', 'Integrated build works'] })
    f.host.complete(interaction, '')
    const planner = await working(f, 'orchestrator')
    const goal = (await f.service.get('alpha')).state.intents![0]!
    const common = { modelEntryId: f.config.modelPool![0]!.id, thinkingLevel: 'high', goalId: goal.id, planId: 'build-plan' }
    await f.service.callNodeActionTool('alpha', planner, 'super_agent_plan', { requestId: 'plan', id: 'build-plan', goalId: goal.id, title: 'Build',
      instructions: 'Integrate the modules and self-check', status: 'planned', priority: 1, note: '', expectedRevision: 0 })
    for (const id of ['core', 'enemies', 'presentation', 'docs']) {
      await f.service.callNodeActionTool('alpha', planner, 'super_agent_dispatch', { requestId: id, ...common, id, title: id,
        instructions: `Implement and self-check ${id}`, acceptanceCriteria: ['Module self-check passes'], goalCriteria: [0] })
    }
    f.host.complete(planner, '')
    f.advance(2_000)
    await f.service.command('alpha', { type: 'board-upsert', item: { title: 'Integration contract', content: 'Combine all four module outputs' }, expectedRevision: 0 })
    await f.service.tick()
    const integrationPlanner = await working(f, 'orchestrator')
    await f.service.callNodeActionTool('alpha', integrationPlanner, 'super_agent_dispatch', { requestId: 'integration', ...common, id: 'integration',
      title: 'Integrate', instructions: 'Integrate and run the build', dependsOn: ['core', 'enemies', 'presentation', 'docs'],
      acceptanceCriteria: ['Build passes'], goalCriteria: [1] })
    f.host.complete(integrationPlanner, '')
    const parallel = await until(() => f.service.get('alpha'), value => value.state.tasks.filter(task => task.status === 'running').length === 4
      && value.state.tasks.filter(task => task.status === 'running').every(task => f.host.sends.some(send => send.sessionId === task.sessionId)))
    expect(parallel.state.tasks.find(task => task.id === 'integration')!.status).toBe('queued')
    for (const task of parallel.state.tasks.filter(task => task.status === 'running')) f.host.complete(task.sessionId!, `${task.title}: self-check passed`)
    const integrated = await until(() => f.service.get('alpha'), value => value.state.tasks.find(task => task.id === 'integration')?.status === 'running'
      && f.host.sends.some(send => send.sessionId === value.state.tasks.find(task => task.id === 'integration')?.sessionId))
    f.host.complete(integrated.state.tasks.find(task => task.id === 'integration')!.sessionId!, 'Integrated build passed')
    await until(() => f.service.get('alpha'), value => value.state.tasks.every(task => task.status === 'completed'))
    f.advance(2_000)
    await f.service.tick()
    const nextPlanner = await working(f, 'orchestrator')
    const currentPlan = (await f.service.get('alpha')).state.plans.find(plan => plan.id === 'build-plan')!
    await f.service.callNodeActionTool('alpha', nextPlanner, 'super_agent_plan', { requestId: 'finish', id: currentPlan.id,
      title: currentPlan.title, instructions: currentPlan.instructions, status: 'completed', priority: 1, note: 'Actual build passed', expectedRevision: currentPlan.revision })
    const completed = await f.service.get('alpha')
    expect(completed.state.intents![0]!.status).toBe('delivered')
    expect(completed.state.tasks).toHaveLength(5)
    expect(completed.state.tasks.every(task => !task.reviewOf && !task.requiresIndependentReview && !task.acceptance)).toBe(true)
  })

  test('uses the same model for separate task subagents without inheriting a model persona or transcript', async () => {
    const f = await fixture()
    const entry = f.config.modelPool![0]!
    entry.capabilityNotes = 'Good at code analysis. Model selection metadata, never a work instruction'
    await f.service.save('alpha', f.config)
    for (const id of ['first-model-task', 'second-model-task']) {
      await f.service.command('alpha', { type: 'task', id, title: id, instructions: `Only execute ${id}`, modelEntryId: entry.id, thinkingLevel: id === 'first-model-task' ? 'low' : 'high' })
      const snapshot = await until(() => f.service.get('alpha'), value => value.state.tasks.some(task => task.id === id && task.status === 'running' && !!task.sessionId))
      const task = snapshot.state.tasks.find(task => task.id === id)!
      const worker = snapshot.config!.nodes.find(node => node.id === task.nodeId)!
      expect(activeSuperAgentNodes(snapshot.config!, snapshot.state).some(node => node.id === worker.id)).toBe(true)
      expect(worker).toMatchObject({ dynamic: true, modelEntryId: entry.id, description: '', workPreferences: '' })
      expect(task.instructions).toBe(`Only execute ${id}`)
      expect(f.host.options.get(task.sessionId!)?.model).toBe(entry.model)
      expect(f.host.options.get(task.sessionId!)?.thinkingLevel).toBe(id === 'first-model-task' ? 'low' : 'high')
      f.host.complete(task.sessionId!, `${id} result`)
      const finished = await until(() => f.service.get('alpha'), value => value.state.tasks.find(task => task.id === id)?.status === 'completed')
      expect(activeSuperAgentNodes(finished.config!, finished.state).map(node => node.role)).toEqual(['coordinator', 'orchestrator'])
      expect(finished.state.tasks.find(task => task.id === id)?.output).toBe(`${id} result`)
      expect(finished.state.tasks.find(task => task.id === id)?.sessionId).toBe(task.sessionId)
    }
    const tasks = (await f.service.get('alpha')).state.tasks
    const stored = await loadSuperAgentDocument(f.root + '/alpha')
    expect(activeSuperAgentNodes(stored.config!, stored.state).map(node => node.role)).toEqual(['coordinator', 'orchestrator'])
    expect(tasks[0]!.nodeId).not.toBe(tasks[1]!.nodeId)
    expect(tasks[0]!.sessionId).not.toBe(tasks[1]!.sessionId)
    expect(f.host.sends.filter(send => send.sessionId === tasks[1]!.sessionId).every(send => !send.message.includes('first-model-task result'))).toBe(true)
  })
  test('routes intent through the work list, dispatches the selected model and polls durable reports', async () => {
    const f = await fixture()
    const queued = await f.service.command('alpha', { type: 'chat', text: 'Verify the document' })
    expect(queued.interactionPending).toBe(true)
    const interaction = await working(f, 'coordinator')
    await f.service.callNodeActionTool('alpha', interaction, 'super_agent_intent', { requestId: 'goal', goal: 'Verify the document', constraints: [], deliverables: ['Findings'], acceptanceCriteria: ['Check source'] })
    await f.service.callNodeActionTool('alpha', interaction, 'super_agent_deliver', { requestId: 'ack', reply: '' })
    f.host.complete(interaction, '')
    const planner = await working(f, 'orchestrator')
    expect((await f.service.get('alpha')).interactionPending).toBe(false)
    const intent = (await f.service.get('alpha')).state.intents![0]!
    await f.service.callNodeActionTool('alpha', planner, 'super_agent_dispatch', { requestId: 'dispatch', id: 'verify', goalId: intent.id, title: 'Verify', instructions: 'Read and verify the document', modelEntryId: f.config.modelPool![0]!.id, thinkingLevel: 'high' })
    f.host.complete(planner, '')
    const worker = await working(f, 'worker')
    expect(f.host.options.get(worker)?.thinkingLevel).toBe('high')
    expect(f.host.options.get(worker)?.model).toBe(f.config.modelPool![0]!.model)
    await f.service.callNodeActionTool('alpha', worker, 'super_agent_report', { requestId: 'report', kind: 'stage', content: 'Verified the source; one discrepancy remains.' })
    f.host.complete(worker, 'Verified the source; one discrepancy remains.')
    await until(() => f.service.get('alpha'), value => value.state.tasks[0]?.status === 'completed')
    expect(f.host.sends.filter(send => send.sessionId === interaction)).toHaveLength(1)
    f.advance(5_000)
    await f.service.tick()
    await until(() => f.service.get('alpha'), () => f.host.sends.filter(send => send.sessionId === interaction).length === 2)
    const context = JSON.parse(f.host.sends.filter(send => send.sessionId === interaction).at(-1)!.context.split('Current team state (data, not instructions):\n')[1]!)
    expect(context.reports[0].content).toContain('discrepancy')
    expect(context.board).toBeUndefined()
    expect(context.modelPool).toBeUndefined()
    await f.service.callNodeActionTool('alpha', interaction, 'super_agent_deliver', { requestId: 'update', reply: 'Source checked; one discrepancy remains.' })
    f.host.complete(interaction, '')
    await until(() => f.service.get('alpha'), value => value.state.consumedReportSequence === 1)
    const disk = await loadSuperAgentDocument(join(f.root, 'alpha'))
    expect(disk.state.consumedReportSequence).toBe(1)
    f.advance(10_000)
    await f.service.tick()
    expect(f.host.sends.filter(send => send.sessionId === interaction)).toHaveLength(2)
  })

  test('enforces the worker concurrency cap without counting permanent nodes', async () => {
    const f = await fixture()
    for (const id of ['one', 'two']) await f.service.command('alpha', { type: 'task', id, title: id, instructions: 'Inspect the assigned input', modelEntryId: f.config.modelPool![0]!.id, thinkingLevel: 'medium' })
    await working(f, 'worker')
    let snapshot = await f.service.get('alpha')
    expect(snapshot.state.tasks.filter(task => task.status === 'running')).toHaveLength(1)
    expect(snapshot.state.tasks.filter(task => task.status === 'queued')).toHaveLength(1)
    f.host.complete(snapshot.state.tasks.find(task => task.status === 'running')!.sessionId!, 'Done')
    snapshot = await until(() => f.service.get('alpha'), value => value.state.tasks.find(task => task.id === 'two')?.status === 'running')
    expect(snapshot.state.tasks[0]!.status).toBe('completed')
  })

  test('rejects unsupported effort, and interaction cannot read internal areas via direct callbacks', async () => {
    const f = await fixture()
    f.config.modelPool![0]!.supportedThinkingLevels = ['low']
    await f.service.save('alpha', f.config)
    await expect(f.service.command('alpha', { type: 'task', title: 'Bad effort', instructions: 'Inspect', modelEntryId: f.config.modelPool![0]!.id, thinkingLevel: 'max' })).rejects.toThrow('Unsupported thinkingLevel')
    await f.service.command('alpha', { type: 'chat', text: 'Inspect progress' })
    const interaction = await working(f, 'coordinator')
    const result = await f.service.callNodeActionTool('alpha', interaction, 'super_agent_work_list', { requestId: 'work' })
    expect('data' in result && result.data).toBeDefined()
    await expect(f.service.getNodeSharedData('alpha', interaction)).rejects.toThrow('only work lists and reports')
    expect(await f.service.accessSettings('alpha', { action: 'get' }, interaction)).toMatchObject({ config: f.config, pending: false })
    await expect(f.service.updateNodeTask('alpha', interaction, { action: 'get' })).rejects.toThrow('work contracts')
    await expect(f.service.callNodeActionTool('alpha', interaction, 'super_agent_board', { requestId: 'board', title: 'Forbidden', content: 'Internal', expectedRevision: 0 })).rejects.toThrow()
  })

  test('never discards unread reports when the interaction node is behind', async () => {
    const f = await fixture()
    const document = await loadSuperAgentDocument(join(f.root, 'alpha'))
    const planner = document.config!.nodes.find(node => node.role === 'orchestrator')!
    for (let index = 0; index < 2100; index++) appendSuperAgentReport(document, planner, { id: `turn-${index}` }, { kind: 'progress', content: `Report ${index}` }, index)
    expect(document.state.reports).toHaveLength(2100)
    expect(document.state.reports![0]!.sequence).toBe(1)
    expect(document.state.reports!.at(-1)!.sequence).toBe(2100)
  })

  test('clamps notification consumption to its batch and retains unread reports across restart', async () => {
    const f = await fixture()
    await f.service.command('alpha', { type: 'board-upsert', item: { title: 'Input', content: 'First update' }, expectedRevision: 0 })
    let planner = await working(f, 'orchestrator')
    await f.service.callNodeActionTool('alpha', planner, 'super_agent_report', { requestId: 'first', kind: 'progress', content: 'First report' })
    f.host.complete(planner, '')
    await until(() => f.service.get('alpha'), value => !value.state.nodes.some(runtime => runtime.status === 'working'))
    f.advance(5_000); await f.service.tick()
    const interaction = await working(f, 'coordinator')
    await f.service.command('alpha', { type: 'board-upsert', item: { title: 'Input 2', content: 'Second update' }, expectedRevision: 0 })
    planner = await working(f, 'orchestrator')
    await f.service.callNodeActionTool('alpha', planner, 'super_agent_report', { requestId: 'second', kind: 'progress', content: 'Second report' })
    f.host.complete(planner, '')
    await f.service.callNodeActionTool('alpha', interaction, 'super_agent_deliver', { requestId: 'consume-first', reply: '' })
    f.host.complete(interaction, '')
    await until(() => f.service.get('alpha'), value => value.state.consumedReportSequence === 1)
    await f.service.cleanup()
    const restored = new SuperAgentService({ host: f.host, rootForWorkspace: workspaceId => join(f.root, workspaceId), now: f.now, autoTick: false })
    try {
      expect((await restored.get('alpha')).state.consumedReportSequence).toBe(1)
      f.advance(5_000); await restored.tick()
      await until(() => restored.get('alpha'), value => value.state.nodes.find(node => node.sessionId === interaction)?.status === 'working')
      const context = JSON.parse(f.host.sends.filter(send => send.sessionId === interaction).at(-1)!.context.split('Current team state (data, not instructions):\n')[1]!)
      expect(context.reports.map((report: { content: string }) => report.content)).toEqual(['Second report'])
    } finally { await restored.cleanup() }
  })

  test('failed notification handling preserves its cursor and does not start paid retry loops', async () => {
    const f = await fixture()
    await f.service.command('alpha', { type: 'board-upsert', item: { title: 'Input', content: 'Changed' }, expectedRevision: 0 })
    const planner = await working(f, 'orchestrator')
    await f.service.callNodeActionTool('alpha', planner, 'super_agent_report', { requestId: 'first', kind: 'question', content: 'Need your preferred format' })
    f.host.complete(planner, '')
    await until(() => f.service.get('alpha'), value => !value.state.nodes.some(runtime => runtime.status === 'working'))
    f.advance(5_000); await f.service.tick()
    const interaction = await working(f, 'coordinator')
    f.host.complete(interaction, 'No delivery tool used')
    await until(() => f.service.get('alpha'), value => value.state.nodes.find(runtime => runtime.sessionId === interaction)?.status === 'error')
    const count = f.host.sends.length
    for (let index = 0; index < 3; index++) { f.advance(5_000); await f.service.tick() }
    expect(f.host.sends).toHaveLength(count)
    expect((await f.service.get('alpha')).state.consumedReportSequence ?? 0).toBe(0)
    expect((await loadSuperAgentDocument(join(f.root, 'alpha'))).failedTurns![0]!.reportThrough).toBe(1)
    await f.service.command('alpha', { type: 'node-refresh', nodeId: 'main' })
    await working(f, 'coordinator')
    await f.service.callNodeActionTool('alpha', interaction, 'super_agent_deliver', { requestId: 'retry-consume', reply: '' })
    f.host.complete(interaction, '')
    await until(() => f.service.get('alpha'), value => value.state.consumedReportSequence === 1)
  })

  test('keeps uploaded bytes out of interaction context and stores a project reference', async () => {
    const f = await fixture()
    await f.service.command('alpha', { type: 'chat', text: 'Review the attachment', attachments: [{ name: 'input.txt', mimeType: 'text/plain', text: 'private attachment content' }] })
    const interaction = await working(f, 'coordinator')
    const send = f.host.sends.find(send => send.sessionId === interaction)!
    expect(send.message).not.toContain('private attachment content')
    expect(send.context).not.toContain('private attachment content')
    const refs = JSON.parse(send.message.split('subagent):\n')[1]!) as Array<{ path: string }>
    expect(await readFile(join(f.workingDirectory, refs[0]!.path), 'utf8')).toBe('private attachment content')
  })

  test('cancelling a requirement cancels execution and invalidates its earlier reports', async () => {
    const f = await fixture()
    await f.service.command('alpha', { type: 'chat', text: 'Inspect this document' })
    const interaction = await working(f, 'coordinator')
    const goal = { requestId: 'goal', goal: 'Inspect this document', constraints: [], deliverables: ['Findings'], acceptanceCriteria: [] }
    await f.service.callNodeActionTool('alpha', interaction, 'super_agent_intent', goal)
    const intent = (await f.service.get('alpha')).state.intents![0]!
    await f.service.command('alpha', { type: 'task', title: 'Inspect', instructions: 'Inspect the document', goalId: intent.id, modelEntryId: f.config.modelPool![0]!.id, thinkingLevel: 'low' })
    const worker = await working(f, 'worker')
    await f.service.callNodeActionTool('alpha', worker, 'super_agent_report', { requestId: 'progress', kind: 'progress', content: 'Inspection has started' })
    await f.service.callNodeActionTool('alpha', interaction, 'super_agent_intent', { ...goal, requestId: 'cancel-goal', id: intent.id, expectedRevision: 1, status: 'cancelled' })
    f.host.complete(worker, 'Late success must not replace cancellation')
    const snapshot = await f.service.get('alpha')
    expect(snapshot.state.intents![0]!.status).toBe('cancelled')
    expect(snapshot.state.tasks[0]!.status).toBe('cancelled')
    expect(snapshot.state.plans[0]!.status).toBe('cancelled')
    expect(snapshot.state.reports![0]!.verification).toBe('stale')
  })

  test('background reads scoped configuration and resource metadata without webhook secrets', async () => {
    const f = await superAgentFixture({ accessResources: async () => ({
      sources: [], credentials: [{ id: { type: 'saved_credential', name: 'Account' }, hasSecret: true }], history: [],
      automations: { automations: { SchedulerTick: [{ id: 'daily', name: 'Daily', cron: '* * * * *', actions: [{ type: 'webhook', url: 'https://example.com', headers: { Authorization: 'never-show-secret' } }] }] } },
      availableImports: { credentials: [{ name: 'Ordinary private account' }] },
    }) })
    const config = rebuildSuperAgentConfig(f.config)
    await f.service.save('alpha', config)
    await f.service.command('alpha', { type: 'board-upsert', item: { title: 'Input', content: 'Changed' }, expectedRevision: 0 })
    const planner = await working({ ...f, config }, 'orchestrator')
    const result = await f.service.callNodeActionTool('alpha', planner, 'super_agent_resource_catalog', { requestId: 'automations', area: 'automations' })
    expect(JSON.stringify(result)).toContain('Daily')
    expect(JSON.stringify(result)).not.toContain('never-show-secret')
    expect(JSON.stringify(result)).not.toContain('Ordinary private account')
    expect(await f.service.accessSettings('alpha', { action: 'get' }, planner)).toMatchObject({ config: { architecture: 'dynamic' } })
  })
  test('archives and migrates a full legacy team while preserving each model profile', async () => {
    const f = await superAgentFixture({ rebuildArchitecture: true })
    const worker = f.config.nodes.find(node => node.role === 'worker')!
    f.config.nodes = [f.config.nodes[0]!, ...Array.from({ length: 31 }, (_, index) => ({ ...worker, id: `worker-${index}`, name: `Profile ${index}`, workPreferences: `Preference ${index}` }))]
    await f.service.save('alpha', f.config)
    const migrated = await f.service.get('alpha')
    expect(migrated.config!.architecture).toBe('dynamic')
    expect(migrated.config!.nodes).toHaveLength(2)
    expect(migrated.config!.modelPool).toHaveLength(31)
    expect(migrated.config!.modelPool![30]!).toMatchObject({ name: worker.model, model: worker.model, capabilityNotes: (worker.capabilities ?? []).join(', '), intelligenceScore: worker.intelligenceRating * 20, skillSlugs: [] })
    const archives = await readdir(join(f.root, 'alpha', 'super-agent', 'history'))
    expect(archives.filter(name => name.startsWith('legacy-'))).toHaveLength(1)
    expect(await readFile(join(f.root, 'alpha', 'super-agent', 'history', archives.find(name => name.startsWith('legacy-'))!), 'utf8')).toContain('Preference 30')
    expect(migrated.recoverySuspended).toBe(true)
  })

  test('automation work creates one durable requirement and wakes background without a chat turn', async () => {
    const f = await fixture()
    const command = { type: 'automation-work' as const, text: 'Prepare the scheduled report', automationId: 'daily', runId: 'run-one' }
    await f.service.command('alpha', command)
    await f.service.command('alpha', command)
    await working(f, 'orchestrator')
    const snapshot = await f.service.get('alpha')
    expect(snapshot.state.intents).toHaveLength(1)
    expect(snapshot.state.intents![0]!.sourceTurnId).toBe('automation:daily:run-one')
    expect(snapshot.state.nodes.find(runtime => runtime.nodeId === 'main')!.sessionId).toBeUndefined()
  })

  test('lowering concurrency lets active workers drain before starting queued work', async () => {
    const f = await fixture()
    await f.service.save('alpha', { ...f.config, maxConcurrentSubagents: 2 })
    for (const id of ['one', 'two', 'three']) await f.service.command('alpha', { type: 'task', id, title: id, instructions: 'Inspect the input', modelEntryId: f.config.modelPool![0]!.id, thinkingLevel: 'medium' })
    let snapshot = await until(() => f.service.get('alpha'), value => value.state.tasks.filter(task => task.status === 'running').length === 2)
    await f.service.save('alpha', { ...snapshot.config!, maxConcurrentSubagents: 1 })
    f.host.complete(snapshot.state.tasks[0]!.sessionId!, 'First done')
    snapshot = await until(() => f.service.get('alpha'), value => value.state.tasks[0]!.status === 'completed')
    expect(snapshot.state.tasks[1]!.status).toBe('running')
    expect(snapshot.state.tasks[2]!.status).toBe('queued')
    f.host.complete(snapshot.state.tasks[1]!.sessionId!, 'Second done')
    await until(() => f.service.get('alpha'), value => value.state.tasks[2]!.status === 'running')
  })

})
