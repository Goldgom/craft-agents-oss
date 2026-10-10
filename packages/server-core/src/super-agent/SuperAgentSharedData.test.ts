import { expect, test } from 'bun:test'
import { superAgentFixture, until } from './SuperAgentTestSupport'

test('nodes fetch complete board entries with current revisions and reject foreign or retired sessions', async () => {
  const { service, host, config } = await superAgentFixture()
  await service.save('alpha', config)
  const content = 'FULL_SHARED_DATA_'.repeat(250)
  await service.command('alpha', { type: 'board-upsert', item: { id: 'contract', title: 'Contract', content }, expectedRevision: 0 })
  await service.command('alpha', { type: 'task', nodeId: 'worker', title: 'Use contract', instructions: 'Read shared item contract and produce the assigned artifact.' })
  const state = await until(() => service.get('alpha'), () => host.sends.length === 1)
  const sessionId = state.state.tasks[0]!.sessionId!
  expect(host.sends[0]!.message).toBe('Read shared item contract and produce the assigned artifact.')
  expect(host.sends[0]!.context).toContain('[…]')
  const full = await service.getNodeSharedData('alpha', sessionId)
  expect(full.board[0]).toMatchObject({ id: 'contract', content, revision: 1 })
  full.board[0]!.content = 'A caller cannot mutate storage'
  expect((await service.getNodeSharedData('alpha', sessionId)).board[0]!.content).toBe(content)
  await expect(service.getNodeSharedData('alpha', 'foreign-session')).rejects.toThrow('not a current node')
  await expect(service.getNodeSharedData('another-workspace', sessionId)).rejects.toThrow()
  host.complete(sessionId, 'Verified artifact')
  await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'completed')
  await expect(service.getNodeSharedData('alpha', sessionId)).rejects.toThrow('Only an active node')
})
