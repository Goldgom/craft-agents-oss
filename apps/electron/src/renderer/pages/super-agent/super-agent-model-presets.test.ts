import { expect, test } from 'bun:test'
import { SuperAgentModelEntrySchema } from '@tokenbird/shared/super-agent'
import { createSubagentModelPreset, mergeSubagentModelPresets, tokenNestModelPresets } from './super-agent-model-presets'
import { createDynamicConfig, nodeModels, type SuperAgentText } from './super-agent-ui'
import type { LlmConnectionWithStatus } from '../../../shared/types'

const connection: LlmConnectionWithStatus = { slug: 'tokennest', name: 'TokenNest', providerType: 'pi_compat', authType: 'oauth', oauthProvider: 'tokennest', isAuthenticated: true, createdAt: 1,
  channelGroup: 'text', models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'deepseek-v4-pro', 'deepseek-v4-flash', 'gemini-2.5-pro', 'gemini-2.5-flash', 'kimi-k3', 'qwen-coder', 'glm-5', 'minimax-m2', 'custom-text-model', 'gpt-image-2.5', 'text-embedding-3-large', 'private-model'],
  channelGroups: [{ id: 'text', name: 'Text', models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'deepseek-v4-pro', 'deepseek-v4-flash', 'gemini-2.5-pro', 'gemini-2.5-flash', 'kimi-k3', 'qwen-coder', 'glm-5', 'minimax-m2', 'custom-text-model', 'gpt-image-2.5', 'text-embedding-3-large'] }] }

test('TokenNest presets cover available model families, exclude other groups and non-agent models', () => {
  const presets = tokenNestModelPresets(connection, nodeModels(connection), true)
  expect(presets).toHaveLength(17)
  for (const entry of presets) {
    expect(entry.llmConnection).toBe(connection.slug)
    expect(entry.capabilityNotes.length).toBeGreaterThan(10)
    expect(entry.intelligenceScore).toBeGreaterThanOrEqual(0)
    expect(entry.intelligenceScore).toBeLessThanOrEqual(100)
    expect(SuperAgentModelEntrySchema.parse(entry)).toEqual(entry)
  }
  expect(presets.map(entry => entry.model)).not.toContain('private-model')
  expect(presets.map(entry => entry.model)).not.toContain('gpt-image-2.5')
  expect(presets.map(entry => entry.model)).not.toContain('text-embedding-3-large')
  expect(presets.find(entry => entry.model === 'gpt-6-astra')!.intelligenceScore).toBeGreaterThan(presets.find(entry => entry.model === 'gpt-6-luna')!.intelligenceScore)
  expect(tokenNestModelPresets({ ...connection, isAuthenticated: false }, nodeModels(connection), true)).toEqual([])
  expect(tokenNestModelPresets({ ...connection, oauthProvider: undefined }, nodeModels(connection), true)).toEqual([])
})

test('new TokenNest teams start with configured available models without fixed worker jobs', () => {
  const text: SuperAgentText = key => key
  const config = createDynamicConfig([connection], text)
  expect(config.modelPool).toHaveLength(17)
  expect(config.nodes.map(node => node.role)).toEqual(['coordinator', 'orchestrator'])
})

test('adding presets is idempotent, preserves user notes, scores, enablement and connection identity', () => {
  const existing = createSubagentModelPreset(connection.slug, 'gpt-6-sol', true)
  existing.capabilityNotes = 'My custom notes'; existing.intelligenceScore = 0; existing.enabled = false
  const presets = tokenNestModelPresets(connection, nodeModels(connection), true)
  const first = mergeSubagentModelPresets([existing], presets)
  expect(first.entries.find(entry => entry.id === existing.id)).toEqual(existing)
  expect(first.entries).toHaveLength(17)
  expect(mergeSubagentModelPresets(first.entries, presets).added).toBe(0)
  expect(mergeSubagentModelPresets(first.entries, [{ ...existing, id: 'other', llmConnection: 'other' }]).added).toBe(1)
  const capped = mergeSubagentModelPresets([], Array.from({ length: 102 }, (_, index) => ({ ...existing, id: `model-${index}`, model: `model-${index}` })))
  expect(capped.entries).toHaveLength(100)
  expect(capped.skipped).toBe(2)
})

test('old stars and separate notes migrate once, while new scores of 0–5 retain their meaning', () => {
  const entry = createSubagentModelPreset('tokennest', 'gpt-6-sol', true)
  const { intelligenceScore: _score, capabilityNotes: _notes, ...base } = entry
  const migrated = SuperAgentModelEntrySchema.parse({ ...base, description: 'Code analysis', capabilities: ['coding'], evaluation: 'Verify critical results', intelligenceRating: 4 })
  expect(migrated.intelligenceScore).toBe(80)
  expect(migrated.capabilityNotes).toContain('Code analysis')
  expect(migrated.capabilityNotes).toContain('coding')
  expect(migrated.capabilityNotes).toContain('Verify critical results')
  expect(SuperAgentModelEntrySchema.parse(migrated)).toEqual(migrated)
  for (const score of [0, 5, 100]) expect(SuperAgentModelEntrySchema.parse({ ...migrated, intelligenceScore: score }).intelligenceScore).toBe(score)
  for (const score of [-1, 101, 2.5]) expect(() => SuperAgentModelEntrySchema.parse({ ...migrated, intelligenceScore: score })).toThrow()
})
