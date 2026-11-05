import { describe, expect, it } from 'bun:test'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import type { Model } from '@earendil-works/pi-ai'
import {
  buildCustomEndpointModelDef,
  buildCustomEndpointProviderModels,
  normalizeCustomEndpointModelEntry,
  stripPiPrefix,
  withCustomEndpointOutputDefaults,
} from './custom-endpoint-models.ts'

describe('custom endpoint output budget', () => {
  for (const [provider, maxTokens, expected] of [
    ['custom-endpoint', undefined, undefined],
    ['custom-endpoint', 600, 600],
    ['openai', undefined, 8192],
  ] as const) {
    it(`sends the caller budget for ${provider}/${maxTokens ?? 'default'} without inventing a limit`, async () => {
      let sent: Record<string, unknown> | undefined
      const model: Model<'openai-completions'> = {
        ...buildCustomEndpointModelDef('gemini-test', undefined, undefined, 'openai-completions'),
        api: 'openai-completions', provider, baseUrl: 'https://invalid.test/v1',
      }
      const stream = withCustomEndpointOutputDefaults((target, context, options) =>
        streamSimple(target as Model<'openai-completions'>, context, options))
      const events = await stream(model, { messages: [{ role: 'user', content: 'Continue', timestamp: 0 }] }, {
        apiKey: 'test-only', maxTokens,
        onPayload: payload => ({ ...(payload as object), user: 'preserved-customization' }),
        fetch: async (_url, init) => {
          sent = JSON.parse(String(init?.body))
          return new Response('data: {"id":"test","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          })
        },
      })
      const result = await events.result()
      expect(result.stopReason).toBe('stop')
      expect(sent?.max_completion_tokens ?? sent?.max_tokens).toBe(expected)
      expect(sent?.user).toBe('preserved-customization')
    })
  }
})

describe('normalizeCustomEndpointModelEntry', () => {
  it('strips pi/ prefixes from string model IDs', () => {
    expect(stripPiPrefix('pi/my-model')).toBe('my-model')
    expect(normalizeCustomEndpointModelEntry('pi/my-model')).toEqual({ id: 'my-model' })
  })

  it('preserves per-model image support when enabled', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/vision-model',
      supportsImages: true,
    })).toEqual({
      id: 'vision-model',
      supportsImages: true,
    })
  })

  it('preserves explicit per-model image support when disabled', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/text-only-model',
      supportsImages: false,
    })).toEqual({
      id: 'text-only-model',
      supportsImages: false,
    })
  })

  it('preserves context window and image support together', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/vision-model',
      contextWindow: 262_144,
      supportsImages: true,
    })).toEqual({
      id: 'vision-model',
      contextWindow: 262_144,
      supportsImages: true,
    })
  })
})

describe('buildCustomEndpointProviderModels', () => {
  it('registers TokenNest models with image input when the connection leaves the capability unset', () => {
    const models = buildCustomEndpointProviderModels(
      ['gpt-vision'],
      { api: 'openai-completions' },
      new Map(),
    )
    expect(models[0]?.input).toEqual(['text', 'image'])
  })

  it('keeps explicit text-only and per-model image settings', () => {
    const overrides = new Map([['vision', { supportsImages: true }]])
    const models = buildCustomEndpointProviderModels(
      ['text-only', 'vision'],
      { api: 'openai-completions', supportsImages: false },
      overrides,
    )
    expect(models.map(model => model.input)).toEqual([['text'], ['text', 'image']])
  })
})

describe('buildCustomEndpointModelDef', () => {
  it('defaults custom endpoint models to image-capable input', () => {
    const model = buildCustomEndpointModelDef('my-model')
    expect(model.input).toEqual(['text', 'image'])
  })

  it('enables image input when the connection explicitly opts in', () => {
    const model = buildCustomEndpointModelDef('vision-model', { supportsImages: true })
    expect(model.input).toEqual(['text', 'image'])
  })

  it('lets per-model overrides disable image input even when the connection default is enabled', () => {
    const model = buildCustomEndpointModelDef('text-only-model', { supportsImages: true }, { supportsImages: false })
    expect(model.input).toEqual(['text'])
  })

  it('lets the connection default disable image input', () => {
    const model = buildCustomEndpointModelDef('deepseek-v3', { supportsImages: false })
    expect(model.input).toEqual(['text'])
  })

  it('lets per-model overrides enable image input and custom context window', () => {
    const model = buildCustomEndpointModelDef('vision-model', undefined, { supportsImages: true, contextWindow: 262_144 })
    expect(model.input).toEqual(['text', 'image'])
    expect(model.contextWindow).toBe(262_144)
  })

  // Regression: tokenbird#1022 — strict OpenAI-compatible gateways 400 on the
  // `store` param. supportsStore:false makes the pi-ai driver omit it entirely.
  it('disables the store param for openai-completions endpoints', () => {
    const model = buildCustomEndpointModelDef('gpt-model', undefined, undefined, 'openai-completions')
    expect((model as { compat?: { supportsStore?: boolean } }).compat).toEqual({ supportsStore: false })
  })

  it('does not set store compat for anthropic-messages endpoints', () => {
    const model = buildCustomEndpointModelDef('claude-model', undefined, undefined, 'anthropic-messages')
    expect((model as { compat?: unknown }).compat).toBeUndefined()
  })

  it('does not set store compat when the api is unspecified', () => {
    const model = buildCustomEndpointModelDef('some-model')
    expect((model as { compat?: unknown }).compat).toBeUndefined()
  })
})
