import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSuperAgentDocument, saveSuperAgentDocument } from '@craft-agent/shared/super-agent'
import { superAgentFixture, until } from './SuperAgentTestSupport'

const block = (value: unknown) => `<super_agent_actions>${JSON.stringify(value)}</super_agent_actions>`
const task = { title: 'Verify the authorized artifact', instructions: 'Check the supplied artifact and report evidence.', nodeId: 'worker' }
const message = { toNodeId: 'worker', body: 'Use the supplied source version.' }
const invalid = { tasks: [task, message] }

describe('Super Agent action schema repair', () => {
  test('rejects mixed task/message entries atomically, gives field guidance, then dispatches the corrected actions once', async () => {
    const { root, service, host, config, advance } = await superAgentFixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: 'Verify the artifact with the existing worker.' })
    const active = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    const sessionId = active.state.nodes[0]!.sessionId!
    host.complete(sessionId, block({ ...invalid, userReply: 'Work dispatched.', board: [{ id: 'evidence', title: 'Evidence', content: 'Pending verification', expectedRevision: 0 }] }))
    const rejected = await until(() => service.get('alpha'), value => value.state.messages.some(item => item.actionReceipt?.status === 'rejected'))
    expect(rejected.state.tasks).toEqual([])
    expect(rejected.state.board).toEqual([])
    expect(rejected.state.messages.some(item => item.body === 'Work dispatched.')).toBe(false)
    const receipt = rejected.state.messages.find(item => item.actionReceipt)?.actionReceipt!
    expect(receipt.applied).toEqual([])
    expect(receipt.rejected?.error).toContain('tasks[1].title')
    expect(receipt.rejected?.error).toContain('tasks[1].instructions')
    expect(receipt.rejected?.error).toContain('Put message-shaped entries in messages, not tasks')

    advance(1_001)
    await service.tick()
    await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    expect(host.sends.at(-1)!.message).toContain(receipt.rejected!.error)
    host.complete(sessionId, block({ tasks: [task], messages: [message] }))
    const repaired = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    expect(repaired.state.tasks).toHaveLength(1)
    expect(repaired.state.tasks[0]).toMatchObject(task)
    expect(repaired.state.messages.filter(item => item.fromNodeId === 'main' && item.toNodeId === 'worker' && item.body === message.body)).toHaveLength(1)
    const persisted = await loadSuperAgentDocument(join(root, 'alpha'))
    expect(persisted.state.tasks).toHaveLength(1)
    expect(persisted.state.messages.findLast(item => !!item.actionReceipt)?.actionReceipt?.status).toBe('applied')
  })

  test('repeated schema failures stop at the original six-hop budget even with continuous work enabled', async () => {
    const { root, service, host, config, advance } = await superAgentFixture()
    await service.save('alpha', { ...config, continuousWork: true })
    await service.command('alpha', { type: 'chat', text: 'Verify the artifact.' })
    for (let index = 0; index <= 6; index++) {
      const active = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
      host.complete(active.state.nodes[0]!.sessionId!, block(invalid))
      await until(() => service.get('alpha'), value => value.state.messages.filter(item => item.actionReceipt?.status === 'rejected').length === index + 1)
      advance(1_001)
      await service.tick()
    }
    const stopped = await service.get('alpha')
    expect(stopped.state.tasks).toEqual([])
    expect(stopped.state.nodes[0]?.status).toBe('idle')
    expect(host.sends).toHaveLength(7)
    const persisted = await loadSuperAgentDocument(join(root, 'alpha'))
    expect(persisted.pendingTurns).toEqual([])
  })

  test('schema repair does not open a new chain when the total call budget is exhausted', async () => {
    const { root, service, host, config } = await superAgentFixture()
    const document = await loadSuperAgentDocument(join(root, 'alpha'))
    document.config = config
    document.state.nodes = config.nodes.map(node => ({ nodeId: node.id, status: 'idle' }))
    document.pendingTurns = [{ id: 'last_turn', nodeId: 'main', kind: 'summary', text: 'Review verification', depth: 0, chainId: 'original_chain', createdAt: 1_000 }]
    document.chainCounts = { original_chain: 32 }
    await saveSuperAgentDocument(join(root, 'alpha'), document)
    await service.get('alpha')
    await service.tick()
    const active = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    host.complete(active.state.nodes[0]!.sessionId!, block(invalid))
    const rejected = await until(() => service.get('alpha'), value => value.state.messages.some(item => item.actionReceipt?.status === 'rejected'))
    expect(rejected.state.tasks).toEqual([])
    expect((await loadSuperAgentDocument(join(root, 'alpha'))).pendingTurns).toEqual([])
    expect(host.sends).toHaveLength(1)
  })

  test('malformed JSON is rejected and repaired without executing the valid-looking prefix', async () => {
    const { service, host, config, advance } = await superAgentFixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: 'Verify the artifact.' })
    const active = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    const sessionId = active.state.nodes[0]!.sessionId!
    host.complete(sessionId, `<super_agent_actions>{"tasks":[${JSON.stringify(task)}],}</super_agent_actions>`)
    const rejected = await until(() => service.get('alpha'), value => value.state.messages.some(item => item.actionReceipt?.status === 'rejected'))
    expect(rejected.state.tasks).toEqual([])
    advance(1_001)
    await service.tick()
    await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    host.complete(sessionId, block({ tasks: [task] }))
    const repaired = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    expect(repaired.state.tasks).toHaveLength(1)
  })
})
