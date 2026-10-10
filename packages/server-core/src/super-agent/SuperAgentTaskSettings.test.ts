import { describe, expect, it } from 'bun:test'
import { loadSuperAgentDocument, withSuperAgentOrchestrator } from '@craft-agent/shared/super-agent'
import { join } from 'node:path'
import { superAgentFixture, until } from './SuperAgentTestSupport'

describe('Super Agent task settings and statistics', () => {
  it('applies overrides to reused sessions and restores the default for the next task', async () => {
    const f = await superAgentFixture()
    await f.service.save('alpha', f.config)
    await f.service.command('alpha', { type: 'task', title: 'Extract', instructions: 'Extract fields', thinkingLevel: 'low' })
    let snapshot = await until(() => f.service.get('alpha'), s => s.state.tasks[0]?.status === 'running')
    const sessionId = snapshot.state.tasks[0]!.sessionId!
    expect(f.host.options.get(sessionId)?.thinkingLevel).toBe('low')
    expect(snapshot.state.tasks[0]?.thinkingLevel).toBe('low')
    f.host.complete(sessionId, 'Extracted')
    await until(() => f.service.get('alpha'), s => s.state.tasks[0]?.status === 'completed')
    f.advance(2_000)
    await f.service.command('alpha', { type: 'task', title: 'Analyze', instructions: 'Analyze fields' })
    snapshot = await until(() => f.service.get('alpha'), s => s.state.tasks[1]?.status === 'running')
    expect(snapshot.state.tasks[1]?.sessionId).toBe(sessionId)
    expect(f.host.options.get(sessionId)?.thinkingLevel).toBe('medium')
    const persisted = await loadSuperAgentDocument(join(f.root, 'alpha'))
    expect(persisted.state.tasks[0]?.thinkingLevel).toBe('low')
  })

  it('rejects fixed-node overrides and output tasks missing acceptance contracts', async () => {
    const f = await superAgentFixture()
    f.config.nodes[1]!.thinkingMode = 'fixed'
    await f.service.save('alpha', f.config)
    await expect(f.service.command('alpha', { type: 'task', title: 'Override', instructions: 'Work', thinkingLevel: 'max' })).rejects.toThrow('fixed thinking')
    f.config.workflow = { pattern: 'development', maxParallelTasks: 2, independentReview: true }
    await expect(f.service.save('alpha', f.config)).rejects.toThrow('at least two worker')
    f.config.nodes.push({ ...f.config.nodes[1]!, id: 'verifier' })
    await f.service.save('alpha', f.config)
    await expect(f.service.command('alpha', { type: 'task', title: 'Missing', instructions: 'Criteria only in prose', requiresIndependentReview: false })).rejects.toThrow('acceptanceCriteria')
    expect((await f.service.get('alpha')).state.tasks).toHaveLength(0)
    const accepted = await f.service.command('alpha', { type: 'task', title: 'Valid', instructions: 'Produce artifact', acceptanceCriteria: ['Tests pass'], requiresIndependentReview: false })
    expect(accepted.state.tasks[0]?.requiresIndependentReview).toBe(true)
  })

  it('applies thinking levels from actual orchestrator action blocks', async () => {
    const f = await superAgentFixture()
    f.config = withSuperAgentOrchestrator(f.config)
    await f.service.save('alpha', f.config)
    await f.service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'orchestrator', body: 'Plan work' })
    const planning = await until(() => f.service.get('alpha'), s => s.state.nodes.find(node => node.nodeId === 'orchestrator')?.status === 'working')
    f.host.complete(planning.state.nodes.find(node => node.nodeId === 'orchestrator')!.sessionId!, '<super_agent_actions>{"tasks":[{"title":"Review","instructions":"Review result","thinkingLevel":"high","nodeId":"worker"}]}</super_agent_actions>')
    const running = await until(() => f.service.get('alpha'), s => s.state.tasks[0]?.status === 'running')
    expect(f.host.options.get(running.state.tasks[0]!.sessionId!)?.thinkingLevel).toBe('high')
  })

  it('meters session deltas once, preserves them on disk and never sums context tokens', async () => {
    const f = await superAgentFixture()
    await f.service.save('alpha', f.config)
    const usage = (outputTokens: number, costUsd: number) => ({ inputTokens: 9000, outputTokens, totalTokens: 9000 + outputTokens, contextTokens: 9000, costUsd })
    for (const index of [1, 2]) {
      f.advance(2_000)
      await f.service.command('alpha', { type: 'task', title: `Step ${index}`, instructions: 'Work' })
      const running = await until(() => f.service.get('alpha'), s => s.state.tasks[index - 1]?.status === 'running')
      const sessionId = running.state.tasks[index - 1]!.sessionId!
      f.advance(200)
      f.host.complete(sessionId, 'Verified', 'complete', { tokenUsage: usage(index * 100, index * 0.01) })
      await until(() => f.service.get('alpha'), s => s.state.tasks[index - 1]?.status === 'completed')
      f.host.complete(sessionId, 'Duplicate', 'complete', { tokenUsage: usage(index * 100, index * 0.01) })
    }
    const row = (await f.service.get('alpha')).state.statistics!.nodes.find(node => node.nodeId === 'worker')!
    expect(row.outputTokens).toBe(200)
    expect(row.costUsd).toBeCloseTo(0.02)
    expect(row.usageObservations).toBe(2)
    expect(row.executionMs).toBe(400)
    expect('inputTokens' in row).toBe(false)
    expect((await loadSuperAgentDocument(join(f.root, 'alpha'))).state.statistics?.nodes.find(node => node.nodeId === 'worker')).toEqual(row)
  })

  it('checks draft setup before the first save and rejects unmet requirements without model execution', async () => {
    const f = await superAgentFixture({ checkReadiness: async () => ({ ready: false, checkedAt: 1, checks: [{ id: 'programs', ok: false, detail: 'Missing python3' }] }) })
    const checked = await f.service.command('alpha', { type: 'environment-check', config: f.config })
    expect(checked.config).toBeNull()
    expect(checked.readiness?.ready).toBe(false)
    f.config.requirements = { programs: ['python3'], browser: false }
    await expect(f.service.save('alpha', f.config)).rejects.toThrow('Missing python3')
    expect(f.host.sends).toHaveLength(0)
  })
})
