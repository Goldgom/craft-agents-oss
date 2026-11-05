import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSuperAgentDocument } from '@tokenbird/shared/super-agent'
import { SESSION_TOOL_REGISTRY, type SessionToolContext } from '@tokenbird/session-tools-core'
import { superAgentFixture, until } from './SuperAgentTestSupport'
import { SuperAgentService } from './SuperAgentService'
import { writeFile } from 'node:fs/promises'

async function activeTeam(separated = false) {
  const f = await superAgentFixture({ upgradeArchitecture: separated })
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'chat', text: 'Verify the authorized work' })
  const snapshot = await until(() => f.service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
  const sessionId = snapshot.state.nodes[0]!.sessionId!
  return { ...f, sessionId, call: (name: string, args: Record<string, unknown>) => f.service.callNodeActionTool('alpha', sessionId, name, args) }
}
const dispatch = { requestId: 'dispatch-one', id: 'verify-one', nodeId: 'worker', title: 'Verify', instructions: 'Verify the current source without edits' }
const plan = { requestId: 'plan-one', id: 'plan-one', title: 'Verify source', instructions: 'Verify the scoped source', status: 'planned', priority: 1, note: '', expectedRevision: 0 }

describe('Super Agent registered collaboration tools', () => {
  test('desktop specialist assignments acquire exclusive desktop ownership without losing requested resources', async () => {
    const f = await superAgentFixture()
    f.config.nodes[1]!.presetProfile = 'computerUse'
    f.config.nodes[1]!.capabilities = ['computerUse']
    await f.service.save('alpha', f.config)
    await f.service.command('alpha', { type: 'task', nodeId: 'worker', title: 'Inspect desktop', instructions: 'Observe the assigned app.', resources: ['report.md'] })
    const snapshot = await until(() => f.service.get('alpha'), value => value.state.tasks.length === 1)
    expect(snapshot.state.tasks[0]!.resources).toEqual(['report.md', 'host-desktop'])
  })
  test('commits a plan and dispatch during the active model loop, with durable deduplicated receipts', async () => {
    const f = await activeTeam()
    const p = await f.call('super_agent_plan', plan)
    const result = await f.call('super_agent_dispatch', { ...dispatch, planId: 'plan-one' })
    expect(p.receipt.status).toBe('applied')
    expect(result.receipt.applied[0]?.targetId).toBe('verify-one')
    expect(await f.call('super_agent_dispatch', { ...dispatch, planId: 'plan-one' })).toEqual(result)
    let durable = await loadSuperAgentDocument(join(f.root, 'alpha'))
    expect(durable.state.tasks).toHaveLength(1)
    expect(durable.pendingTurns.find(turn => turn.nodeId === 'main')?.toolCalls).toHaveLength(2)
    await expect(f.call('super_agent_dispatch', { ...dispatch, planId: 'plan-one', instructions: 'Different work' })).rejects.toThrow('different parameters')
    f.host.complete(f.sessionId, 'Verification assigned.')
    const finished = await until(() => f.service.get('alpha'), value => value.state.messages.some(message => message.fromNodeId === 'main' && !!message.actionReceipt))
    expect(finished.state.messages.find(message => message.fromNodeId === 'main' && !!message.actionReceipt)?.actionReceipt?.applied.map(action => action.type)).toEqual(['plan-upsert', 'task'])
    durable = await loadSuperAgentDocument(join(f.root, 'alpha'))
    expect(durable.state.tasks).toHaveLength(1)
  })

  test('returns malformed parameters as a tool error and corrects in the same turn without a repair dispatch', async () => {
    const f = await activeTeam()
    const tool = SESSION_TOOL_REGISTRY.get('super_agent_dispatch')!
    const ctx = { superAgentAction: (name: string, args: Record<string, unknown>) => f.call(name, args) } as SessionToolContext
    const bad = await tool.handler!(ctx, { requestId: 'bad', toNodeId: 'worker', body: 'Not a task' })
    expect(bad.isError).toBe(true)
    expect(JSON.stringify(bad)).toContain('instructions')
    expect((await f.service.get('alpha')).state.tasks).toHaveLength(0)
    const good = await tool.handler!(ctx, dispatch)
    expect(good.isError).not.toBe(true)
    const durable = await loadSuperAgentDocument(join(f.root, 'alpha'))
    expect(durable.pendingTurns.filter(turn => turn.nodeId === 'main')).toHaveLength(1)
    expect(durable.state.tasks).toHaveLength(1)
  })

  test('preserves shared state on stale revisions and permits a refreshed correction', async () => {
    const f = await activeTeam()
    const item = { id: 'shared', title: 'Evidence', content: 'Original', expectedRevision: 0 }
    await f.call('super_agent_board', { requestId: 'board-one', ...item })
    await expect(f.call('super_agent_board', { requestId: 'board-stale', ...item, content: 'Stale' })).rejects.toThrow('revision 1')
    expect((await f.service.get('alpha')).state.board[0]?.content).toBe('Original')
    await f.call('super_agent_board', { requestId: 'board-refresh', ...item, content: 'Merged', expectedRevision: 1 })
    expect((await f.service.get('alpha')).state.board[0]?.content).toBe('Merged')
  })

  test('host rejects worker dispatch and unavailable or idle sessions', async () => {
    const f = await activeTeam()
    await f.call('super_agent_dispatch', dispatch)
    const state = await until(() => f.service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const workerSession = state.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
    await expect(f.service.callNodeActionTool('alpha', workerSession, 'super_agent_dispatch', { ...dispatch, requestId: 'illegal' })).rejects.toThrow('Only the coordinator')
    await expect(f.service.callNodeActionTool('alpha', 'missing', 'super_agent_dispatch', dispatch)).rejects.toThrow('active node turn')
    expect((await f.service.get('alpha')).state.tasks).toHaveLength(1)
    f.host.complete(f.sessionId, 'Assigned.')
    await until(() => f.service.get('alpha'), value => value.state.nodes[0]?.status !== 'working')
    await expect(f.call('super_agent_plan', plan)).rejects.toThrow('active node turn')
  })

  test('separated interaction hands off intent once but cannot assign work', async () => {
    const f = await activeTeam(true)
    await expect(f.call('super_agent_dispatch', dispatch)).rejects.toThrow('intent node')
    const intent = { requestId: 'goal-one', goal: 'Verify source', constraints: ['Read only'], deliverables: ['Report'], acceptanceCriteria: ['Evidence cited'] }
    const receipt = await f.call('super_agent_intent', intent)
    expect(await f.call('super_agent_intent', intent)).toEqual(receipt)
    const snapshot = await f.service.get('alpha')
    expect(snapshot.state.intents).toHaveLength(1)
    expect(snapshot.state.tasks).toHaveLength(0)
  })

  test('bounds all tool calls together instead of granting a fresh budget per call', async () => {
    const f = await activeTeam()
    for (let index = 0; index < 8; index++) await f.call('super_agent_board', { requestId: `board-${index}`, id: `item-${index}`, title: 'Evidence', content: `Source ${index}`, expectedRevision: 0 })
    await expect(f.call('super_agent_board', { requestId: 'ninth', title: 'Overflow', content: 'Uncommitted', expectedRevision: 0 })).rejects.toThrow('budget exhausted')
    expect((await f.service.get('alpha')).state.board).toHaveLength(8)
  })

  test('publishes an explicit delivery once after successful completion and keeps silent internal turns silent', async () => {
    const f = await activeTeam()
    await f.call('super_agent_deliver', { requestId: 'reply', reply: 'Verified findings.', delivery: { kind: 'stage', title: 'Findings' } })
    expect((await f.service.get('alpha')).state.messages.filter(message => message.userFacing)).toHaveLength(0)
    f.host.complete(f.sessionId, 'Internal narration.')
    const result = await until(() => f.service.get('alpha'), value => value.state.messages.some(message => message.userFacing))
    expect(result.state.messages.filter(message => message.userFacing).map(message => message.body)).toEqual(['Verified findings.'])
    expect(result.state.messages.find(message => message.userFacing)?.delivery?.kind).toBe('stage')
    await f.service.command('alpha', { type: 'chat', text: 'Status check' })
    f.advance(1001)
    await f.service.tick()
    await until(() => f.service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    await f.call('super_agent_deliver', { requestId: 'silence', reply: '' })
    f.host.complete(f.sessionId, 'Routine internal status.')
    const silent = await until(() => f.service.get('alpha'), value => value.state.nodes[0]?.status !== 'working')
    expect(silent.state.messages.filter(message => message.userFacing).map(message => message.body)).toEqual(['Verified findings.'])
  })

  test('retains committed receipts on model failure and does not publish its pending delivery', async () => {
    const f = await activeTeam()
    await f.call('super_agent_board', { requestId: 'board-one', id: 'evidence', title: 'Evidence', content: 'Durable result', expectedRevision: 0 })
    await f.call('super_agent_deliver', { requestId: 'reply', reply: 'Must not publish on failure' })
    f.host.complete(f.sessionId, 'Model failed', 'error', { canRetry: false })
    const result = await until(() => f.service.get('alpha'), value => value.state.nodes[0]?.status === 'error')
    expect(result.state.board[0]?.content).toBe('Durable result')
    expect(result.state.messages.some(message => message.body === 'Must not publish on failure')).toBe(false)
    expect(result.state.messages.find(message => message.actionReceipt)?.actionReceipt?.applied).toHaveLength(2)
  })

  test('does not replay tool actions from a legacy final block', async () => {
    const f = await activeTeam()
    await f.call('super_agent_dispatch', dispatch)
    f.host.complete(f.sessionId, `<super_agent_actions>${JSON.stringify({ tasks: [dispatch] })}</super_agent_actions>`)
    const result = await until(() => f.service.get('alpha'), value => value.state.messages.some(message => message.actionReceipt?.rejected))
    expect(result.state.tasks).toHaveLength(1)
    const receipt = result.state.messages.find(message => message.actionReceipt?.rejected)?.actionReceipt
    expect(receipt?.status).toBe('partially_applied')
    expect(receipt?.applied[0]?.targetId).toBe('verify-one')
  })

  test('manual recovery retains committed call IDs and does not repeat their effects', async () => {
    const f = await activeTeam()
    const input = { requestId: 'board-one', id: 'evidence', title: 'Evidence', content: 'Original evidence', expectedRevision: 0 }
    const original = await f.call('super_agent_board', input)
    f.host.complete(f.sessionId, 'Login failed', 'error', { errorCode: 'invalid_api_key', canRetry: false })
    await until(() => f.service.get('alpha'), value => value.state.nodes[0]?.status === 'error')
    f.advance(1001)
    await f.service.command('alpha', { type: 'node-refresh', nodeId: 'main' })
    const resumed = await until(() => f.service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    expect(await f.service.callNodeActionTool('alpha', resumed.state.nodes[0]!.sessionId!, 'super_agent_board', input)).toEqual(original)
    expect((await f.service.get('alpha')).state.board[0]?.revision).toBe(1)
  })

  test('restart resumes management with committed calls and does not repeat their effects', async () => {
    const f = await activeTeam()
    const input = { requestId: 'board-one', id: 'evidence', title: 'Evidence', content: 'Original', expectedRevision: 0 }
    const original = await f.call('super_agent_board', input)
    await f.service.cleanup()
    const restarted = new SuperAgentService({ host: f.host, rootForWorkspace: id => join(f.root, id), now: f.now, autoTick: false })
    try {
      await restarted.get('alpha')
      await until(() => restarted.get('alpha'), value => value.recovery?.phase === 'ready')
      f.advance(1001); await restarted.tick()
      const snapshot = await until(() => restarted.get('alpha'), value => value.state.nodes[0]?.status === 'working')
      expect(snapshot.state.nodes[0]!.sessionId).not.toBe(f.sessionId)
      expect(await restarted.callNodeActionTool('alpha', snapshot.state.nodes[0]!.sessionId!, 'super_agent_board', input)).toEqual(original)
      expect((await restarted.get('alpha')).state.board[0]?.revision).toBe(1)
    } finally { await restarted.cleanup() }
  })

  test('revalidates delivery file versions at publication after an earlier tool call', async () => {
    const f = await activeTeam()
    await f.call('super_agent_dispatch', dispatch)
    const worker = await until(() => f.service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const task = worker.state.tasks[0]!
    await writeFile(join(f.workingDirectory, 'report.md'), 'Verified version')
    await f.service.updateNodeTask('alpha', task.sessionId!, { action: 'artifact', taskId: task.id, id: 'report', path: 'report.md', description: 'Verified report' })
    await f.call('super_agent_deliver', { requestId: 'report-delivery', reply: 'Verified report', delivery: { kind: 'final', artifactIds: ['report'] } })
    await writeFile(join(f.workingDirectory, 'report.md'), 'Changed after delivery selection')
    f.host.complete(f.sessionId, 'Internal narration')
    const result = await until(() => f.service.get('alpha'), value => value.state.nodes[0]?.status !== 'working')
    expect(result.state.messages.some(message => message.delivery)).toBe(false)
    expect(result.state.messages.some(message => message.userFacing && message.body === 'Verified report')).toBe(false)
    expect(result.state.messages.some(message => message.body.includes('changed before publication'))).toBe(true)
  })
})
