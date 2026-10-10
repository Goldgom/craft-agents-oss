import { expect, test } from 'bun:test'
import { superAgentFixture, until } from './SuperAgentTestSupport'

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
