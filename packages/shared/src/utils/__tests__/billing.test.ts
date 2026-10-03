import { describe, expect, it } from 'bun:test'
import { isInsufficientBalanceError, validateTokenNestRechargeUrl } from '../billing'
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
