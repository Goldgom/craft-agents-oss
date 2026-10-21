import { expect, test } from 'bun:test'
import { loadSuperAgentDocument } from '@tokenbird/shared/super-agent'
import { join } from 'node:path'
import { superAgentFixture, until } from './SuperAgentTestSupport'
import { needsAutoCompaction, saveCompactionMemory } from './SuperAgentCompaction'

test('threshold compaction runs before queued chat, persists a retrievable checkpoint and resumes once', async () => {
  const { service, host, config, advance, root } = await superAgentFixture()
  config.contextCompaction = { enabled: true, tokenThreshold: 8000, saveToMemory: true }
  await service.save('alpha', config)
  await service.command('alpha', { type: 'chat', text: 'Initial request' })
  let snapshot = await until(() => service.get('alpha'), item => item.state.nodes[0]?.status === 'working')
  const sessionId = snapshot.state.nodes[0]!.sessionId!
  host.complete(sessionId, 'Initial answer', 'complete', { tokenUsage: { inputTokens: 8000, contextTokens: 8000, outputTokens: 100, totalTokens: 8100, costUsd: 0 } })
  snapshot = await until(() => service.get('alpha'), item => item.state.nodes[0]?.status === 'idle')
  // A durable plan is copied as a checkpoint, without inventing a verified fact.
  const document = (service as unknown as { documents: Map<string, typeof snapshot> }).documents.get('alpha')!
  document.state.plans.push({ id: 'plan', title: 'Keep exact path', instructions: 'Use C:/work/model.pt; tolerance 0.001', status: 'active', priority: 1, note: 'Not yet verified', revision: 1, updatedBy: 'main', updatedAt: 1000 })
  advance(1001)
  await service.command('alpha', { type: 'chat', text: 'Continue the existing request' })
  await until(() => service.get('alpha'), item => item.state.nodes[0]?.status === 'working')
  expect(host.sends.at(-1)!.message).toStartWith('/compact')
  expect(host.sends.at(-1)!.message).toContain('[super-agent-high-compression]')
  expect(host.sends.at(-1)!.hidden).toBe(true)
  const stored = await loadSuperAgentDocument(join(root, 'alpha'))
  expect(stored.pendingTurns.filter(item => item.kind === 'compact')).toHaveLength(1)
  expect(stored.pendingTurns.some(item => item.text === 'Continue the existing request')).toBe(true)
  expect(stored.state.memories?.[0]?.content).toContain('C:/work/model.pt')
  expect(stored.state.memories?.[0]?.category).toBe('other')
  expect(stored.state.nodes[0]?.lastAutoCompactUsage).toBeTruthy()
  host.complete(sessionId, 'Checkpoint ready\n<super_agent_actions>{"tasks":[{"title":"Must not replay"}]}</super_agent_actions>')
  await until(() => service.get('alpha'), item => item.state.nodes[0]?.status === 'idle')
  advance(1001); await service.tick()
  snapshot = await until(() => service.get('alpha'), item => item.state.nodes[0]?.status === 'working')
  expect(host.sends.at(-1)!.message).toBe('Continue the existing request')
  expect(snapshot.state.tasks).toHaveLength(0)
  expect(host.sends.filter(item => item.message.startsWith('/compact'))).toHaveLength(1)
})

test('disabled, below-threshold and missing usage do not compact; cumulative output is not context', async () => {
  const { config } = await superAgentFixture()
  const usage = { inputTokens: 7999, contextTokens: 0, outputTokens: 100000, totalTokens: 107999, costUsd: 0 }
  config.contextCompaction = { enabled: true, tokenThreshold: 8000, saveToMemory: false }
  expect(needsAutoCompaction(config, usage)).toBe(false)
  expect(needsAutoCompaction(config)).toBe(false)
  expect(needsAutoCompaction(config, { ...usage, inputTokens: 8000 })).toBe(true)
  config.contextCompaction.enabled = false
  expect(needsAutoCompaction(config, { ...usage, inputTokens: 8000 })).toBe(false)
})

test('memory checkpoints are bounded, deduplicated and keep original records intact', async () => {
  const { service, config } = await superAgentFixture()
  await service.save('alpha', config)
  const { state } = await service.get('alpha')
  state.plans.push({ id: 'p', title: 'Plan', instructions: 'Work', status: 'blocked', priority: 1, note: 'Await evidence', revision: 1, updatedBy: 'main', updatedAt: 1 })
  const before = JSON.stringify(state.plans)
  saveCompactionMemory(state, config.nodes[0]!, 'session', 1000)
  saveCompactionMemory(state, config.nodes[0]!, 'session', 2000)
  expect(state.memories).toHaveLength(1)
  expect(state.memories![0]!.revision).toBe(1)
  expect(state.memories![0]!.content.length).toBeLessThan(32000)
  expect(JSON.stringify(state.plans)).toBe(before)
})
