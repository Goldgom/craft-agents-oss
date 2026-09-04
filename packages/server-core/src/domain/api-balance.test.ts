import { afterEach, describe, expect, test } from 'bun:test'
import type { LlmConnection } from '@craft-agent/shared/config'
import { fetchApiBalance, supportsApiBalance } from './api-balance'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function connection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'provider-api',
    name: 'Provider API',
    providerType: 'pi',
    authType: 'api_key',
    piAuthProvider: 'openrouter',
    createdAt: 1,
    ...overrides,
  }
}

describe('API balance providers', () => {
  test('reads OpenRouter remaining credit without exposing the API key', async () => {
    let endpoint = ''
    let authorization = ''
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      endpoint = String(input)
      authorization = new Headers(init?.headers).get('Authorization') ?? ''
      return new Response(JSON.stringify({ data: { limit_remaining: 12.5 } }))
    }) as typeof fetch

    await expect(fetchApiBalance(connection(), 'secret-key')).resolves.toMatchObject({
      connectionSlug: 'provider-api', remaining: 12.5, currency: 'USD',
    })
    expect(endpoint).toBe('https://openrouter.ai/api/v1/auth/key')
    expect(authorization).toBe('Bearer secret-key')
  })

  test('uses DeepSeek balance endpoint and parses the provider currency', async () => {
    let endpoint = ''
    globalThis.fetch = (async (input: string | URL | Request) => {
      endpoint = String(input)
      return new Response(JSON.stringify({
        balance_infos: [{ total_balance: '8.25', currency: 'CNY' }],
      }))
    }) as typeof fetch

    await expect(fetchApiBalance(connection({ piAuthProvider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }), 'key')).resolves.toMatchObject({
      remaining: 8.25, currency: 'CNY',
    })
    expect(endpoint).toBe('https://api.deepseek.com/user/balance')
  })

  test('does not enable quota lookup for OAuth or unknown providers', () => {
    expect(supportsApiBalance(connection({ authType: 'oauth' }))).toBe(false)
    expect(supportsApiBalance(connection({ piAuthProvider: 'anthropic' }))).toBe(false)
  })
})
