import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { LlmConnectionWithStatus } from '@config/llm-connections'
import { getTokenNestRechargeConnection, openTokenNestRecharge, rechargeOnInsufficientBalance, TOKENNEST_BALANCE_REFRESH_EVENT } from '../tokennest-recharge'

const originalWindow = globalThis.window
afterEach(() => { globalThis.window = originalWindow })
const account = (overrides: Partial<LlmConnectionWithStatus> = {}): LlmConnectionWithStatus => ({
  slug: 'account', name: 'TokenNest', authType: 'oauth', oauthProvider: 'tokennest', providerType: 'pi_compat',
  createdAt: 1, isAuthenticated: true, isDefault: true, ...overrides,
})

describe('TokenNest recharge routing', () => {
  it('uses the session connection before workspace/global defaults', () => {
    const connections = [account(), account({ slug: 'other', oauthProvider: undefined, authType: 'api_key', isDefault: false })]
    expect(getTokenNestRechargeConnection(connections, 'other', 'account')).toBeUndefined()
    expect(getTokenNestRechargeConnection(connections, 'deleted', 'account')).toBeUndefined()
    expect(getTokenNestRechargeConnection(connections, undefined, 'account')?.slug).toBe('account')
    expect(getTokenNestRechargeConnection([account({ isAuthenticated: false })])).toBeUndefined()
  })

  it('ignores other accounts, unauthenticated accounts and unrelated billing errors', () => {
    expect(rechargeOnInsufficientBalance('余额不足', account({ authType: 'api_key' }))).toBe(false)
    expect(rechargeOnInsufficientBalance('余额不足', account({ isAuthenticated: false }))).toBe(false)
    expect(rechargeOnInsufficientBalance('402 payment required', account())).toBe(false)
    expect(rechargeOnInsufficientBalance('429 rate limit exceeded', account())).toBe(false)
  })

  it('coalesces repeated failures and refreshes balance only after the wallet closes', async () => {
    let close!: () => void
    const closed = new Promise<void>(resolve => { close = resolve })
    const getUrl = mock(async () => ({ url: 'https://openai.goldgom.top/oauth/recharge?ticket=opaque', requiresWebsiteLogin: false }))
    const open = mock(() => closed)
    const dispatchEvent = mock((_event: Event) => true)
    globalThis.window = { electronAPI: { getTokenNestRechargeUrl: getUrl, openTokenNestRecharge: open }, dispatchEvent } as unknown as Window & typeof globalThis
    expect(rechargeOnInsufficientBalance('余额不足', account())).toBe(true)
    const pending = openTokenNestRecharge('account')
    await Promise.resolve()
    expect(getUrl).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
    expect(dispatchEvent).not.toHaveBeenCalled()
    close()
    await pending
    expect(dispatchEvent.mock.calls[0]?.[0].type).toBe(TOKENNEST_BALANCE_REFRESH_EVENT)
  })
})
