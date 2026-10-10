import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSuperAgentDocument } from '@craft-agent/shared/super-agent'
import { superAgentFixture, until } from './SuperAgentTestSupport'

const actions = (value: object) => `<super_agent_actions>${JSON.stringify(value)}</super_agent_actions>`
const replies = (state: { messages: Array<{ fromNodeId: string; toNodeId: string; body: string }> }) =>
  state.messages.filter(message => message.toNodeId === 'user' && message.fromNodeId !== 'user')

describe('Super Agent user interaction', () => {
  test('unchanged background inspections stay internal while a necessary question survives reload', async () => {
    const { service, config, host, advance, root } = await superAgentFixture()
    config.continuousWork = true
    await service.save('alpha', config)
    advance(60_001)
    await service.tick()
    const started = await until(() => service.get('alpha'), snapshot => snapshot.state.nodes[0]?.status === 'working')
    const sessionId = started.state.nodes[0]!.sessionId!
    host.complete(sessionId, '自检完成：无新增工作，等待下一次输入。')
    const settled = await until(() => service.get('alpha'), snapshot => snapshot.state.nodes[0]?.status === 'idle')
    expect(replies(settled.state)).toEqual([])
    expect(settled.state.messages.some(message => message.body.includes('自检完成') && message.toNodeId === 'main')).toBe(true)

    advance(60_001)
    await service.tick()
    await until(() => service.get('alpha'), snapshot => snapshot.state.nodes[0]?.status === 'working')
    host.complete(sessionId, 'Internal deliberation\n' + actions({ userReply: '请提供目标模型版本，以便工作节点继续。' }))
    const answered = await until(() => service.get('alpha'), snapshot => snapshot.state.nodes[0]?.status === 'idle')
    expect(replies(answered.state).map(message => message.body)).toEqual(['请提供目标模型版本，以便工作节点继续。'])
    expect((await loadSuperAgentDocument(join(root, 'alpha'))).state.messages.at(-1)).toMatchObject({ toNodeId: 'user', userFacing: true })
    advance(60_001)
    await service.tick()
    await until(() => service.get('alpha'), snapshot => snapshot.state.nodes[0]?.status === 'working')
    host.complete(sessionId, actions({ userReply: '请提供目标模型版本，以便工作节点继续。' }))
    const unchanged = await until(() => service.get('alpha'), snapshot => snapshot.state.nodes[0]?.status === 'idle')
    expect(replies(unchanged.state)).toHaveLength(1)
  })

  test('dispatch and internal handoffs do not emit Completed or expose internal prose', async () => {
    const { service, config, host, advance } = await superAgentFixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: '请让工作节点处理这个需求。' })
    const started = await until(() => service.get('alpha'), snapshot => snapshot.state.nodes[0]?.status === 'working')
    host.complete(started.state.nodes[0]!.sessionId!, '我的内部分析和分派过程。\n' + actions({ tasks: [{ nodeId: 'worker', title: '处理需求', instructions: '完成用户需求并自检。' }] }))
    const running = await until(() => service.get('alpha'), snapshot => snapshot.state.tasks[0]?.status === 'running')
    expect(replies(running.state)).toEqual([])
    advance(1_001)
    host.complete(running.state.tasks[0]!.sessionId!, '已验证完成：产物在 result.txt。')
    const summary = await until(() => service.get('alpha'), snapshot => snapshot.state.nodes[0]?.status === 'working')
    host.complete(summary.state.nodes[0]!.sessionId!, actions({ userReply: '已完成，工作节点已验证。产物：result.txt。' }))
    const finished = await until(() => service.get('alpha'), snapshot => snapshot.state.nodes[0]?.status === 'idle')
    expect(replies(finished.state).map(message => message.body)).toEqual(['已完成，工作节点已验证。产物：result.txt。'])
    expect(finished.state.tasks[0]!.status).toBe('completed')
  })

  test('an actions-only reply can deliberately remain silent', async () => {
    const { service, config, host } = await superAgentFixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: '记住这个偏好。' })
    const started = await until(() => service.get('alpha'), snapshot => snapshot.state.nodes[0]?.status === 'working')
    host.complete(started.state.nodes[0]!.sessionId!, actions({}))
    const finished = await until(() => service.get('alpha'), snapshot => snapshot.state.nodes[0]?.status === 'idle')
    expect(replies(finished.state)).toEqual([])
  })

  test('invalid actions retain the real error and suppress an uncommitted success claim', async () => {
    const { service, config, host } = await superAgentFixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: '处理任务。' })
    const started = await until(() => service.get('alpha'), snapshot => snapshot.state.nodes[0]?.status === 'working')
    host.complete(started.state.nodes[0]!.sessionId!, actions({ userReply: '已分派成功。', tasks: [{ nodeId: 'missing-worker', title: 'Work', instructions: 'Do work' }] }))
    const finished = await until(() => service.get('alpha'), snapshot => snapshot.state.nodes[0]?.status === 'idle')
    expect(replies(finished.state).some(message => message.body === '已分派成功。')).toBe(false)
    expect(replies(finished.state).some(message => message.body.includes('Communication action rejected'))).toBe(true)
    expect(finished.state.tasks).toEqual([])
  })
})
