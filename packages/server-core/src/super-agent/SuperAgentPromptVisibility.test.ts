import { expect, test } from 'bun:test'
import { superAgentFixture, until } from './SuperAgentTestSupport'
import { rebuildSuperAgentConfig } from '@tokenbird/shared/super-agent'
import { buildSuperAgentNodePrompt } from './SuperAgentPrompt'
import { buildDynamicNodePrompt } from './SuperAgentDynamic'

test('user-facing language stays separate from backend reports across prompt architectures', async () => {
  const f = await superAgentFixture()
  const dynamic = rebuildSuperAgentConfig(f.config)
  const separated = { ...f.config, nodes: [...f.config.nodes, { ...f.config.nodes[1]!, id: 'dispatch', role: 'orchestrator' as const }] }
  const legacyDynamic = { ...dynamic, roleTopologyVersion: undefined, nodes: dynamic.nodes.filter(node => node.role !== 'planner') }
  for (const [config, build] of [
    [f.config, buildSuperAgentNodePrompt],
    [separated, buildSuperAgentNodePrompt],
    [dynamic, buildDynamicNodePrompt],
    [legacyDynamic, buildDynamicNodePrompt],
  ] as const) {
    for (const node of config.nodes) {
      const prompt = build(config, node)
      if (node.role === 'coordinator') {
        expect(prompt).toContain('# 面向用户的表达')
        expect(prompt).toContain('super_agent_deliver 的 reply、普通最终答复、进度说明和澄清问题')
        expect(prompt).toContain('不是可直接复制的用户答复')
        expect(prompt).toContain('把未核验说成已通过')
        expect(prompt).toContain('用户明确要求技术细节')
        expect(prompt).toContain('不要因通俗表达而改写代码、命令、路径或引用证据')
        expect(prompt).not.toContain('# 面向前台的结果交接')
      } else {
        expect(prompt).not.toContain('# 面向用户的表达')
        if (node.role === 'planner' || node.role === 'orchestrator') {
          expect(prompt).toContain('# 面向前台的结果交接')
          expect(prompt).toContain('不改变汇报协议、事实或验证状态')
        }
      }
    }
  }
})

test('every node role distinguishes user silence from final completion and forbids replay during recovery', async () => {
  const f = await superAgentFixture()
  const dynamic = rebuildSuperAgentConfig(f.config)
  for (const prompt of [
    ...f.config.nodes.map(node => buildSuperAgentNodePrompt(f.config, node)),
    ...dynamic.nodes.map(node => buildDynamicNodePrompt(dynamic, node)),
  ]) {
    expect(prompt).toContain('reply=""')
    expect(prompt).toContain('非空的最终答复')
    expect(prompt).toContain('final 通道')
    expect(prompt).toContain('进度、阶段、问题或失败不能冒充 final')
    expect(prompt).toContain('未知副作用先核验')
    expect(prompt).toContain('程序不能重放')
  }
})

test('workers display only coordinator input while peer and repair turns stay hidden', async () => {
  const f = await superAgentFixture()
  f.config.nodes.push({ ...f.config.nodes[1]!, id: 'reviewer', name: 'Reviewer' })
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'worker', body: 'Verify the assigned report.' })
  await until(() => f.service.get('alpha'), () => f.host.sends.length === 1)
  expect(f.host.sends[0]).toMatchObject({ message: 'Verify the assigned report.', hidden: false })
  await f.service.command('alpha', { type: 'message', fromNodeId: 'reviewer', toNodeId: 'worker', body: 'Shared entry evidence is ready.' })
  f.host.complete(f.host.sends[0]!.sessionId, '已验证完成')
  f.advance(1001); await f.service.tick()
  await until(() => f.service.get('alpha'), () => f.host.sends.some(send => send.message === 'Shared entry evidence is ready.'))
  expect(f.host.sends.find(send => send.message === 'Shared entry evidence is ready.')).toMatchObject({ hidden: true })
})

test('stopping during Framework startup cannot invoke a cancelled assignment', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const f = await superAgentFixture({ workflow: { prepare: () => gate, run: async (_input, invoke) => { calls++; await invoke() }, close: release } })
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'task', nodeId: 'worker', title: 'Bounded task', instructions: 'Run only the agreed task.' })
  await until(() => f.service.get('alpha'), state => state.state.nodes[1]?.status === 'preparing')
  f.advance(60_000); await f.service.tick()
  expect((await f.service.get('alpha')).state.tasks[0]!.status).toBe('queued')
  await f.service.command('alpha', { type: 'cancel' })
  release()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(calls).toBe(0)
  expect(f.host.sends).toHaveLength(0)
})
