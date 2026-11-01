import { expect, test } from 'bun:test'
import { rebuildSuperAgentConfig } from '@tokenbird/shared/super-agent'
import { superAgentFixture, until } from './SuperAgentTestSupport'

test('interaction can recover from a rejected metadata lookup and deliver in the same turn', async () => {
  const f = await superAgentFixture()
  const config = rebuildSuperAgentConfig(f.config)
  await f.service.save('alpha', config)
  await f.service.command('alpha', { type: 'chat', text: '当前进展如何？' })
  const started = await until(() => f.service.get('alpha'), snapshot => snapshot.state.nodes.some(node =>
    node.nodeId === config.nodes[0]!.id && node.status === 'working' && f.host.sends.some(send => send.sessionId === node.sessionId)))
  const sessionId = started.state.nodes.find(node => node.nodeId === config.nodes[0]!.id)!.sessionId!
  const send = f.host.sends.find(send => send.sessionId === sessionId)!
  const context = JSON.parse(send.context.split('Current team state (data, not instructions):\n')[1]!)
  expect(context.sessionIdentity).toEqual({ sessionId, workspaceId: 'alpha', nodeId: config.nodes[0]!.id, role: 'coordinator' })
  const prompt = f.host.options.get(sessionId)!.agentSystemPrompt!
  expect(prompt).toContain('sessionIdentity')
  expect(prompt).toContain('super_agent_work_list')
  expect(prompt).not.toContain('collaboration_board')
  expect(prompt).not.toContain('get_session_info')

  const toolName = 'mcp__session__get_session_info'
  const result = 'Super Agent policy: interaction may only use requirements, work lists, reports and replies'
  for (const id of ['lookup', 'duplicate-lookup']) {
    f.host.emit({ type: 'tool_start', sessionId, toolName, toolUseId: id, toolInput: {} })
    f.host.emit({ type: 'tool_result', sessionId, toolName, toolUseId: id, isError: true, result })
  }
  const recovering = await f.service.get('alpha')
  expect(recovering.activity!.find(item => item.nodeId === config.nodes[0]!.id)!.status).toBe('working')
  expect(recovering.activity!.find(item => item.nodeId === config.nodes[0]!.id)!.entries.some(entry => entry.toolName === toolName && entry.status === 'failed')).toBe(true)
  expect(recovering.state.messages.filter(message => message.toNodeId === 'user' && message.kind === 'error')).toEqual([])
  expect(recovering.state.messages.filter(message => message.toNodeId === config.nodes[0]!.id && message.body.includes(result))).toHaveLength(1)
  expect(recovering.permissionRequests).toEqual([])
  await f.service.callNodeActionTool('alpha', sessionId, 'super_agent_work_list', { requestId: 'read-work' })
  await f.service.callNodeActionTool('alpha', sessionId, 'super_agent_deliver', { requestId: 'reply', reply: '当前尚无执行中的任务。' })
  f.host.complete(sessionId, '')
  const finished = await until(() => f.service.get('alpha'), snapshot => snapshot.state.nodes.find(node => node.nodeId === config.nodes[0]!.id)?.status === 'idle')
  expect(finished.state.messages.some(message => message.toNodeId === 'user' && message.body === '当前尚无执行中的任务。')).toBe(true)
  expect(finished.state.messages.filter(message => message.toNodeId === 'user' && message.kind === 'error')).toEqual([])
  expect(f.host.sends.filter(send => send.sessionId === sessionId)).toHaveLength(1)
})

test('structural permission failures still reach the user', async () => {
  const f = await superAgentFixture()
  const config = rebuildSuperAgentConfig(f.config)
  await f.service.save('alpha', config)
  await f.service.command('alpha', { type: 'chat', text: '检查当前状态。' })
  const snapshot = await until(() => f.service.get('alpha'), snapshot => snapshot.state.nodes.some(node =>
    node.nodeId === config.nodes[0]!.id && node.status === 'working' && f.host.sends.some(send => send.sessionId === node.sessionId)))
  const sessionId = snapshot.state.nodes.find(node => node.nodeId === config.nodes[0]!.id)!.sessionId!
  f.host.emit({ type: 'tool_result', sessionId, toolName: 'mcp__session__super_agent_work_list', toolUseId: 'invalid-policy', isError: true,
    result: 'Super Agent policy: the persisted execution policy is invalid; configure the node again' })
  const failed = await f.service.get('alpha')
  expect(failed.activity!.find(item => item.nodeId === config.nodes[0]!.id)!.status).toBe('error')
  expect(failed.state.messages.some(message => message.toNodeId === 'user' && message.kind === 'error' && message.body.includes('persisted execution policy is invalid'))).toBe(true)
})
