import { expect, spyOn, test } from 'bun:test'
import * as settings from '@tokenbird/shared/config'
import { rebuildSuperAgentConfig } from '@tokenbird/shared/super-agent'
import { superAgentFixture, until } from './SuperAgentTestSupport'
import { applyTokenNestPolicy, loadTokenNestPolicy } from './TokenNestPolicy'
import type { LlmConnection } from '@tokenbird/shared/config'

const account: LlmConnection = { slug: 'account', name: 'Account', providerType: 'pi_compat', authType: 'oauth', oauthProvider: 'tokennest', createdAt: 1,
  channelGroup: 'text', models: ['gemini-4-neon','gpt-6.2-sol','claude-opus-4-8','claude-opus-4-7','other','OTHER','hidden','gpt-image-1'],
  channelGroups: [{ id: 'text', name: 'Text', models: ['gemini-4-neon','gpt-6.2-sol','claude-opus-4-8','claude-opus-4-7','other','OTHER','gpt-image-1'] }] }
const policy = { version: 1, interaction: { model: 'gemini-4-neon', description: 'Interaction' }, main: { model: 'opus', description: 'Lead' },
  dispatch: { model: 'gpt-6.2-sol', description: 'Dispatch' }, includeOtherModels: true, workers: [{ model: 'other', description: 'Coding' }] }

test('explicit workers may reuse a management model without expanding the pool', async () => {
  const f = await superAgentFixture()
  const result = applyTokenNestPolicy(f.config, account, {
    ...policy,
    includeOtherModels: false,
    workers: [{ model: 'opus', description: 'Ordinary autonomous design' }],
  })
  expect(result.modelPool?.map(entry => entry.model)).toEqual(['claude-opus-4-8'])
})

test('reads the public policy URL on the host and propagates invalid policy errors', async () => {
  const f = await superAgentFixture()
  const lookup = spyOn(settings, 'getLlmConnection').mockReturnValue(account)
  const fetchPolicy = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(policy))
  try {
    const team = rebuildSuperAgentConfig(f.config)
    const result = await loadTokenNestPolicy('ws', team, account.slug)
    expect(result.tokenNestPolicy?.connectionSlug).toBe(account.slug)
    expect(result.environment.workingDirectory).toBe(f.workingDirectory)
    const [url, request] = fetchPolicy.mock.calls[0]!
    expect(String(url)).toBe('https://openai.goldgom.top/api/tokenbird/super-agent-policy')
    expect(request?.credentials).toBe('omit')
    fetchPolicy.mockResolvedValue(Response.json({ ...policy, version: 2 }))
    await expect(loadTokenNestPolicy('ws', team, account.slug)).rejects.toThrow()
  } finally { lookup.mockRestore(); fetchPolicy.mockRestore() }
})

test('setup resolves available models, follows updates and stops following after a manual save', async () => {
  let description = 'Lead', checks = 0, offline = false
  const f = await superAgentFixture({ loadTokenNestPolicy: async (_id, config) => {
    checks++
    if (offline) throw Error('offline')
    return applyTokenNestPolicy(config, account, { ...policy, main: { ...policy.main, description } })
  } })
  const snapshot = await f.service.configureFromTokenNest('ws', f.config, account.slug)
  const initial = snapshot.config!
  expect(initial.nodes.find(n => n.role === 'coordinator')?.model).toBe('gemini-4-neon')
  expect(initial.nodes.find(n => n.role === 'planner')?.model).toBe('claude-opus-4-8')
  expect(initial.nodes.find(n => n.role === 'orchestrator')?.model).toBe('gpt-6.2-sol')
  expect(initial.modelPool!.map(m => m.model).sort()).toEqual(['claude-opus-4-7','other'])
  expect(initial.modelPool!.find(m => m.model === 'other')?.capabilityNotes).toBe('Coding')
  expect(initial.environment).toMatchObject(f.config.environment)
  expect(() => applyTokenNestPolicy(initial, account, { ...policy, interaction: { model: 'hidden', description: '' } })).toThrow('hidden')
  expect(applyTokenNestPolicy(initial, account, { ...policy, includeOtherModels: false }).modelPool?.map(m => m.model)).toEqual(['other'])
  await f.service.tick()
  expect(checks).toBe(1)
  offline = true
  f.advance(6 * 3600_000)
  await f.service.tick()
  expect(checks).toBe(2)
  expect((await f.service.get('ws')).config).toEqual(initial)
  offline = false
  description = 'Revised'
  f.advance(15 * 60_000)
  await f.service.tick()
  const updated = await until(() => f.service.get('ws'), s => s.config?.nodes.some(n => n.description === 'Revised') === true)
  expect(updated.config!.modelPool).toEqual(initial.modelPool)
  await f.service.save('ws', { ...updated.config!, tokenNestPolicy: undefined })
  f.advance(6 * 3600_000)
  await f.service.tick()
  expect(checks).toBe(3)
})
