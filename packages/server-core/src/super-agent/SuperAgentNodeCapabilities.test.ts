import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { validateSuperAgentConfig } from '@tokenbird/shared/super-agent'
import { resolveSessionAgentRuntime, type LlmConnection } from '@tokenbird/shared/config/llm-connections'
import { sameNodeSessionIdentity } from './SuperAgentScheduling'
import { superAgentFixture, until } from './SuperAgentTestSupport'

test('node backend selection keeps the shared connection intact and rejects incompatible engines', () => {
  const connection = { slug: 'shared', name: 'Shared connection', providerType: 'anthropic', agentRuntime: 'claude-code', authType: 'api_key' } as LlmConnection
  expect(resolveSessionAgentRuntime(connection, 'pi')).toBe('pi')
  expect(resolveSessionAgentRuntime(connection)).toBe('claude-code')
  expect(connection.agentRuntime).toBe('claude-code')
  expect(() => resolveSessionAgentRuntime(connection, 'codex')).toThrow('not compatible')
  expect(() => resolveSessionAgentRuntime(connection, 'plugin:not-installed')).toThrow('not compatible')
})

test('validates legacy nodes, explicit skills and backend choices without widening the MCP pool', async () => {
  const f = await superAgentFixture()
  expect(validateSuperAgentConfig(f.config).nodes[1]!.skillSlugs).toBeUndefined()
  f.config.nodes[1]!.skillSlugs = ['report']
  f.config.nodes[1]!.agentRuntime = 'pi'
  expect(validateSuperAgentConfig(f.config).nodes[1]).toMatchObject({ skillSlugs: ['report'], agentRuntime: 'pi' })
  expect(() => validateSuperAgentConfig({ ...f.config, nodes: f.config.nodes.map(node => ({ ...node, skillSlugs: ['report', 'report'] })) })).toThrow('Duplicate node skills')
  expect(() => validateSuperAgentConfig({ ...f.config, nodes: f.config.nodes.map(node => ({ ...node, agentRuntime: 'invalid' })) })).toThrow()
  expect(() => validateSuperAgentConfig({ ...f.config, nodes: f.config.nodes.map(node => ({ ...node, skillSlugs: ['../private'] })) })).toThrow('directory slug')
  f.config.nodes[1]!.sourceSlugs = ['unassigned']
  expect(() => validateSuperAgentConfig(f.config)).toThrow('authorization pool')
})

test('loads current skill instructions per node and applies the selected backend and MCP ceilings', async () => {
  let content = 'Use report instructions VERSION_ONE. Do not claim unchecked results.'
  const f = await superAgentFixture({ resolveNodeSkills: (_workspace, _config, node) => (node.skillSlugs ?? []).map(slug => ({ slug, content })) })
  f.config.sourceSlugs = ['research', 'private']
  f.config.nodes[1]!.sourceSlugs = ['research']
  f.config.nodes[1]!.skillSlugs = ['report']
  f.config.nodes[1]!.agentRuntime = 'pi'
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'task', nodeId: 'worker', title: 'Report', instructions: 'Write the report.' })
  await until(() => f.service.get('alpha'), () => f.host.sends.length === 1)
  const first = f.host.sends[0]!
  expect(first.message).toBe('Write the report.')
  const firstVersion = createHash('sha256').update(content).digest('hex')
  expect(f.host.options.get(first.sessionId)!.agentSystemPrompt).toContain(firstVersion)
  expect(f.host.options.get(first.sessionId)!.agentSystemPrompt).not.toContain('VERSION_ONE')
  expect(f.host.policies.get(first.sessionId)).toMatchObject({ agentRuntime: 'pi', allowSkills: ['super-agent-collaboration', 'report'], allowSources: ['research'], allowSubagents: false })
  f.host.complete(first.sessionId, 'Verified report.')
  await until(() => f.service.get('alpha'), snapshot => snapshot.state.tasks[0]?.status === 'completed')
  content = 'Use report instructions VERSION_TWO.'
  f.advance(2_000)
  await f.service.command('alpha', { type: 'task', nodeId: 'worker', title: 'Second report', instructions: 'Write another report.' })
  await until(() => f.service.get('alpha'), snapshot => snapshot.state.tasks[1]?.status === 'running')
  expect(f.host.sends.find(send => send.message === 'Write another report.')!.sessionId).toBe(first.sessionId)
  expect(f.host.options.get(first.sessionId)!.agentSystemPrompt).toContain(createHash('sha256').update(content).digest('hex'))
  expect(f.host.options.get(first.sessionId)!.agentSystemPrompt).not.toContain(firstVersion)
})

test('backend and skill changes retire node sessions while reordered bindings retain them', async () => {
  const f = await superAgentFixture()
  const node = { ...f.config.nodes[1]!, skillSlugs: ['report', 'review'] }
  expect(sameNodeSessionIdentity(node, { ...node, skillSlugs: ['review', 'report'] })).toBe(true)
  expect(sameNodeSessionIdentity(node, { ...node, agentRuntime: 'pi' })).toBe(false)
  expect(sameNodeSessionIdentity(node, { ...node, skillSlugs: ['report'] })).toBe(false)
  expect(sameNodeSessionIdentity(node, { ...node, name: 'Updated display name' })).toBe(true)
})

test('a host that cannot load selected skills fails before a model is invoked', async () => {
  const f = await superAgentFixture()
  f.config.nodes[1]!.skillSlugs = ['report']
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'task', nodeId: 'worker', title: 'Report', instructions: 'Write it.' })
  await until(() => f.service.get('alpha'), snapshot => snapshot.state.nodes.some(node => node.nodeId === 'worker' && node.status === 'error'))
  expect(f.host.sends).toHaveLength(0)
})
