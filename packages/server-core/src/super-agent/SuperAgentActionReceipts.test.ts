import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSuperAgentDocument } from '@craft-agent/shared/super-agent'
import { superAgentFixture, until } from './SuperAgentTestSupport'

const block = (actions: unknown) => `<super_agent_actions>${JSON.stringify(actions)}</super_agent_actions>`
const assignment = { tasks: [{ title: 'Actual assignment', instructions: 'Verify the current artifact', nodeId: 'worker' }] }

describe('Super Agent control outcomes', () => {
  test('dispatches valid actions after long text or across the old display truncation boundary', async () => {
    for (const length of [65_000, 63_970]) {
      const { root, service, host, config } = await superAgentFixture()
      await service.save('alpha', config)
      await service.command('alpha', { type: 'chat', text: 'Perform the authorized work' })
      const active = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
      host.complete(active.state.nodes[0]!.sessionId!, `${'x'.repeat(length)}\n${block(assignment)}`)
      const result = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
      expect(result.state.tasks).toHaveLength(1)
      expect(result.state.tasks[0]!.title).toBe('Actual assignment')
      expect(result.state.messages.some(message => message.kind === 'error')).toBe(false)
      expect(result.state.messages.filter(message => message.toNodeId === 'user')).toEqual([])
      expect(result.state.messages.find(message => !!message.actionReceipt)!.body.length).toBeLessThanOrEqual(64_000)
      expect((await loadSuperAgentDocument(join(root, 'alpha'))).state.tasks).toHaveLength(1)
    }
  })

  test('rejects ambiguous blocks visibly and repairs within the original communication budget', async () => {
    const { service, host, config, advance } = await superAgentFixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: 'Arrange verification' })
    let current = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    const mainSession = current.state.nodes[0]!.sessionId!
    host.complete(mainSession, `${block(assignment)}\n${block(assignment)}`)
    current = await until(() => service.get('alpha'), value => value.state.messages.some(message => message.toNodeId === 'user' && message.kind === 'error'))
    expect(current.state.tasks).toHaveLength(0)
    expect(current.state.messages.findLast(message => message.toNodeId === 'user' && message.kind === 'error')!.body).toContain('Action receipt')
    advance(1_001)
    await service.tick()
    await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    expect(host.sends.at(-1)!.message).toContain('Repair the rejected protocol')
    host.complete(mainSession, block(assignment))
    current = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    expect(current.state.tasks).toHaveLength(1)
  })

  test('a fenced example is not executed but a real terminal block is dispatched', async () => {
    const { service, host, config } = await superAgentFixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: 'Explain and then perform verification' })
    const current = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    const example = { tasks: [{ title: 'Example only', instructions: 'Do not execute this example' }] }
    host.complete(current.state.nodes[0]!.sessionId!, `Example:\n\`\`\`json\n${block(example)}\n\`\`\`\nActual result:\n${block(assignment)}`)
    const result = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    expect(result.state.tasks.map(task => task.title)).toEqual(['Actual assignment'])
  })

  test('worker action rejection reaches the coordinator, user and durable task outcome', async () => {
    const { root, service, host, config } = await superAgentFixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'board-upsert', item: { id: 'shared', title: 'Current result', content: 'Original evidence' }, expectedRevision: 0 })
    await service.command('alpha', { type: 'task', title: 'Publish evidence', instructions: 'Update the shared result', nodeId: 'worker' })
    const active = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    host.complete(active.state.nodes[1]!.sessionId!, `I updated the shared result.\n${block({ board: [{ id: 'shared', title: 'Current result', content: 'Rejected evidence', expectedRevision: 0 }] })}`)
    const result = await until(() => service.get('alpha'), value => !!value.state.tasks[0]?.actionReceipt)
    const receipt = result.state.tasks[0]!.actionReceipt!
    expect(result.state.tasks[0]!.status).toBe('completed')
    expect(result.state.tasks[0]!.output).toBe('I updated the shared result.')
    expect(receipt.status).toBe('rejected')
    expect(receipt.rejected?.type).toBe('board-upsert')
    expect(receipt.rejected?.error).toContain('revision 1')
    expect(result.state.board[0]!.content).toBe('Original evidence')
    expect(result.state.messages.some(message => message.toNodeId === 'main' && message.kind === 'error' && message.body.includes('Action receipt'))).toBe(true)
    expect(result.state.messages.some(message => message.toNodeId === 'user' && message.kind === 'error')).toBe(true)
    await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    expect(host.sends.at(-1)!.message).toContain('Action receipt (actual host outcome)')
    expect(host.sends.at(-1)!.message).toContain('Rejected actions were not committed')
    expect((await loadSuperAgentDocument(join(root, 'alpha'))).state.tasks[0]!.actionReceipt).toEqual(receipt)
  })

  test('partial actions have real target IDs and failed actions do not obscure committed changes', async () => {
    const { root, service, host, config } = await superAgentFixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'board-upsert', item: { id: 'shared', title: 'Result', content: 'Original' }, expectedRevision: 0 })
    await service.command('alpha', { type: 'chat', text: 'Create a plan and update the result' })
    const active = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    const plan = { id: 'verify-plan', title: 'Verify artifact', instructions: 'Run actual verification', status: 'planned', priority: 1, note: '', expectedRevision: 0 }
    host.complete(active.state.nodes[0]!.sessionId!, block({ plans: [plan], board: [{ id: 'shared', title: 'Result', content: 'Rejected', expectedRevision: 0 }], tasks: [{ ...assignment.tasks[0], planId: plan.id }] }))
    const result = await until(() => service.get('alpha'), value => value.state.messages.some(message => message.toNodeId === 'user' && message.kind === 'error'))
    const error = result.state.messages.findLast(message => message.toNodeId === 'user' && message.kind === 'error')!
    const receipt = JSON.parse(error.body.split('Action receipt: ')[1]!)
    expect(receipt.status).toBe('partially_applied')
    expect(receipt.applied.map((item: { type: string; targetId: string }) => [item.type, item.targetId])).toEqual([['plan-upsert', plan.id]])
    expect(receipt.rejected.type).toBe('board-upsert')
    expect(receipt.rejected.targetId).toBe('shared')
    expect(receipt.notAttempted).toEqual([{ id: `${receipt.turnId}_2`, type: 'task', targetId: 'worker' }])
    expect(result.state.plans).toHaveLength(1)
    expect(result.state.board[0]!.content).toBe('Original')
    expect(result.state.tasks).toHaveLength(0)
    const persisted = await loadSuperAgentDocument(join(root, 'alpha'))
    expect(persisted.state.messages.find(message => message.actionReceipt?.turnId === receipt.turnId)!.actionReceipt).toEqual(receipt)
  })

  test('successful coordinator actions retain receipts with the validated target IDs', async () => {
    const { root, service, host, config } = await superAgentFixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: 'Publish the verified result' })
    const active = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    host.complete(active.state.nodes[0]!.sessionId!, `Internal review.\n${block({ userReply: 'The worker verified the result.', board: [{ id: '  verified  ', title: 'Evidence', content: 'Checked artifact', expectedRevision: 0 }] })}`)
    const result = await until(() => service.get('alpha'), value => value.state.messages.some(message => !!message.actionReceipt))
    const message = result.state.messages.find(message => !!message.actionReceipt)!
    expect(result.state.board[0]!.id).toBe('verified')
    expect(message.toNodeId).toBe('user')
    expect(message.actionReceipt!.status).toBe('applied')
    expect(message.actionReceipt!.applied[0]!.targetId).toBe('verified')
    expect((await loadSuperAgentDocument(join(root, 'alpha'))).state.messages.find(item => item.id === message.id)!.actionReceipt).toEqual(message.actionReceipt)
  })

  test('the receipt stays ahead of long worker output in the coordinator packet', async () => {
    const { service, host, config } = await superAgentFixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'board-upsert', item: { id: 'shared', title: 'Result', content: 'Original' }, expectedRevision: 0 })
    await service.command('alpha', { type: 'task', title: 'Long evidence report', instructions: 'Publish actual result' })
    const active = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    host.complete(active.state.nodes[1]!.sessionId!, `${'x'.repeat(65_000)}\n${block({ board: [{ id: 'shared', title: 'Result', content: 'Rejected', expectedRevision: 0 }] })}`)
    await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    const packet = host.sends.at(-1)!.message
    expect(packet).toContain('Action receipt (actual host outcome)')
    expect(packet.indexOf('Action receipt')).toBeLessThan(packet.indexOf('x'.repeat(100)))
    expect(packet).toContain('use worker-provided verification evidence before marking it completed')
  })
})
