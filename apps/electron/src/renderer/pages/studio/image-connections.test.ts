import { describe, expect, it } from 'bun:test'
import type { LlmConnectionWithStatus } from '../../../shared/types'
import { imageGroups, imageModels, isImageConnection, preferredImageGroup } from './image-connections'

const connection = (overrides: Partial<LlmConnectionWithStatus>) => ({
  slug: 'image', name: 'Image', providerType: 'pi_compat', authType: 'api_key_with_endpoint',
  isAuthenticated: true, createdAt: 1, models: [], ...overrides,
}) as LlmConnectionWithStatus

describe('Studio image connections', () => {
  it('uses the first model in the dedicated TokenNest image group', () => {
    const item = connection({ oauthProvider: 'tokennest', authType: 'oauth', models: ['gpt-text', 'gpt-image-global'], channelGroups: [
      { id: 'chat', name: '聊天', models: ['gpt-text'] },
      { id: 'drawing', name: 'GPT图片生成渠道', models: ['gpt-image-1.5', 'gpt-6-astra', 'gpt-image-1'] },
    ] })
    expect(imageGroups(item).map(group => group.id)).toEqual(['drawing'])
    expect(preferredImageGroup(item)).toBe('drawing')
    expect(imageModels(item, 'drawing')).toEqual(['gpt-image-1.5', 'gpt-image-1'])
  })

  it('offers GPT Image for an official OpenAI key whose Agent preset lists chat models', () => {
    const item = connection({ authType: 'api_key', piAuthProvider: 'openai', models: ['gpt-5'] })
    expect(isImageConnection(item)).toBe(true)
    expect(imageModels(item)).toEqual(['gpt-image-1'])
  })

  it('does not offer OAuth image models when no image group is available', () => {
    const item = connection({ oauthProvider: 'tokennest', authType: 'oauth', models: ['gpt-6-astra', 'gpt-image-2.5'], channelGroups: [] })
    expect(imageGroups(item)).toEqual([])
    expect(imageModels(item)).toEqual([])
  })

  it('does not offer an empty image group or another group’s model', () => {
    const item = connection({ oauthProvider: 'tokennest', authType: 'oauth', models: ['gpt-image-2.5'], channelGroups: [
      { id: 'drawing', name: 'GPT图片生成渠道', models: [] },
      { id: 'Normal', name: 'Normal', models: ['gpt-6-astra'] },
    ] })
    expect(imageGroups(item)).toEqual([])
    expect(imageModels(item, 'drawing')).toEqual([])
  })

  it('rejects an Anthropic key and does not invent image models for a custom endpoint', () => {
    expect(isImageConnection(connection({ piAuthProvider: 'anthropic' }))).toBe(false)
    expect(imageModels(connection({ baseUrl: 'https://example.com/v1', piAuthProvider: 'openai', models: ['chat-only'] }))).toEqual([])
  })
})
