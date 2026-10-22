import { expect, test } from 'bun:test'
import { rebuildSuperAgentConfig, withSuperAgentOrchestrator } from '@tokenbird/shared/super-agent'
import { buildSuperAgentNodePrompt } from './SuperAgentPrompt'
import { superAgentFixture, until } from './SuperAgentTestSupport'

test('dynamic sessions receive outcome ownership at each actual role boundary without loading management skill bodies', async () => {
  const f = await superAgentFixture({ resolveNodeSkills: () => [{ slug: 'source-authoring', content: 'WORKER_SOURCE_GUIDE' }] })
  const config = rebuildSuperAgentConfig(f.config)
  await f.service.save('alpha', config)
  await f.service.command('alpha', { type: 'chat', text: 'Build a usable MCP integration, including recovery' })
  await until(() => f.service.get('alpha'), () => f.host.sends.length === 1)
  const interaction = f.host.sends[0]!.sessionId
  const interactionPrompt = f.host.options.get(interaction)!.agentSystemPrompt!
  expect(interactionPrompt).toContain('不能自行把完整实现缩成')
  expect(interactionPrompt).toContain('不要自行补充金额单位')
  expect(interactionPrompt).not.toContain('WORKER_SOURCE_GUIDE')
  await f.service.callNodeActionTool('alpha', interaction, 'super_agent_intent', { requestId: 'goal',
    goal: 'Build a usable MCP integration', constraints: ['No unapproved external writes'], deliverables: ['Working integration'],
    acceptanceCriteria: ['Real caller works and failures can be recovered'] })
  f.host.complete(interaction, '')
  const planning = await until(() => f.service.get('alpha'), snapshot => snapshot.state.nodes.some(node =>
    snapshot.config!.nodes.find(configured => configured.id === node.nodeId)?.role === 'orchestrator'
      && f.host.sends.some(send => send.sessionId === node.sessionId)))
  const planner = planning.state.nodes.find(node => planning.config!.nodes.find(configured => configured.id === node.nodeId)?.role === 'orchestrator')!.sessionId!
  const planningPrompt = f.host.options.get(planner)!.agentSystemPrompt!
  expect(planningPrompt).toContain('编排对整体交付负责')
  expect(planningPrompt).toContain('同 goalId/planId 下用新 task id')
  expect(planningPrompt).toContain('向该验证 worker 发后续消息')
  expect(planningPrompt).not.toContain('WORKER_SOURCE_GUIDE')
  await f.service.callNodeActionTool('alpha', planner, 'super_agent_dispatch', { requestId: 'implementation', id: 'implementation',
    goalId: planning.state.intents![0]!.id, modelEntryId: config.modelPool![0]!.id, thinkingLevel: 'high',
    title: 'Implement and exercise MCP', instructions: 'Implement the complete caller path and verify recovery' })
  f.host.complete(planner, '')
  const executing = await until(() => f.service.get('alpha'), snapshot => snapshot.state.tasks.some(task => task.status === 'running'
    && f.host.sends.some(send => send.sessionId === task.sessionId)))
  const worker = executing.state.tasks[0]!.sessionId!
  const workerPrompt = f.host.options.get(worker)!.agentSystemPrompt!
  expect(workerPrompt).toContain('实际注册 schema')
  expect(workerPrompt).toContain('不要把自己未完成的实现包装成外部限制')
  expect(workerPrompt).toContain('真实写入测试只在已有授权内执行')
  expect(workerPrompt).toContain('WORKER_SOURCE_GUIDE')
  expect(f.host.policies.get(worker)).toMatchObject({ allowSubagents: false, fullControl: false })
})

test('an ongoing dynamic task can report a stage and resume from a checkpoint before final submission', async () => {
  const f = await superAgentFixture()
  const config = rebuildSuperAgentConfig(f.config)
  config.continuousWork = true
  await f.service.save('alpha', config)
  await f.service.command('alpha', { type: 'task', id: 'observe', title: 'Observe two stages',
    instructions: 'Report the first scan, wait for the next observation, then finish', modelEntryId: config.modelPool![0]!.id, thinkingLevel: 'medium' })
  const started = await until(() => f.service.get('alpha'), snapshot => snapshot.state.tasks[0]?.status === 'running'
    && f.host.sends.some(send => send.sessionId === snapshot.state.tasks[0]?.sessionId))
  const sessionId = started.state.tasks[0]!.sessionId!
  await f.service.callNodeActionTool('alpha', sessionId, 'super_agent_report', { requestId: 'scan', taskId: 'observe',
    kind: 'stage', content: 'First observation complete; a second observation remains' })
  await f.service.updateNodeTask('alpha', sessionId, { action: 'checkpoint', taskId: 'observe', expectedRevision: 0,
    completedSteps: ['First observation'], nextStep: 'Take the second observation' })
  const notBefore = f.now() + 60_000
  await f.service.updateNodeTask('alpha', sessionId, { action: 'wait', taskId: 'observe', reason: 'Next observation time',
    condition: { kind: 'time', notBefore } })
  const readback = await f.service.updateNodeTask('alpha', sessionId, { action: 'get', taskId: 'observe' })
  expect('tasks' in readback && readback.tasks?.[0]?.waiting?.condition).toEqual({ kind: 'time', notBefore })
  f.host.complete(sessionId, 'Stage complete; the assigned observation task is waiting')
  await until(() => f.service.get('alpha'), snapshot => snapshot.state.tasks[0]?.status === 'queued'
    && snapshot.state.tasks[0]?.phase === 'waiting')
  f.advance(59_000); await f.service.tick()
  expect(f.host.sends.filter(send => send.sessionId === sessionId)).toHaveLength(1)
  // Continuity conditions are sampled every five seconds.
  f.advance(6_000); await f.service.tick()
  const resumed = await until(() => f.service.get('alpha'), snapshot => snapshot.state.tasks[0]?.status === 'running'
    && f.host.sends.filter(send => send.sessionId === sessionId).length === 2)
  expect(resumed.state.tasks).toHaveLength(1)
  expect(resumed.state.nodes.find(node => node.nodeId === resumed.state.tasks[0]!.nodeId)?.activeTaskId).toBe('observe')
  expect(f.host.options.get(sessionId)!.agentSystemPrompt).toContain('只有分配的任务范围完成才提交 final')
  await f.service.callNodeActionTool('alpha', sessionId, 'super_agent_report', { requestId: 'complete', taskId: 'observe',
    kind: 'final', content: 'Both requested observations completed' })
  f.host.complete(sessionId, 'Both requested observations completed')
  const finished = await until(() => f.service.get('alpha'), snapshot => snapshot.state.tasks[0]?.status === 'completed')
  expect(finished.state.reports?.filter(report => report.taskId === 'observe').map(report => report.kind)).toEqual(['stage', 'final'])
})

test('legacy separated roles retain outcome ownership without losing their execution boundaries', async () => {
  const f = await superAgentFixture()
  const config = withSuperAgentOrchestrator(f.config)
  for (const node of config.nodes) {
    const prompt = buildSuperAgentNodePrompt(config, node)
    expect(prompt).toContain('不能自行把完整实现缩成')
    expect(prompt).toContain('不要把自己未完成的实现包装成外部限制')
    if (node.role === 'coordinator') expect(prompt).toContain('不要拆解任务')
    if (node.role === 'orchestrator') expect(prompt).toContain('文件、程序、浏览器与分析验证交给工作节点执行')
    if (node.role === 'worker') expect(prompt).toContain('真实写入测试只在已有授权内执行')
  }
})
