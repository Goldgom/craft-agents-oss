import { describe, expect, it } from 'bun:test'
import type { LlmConnectionWithStatus } from '../../../shared/types'
import { mindMapGroupForModel, mindMapTextModels } from './mindmap-models'

const connection = {
  slug: 'tokennest', name: 'TokenNest', providerType: 'pi_compat', authType: 'oauth',
  oauthProvider: 'tokennest', isAuthenticated: true, createdAt: 1,
  channelGroup: 'astra', defaultModel: 'gpt-6-astra',
  models: ['gpt-6-astra', 'gpt-6-sol', 'gpt-image-2.5'],
  channelGroups: [
    { id: 'astra', name: 'Astra', models: ['gpt-6-astra'] },
    { id: 'text', name: '文本', models: ['gpt-6-sol', 'gpt-6-astra'] },
    { id: 'images', name: '绘画', models: ['gpt-image-2.5'] },
  ],
} as LlmConnectionWithStatus

describe('mind map model selection', () => {
  it('shows text models from all groups without image models or duplicates', () => {
    expect(mindMapTextModels(connection)).toEqual(['gpt-6-astra', 'gpt-6-sol'])
  })

  it('routes each model to a group that actually contains it', () => {
    expect(mindMapGroupForModel(connection, 'gpt-6-astra')).toBe('astra')
    expect(mindMapGroupForModel(connection, 'gpt-6-sol')).toBe('text')
  })

  it('uses configured models for a custom API connection', () => {
    const custom = { ...connection, oauthProvider: undefined, authType: 'api_key_with_endpoint' } as LlmConnectionWithStatus
    expect(mindMapTextModels(custom)).toEqual(['gpt-6-astra', 'gpt-6-sol'])
    expect(mindMapGroupForModel(custom, 'gpt-6-sol')).toBe('')
  })
})
