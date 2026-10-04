import { describe, expect, it } from 'bun:test'
import { getProviderRechargeTarget, isInsufficientBalanceError, validateTokenNestRechargeUrl } from '../billing'
import type { LlmConnection } from '../../config/llm-connections'
import { parseError } from '../../agent/errors'

describe('insufficient account balance', () => {
  it('recognizes TokenNest errors before 403/429 status classification', () => {
    for (const message of ['403 用户额度不足, 剩余额度: 0', '429 insufficient_balance',
      '403 insufficient_user_quota', 'wallet quota insufficient', String.raw`insufficient\_quota`, 'credit_balance_exhausted']) {
      expect(isInsufficientBalanceError(new Error(message))).toBe(true)
      expect(parseError(new Error(message)).code).toBe('billing_error')
    }
    expect(isInsufficientBalanceError({ originalError: '余额不足', message: 'Payment required' })).toBe(true)
  })

  it('does not redirect unrelated billing, auth, network or rate-limit errors', () => {
    for (const message of ['402 payment required', '401 unauthorized', '429 rate limit exceeded', '503 service unavailable', 'credit_balance: 100']) {
      expect(isInsufficientBalanceError(message)).toBe(false)
    }
  })

  it('allows only the TokenNest HTTPS wallet and ticket entry', () => {
    expect(validateTokenNestRechargeUrl('https://openai.goldgom.top/oauth/recharge?ticket=opaque')).toContain('ticket=opaque')
    for (const url of ['javascript:alert(1)', 'http://openai.goldgom.top/wallet', 'https://evil.example/wallet',
      'https://openai.goldgom.top/admin', 'https://user:secret@openai.goldgom.top/wallet', 'https://openai.goldgom.top/wallet#secret']) {
      expect(() => validateTokenNestRechargeUrl(url)).toThrow()
    }
  })
})

describe('provider recharge pages', () => {
  const connection = (overrides: Partial<LlmConnection> = {}): LlmConnection => ({
    slug: 'provider', name: 'Provider', providerType: 'pi', authType: 'api_key', piAuthProvider: 'openai', createdAt: 1, ...overrides,
  })

  it('routes known providers and subscription accounts to their billing pages', () => {
    expect(getProviderRechargeTarget(connection())?.url).toBe('https://platform.openai.com/settings/organization/billing/overview')
    expect(getProviderRechargeTarget(connection({ piAuthProvider: 'openai-codex', authType: 'oauth' }))?.url).toStartWith('https://chatgpt.com/')
    expect(getProviderRechargeTarget(connection({ providerType: 'anthropic', authType: 'oauth' }))?.url).toBe('https://claude.ai/settings/billing')
    expect(getProviderRechargeTarget(connection({ baseUrl: 'https://api.deepseek.com/v1' }))?.url).toBe('https://platform.deepseek.com/top_up')
    expect(getProviderRechargeTarget(connection({ piAuthProvider: 'openrouter' }))?.url).toBe('https://openrouter.ai/settings/credits')
    expect(getProviderRechargeTarget(connection({ oauthProvider: 'tokennest' }))?.url).toBe('https://openai.goldgom.top/wallet')
    expect(getProviderRechargeTarget(connection({ baseUrl: 'https://openai.goldgom.top/v1' }))?.url).toBe('https://openai.goldgom.top/wallet')
  })

  it('uses a custom gateway instead of the upstream provider and removes API paths and query credentials', () => {
    expect(getProviderRechargeTarget(connection({ baseUrl: 'https://gateway.example/api/v1?key=secret#token' }))).toEqual({
      url: 'https://gateway.example/console/topup', websiteUrl: 'https://gateway.example', inferred: true,
    })
    expect(getProviderRechargeTarget(connection({ baseUrl: 'https://api.openai.com.example/v1' }))?.url).toBe('https://api.openai.com.example/console/topup')
    expect(getProviderRechargeTarget(connection({ baseUrl: 'https://api.openai.com:8443/v1' }))?.inferred).toBe(true)
  })

  it('does not invent a payment page for local, malformed or unsafe endpoints and unknown providers', () => {
    for (const baseUrl of ['http://localhost:11434/v1', 'https://127.0.0.1/v1', 'https://[::1]/v1', 'file:///tmp', 'javascript:alert(1)', 'https://user:secret@example.com/v1', 'http://gateway.example/v1', 'invalid']) {
      expect(getProviderRechargeTarget(connection({ baseUrl }))).toBeUndefined()
    }
    expect(getProviderRechargeTarget(connection({ piAuthProvider: 'unknown' }))).toBeUndefined()
  })
})
