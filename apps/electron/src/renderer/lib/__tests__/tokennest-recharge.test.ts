import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { toast } from 'sonner'
import type { LlmConnectionWithStatus } from '@config/llm-connections'
import { getRechargeConnection, getTokenNestRechargeConnection, openConnectionRecharge, openTokenNestRecharge, rechargeOnInsufficientBalance, TOKENNEST_BALANCE_REFRESH_EVENT } from '../tokennest-recharge'

const originalWindow = globalThis.window
afterEach(() => { globalThis.window = originalWindow; mock.restore() })
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

  it('ignores accounts without recharge targets, unauthenticated accounts and unrelated billing errors', () => {
    expect(rechargeOnInsufficientBalance('余额不足', account({ authType: 'api_key', oauthProvider: undefined }))).toBe(false)
    expect(rechargeOnInsufficientBalance('余额不足', account({ isAuthenticated: false }))).toBe(false)
    expect(rechargeOnInsufficientBalance('402 payment required', account())).toBe(false)
    expect(rechargeOnInsufficientBalance('429 rate limit exceeded', account())).toBe(false)
  })

  it('selects the effective provider without falling back to a different payment account', () => {
    const other = account({ slug: 'gateway', oauthProvider: undefined, authType: 'api_key', baseUrl: 'https://gateway.example/v1', isDefault: false })
    expect(getRechargeConnection([account(), other], 'gateway', 'account')).toBe(other)
    expect(getRechargeConnection([account(), other], 'deleted', 'account')).toBeUndefined()
    expect(getRechargeConnection([account(), other], undefined, 'gateway')).toBe(other)
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

  it('keeps recharge sessions for different accounts separate', async () => {
    let close!: () => void
    const closed = new Promise<void>(resolve => { close = resolve })
    const getUrl = mock(async (_slug: string) => ({ url: 'https://openai.goldgom.top/oauth/recharge?ticket=opaque', requiresWebsiteLogin: false }))
    const open = mock(() => closed)
    globalThis.window = { electronAPI: { getTokenNestRechargeUrl: getUrl, openTokenNestRecharge: open }, dispatchEvent: mock(() => true) } as unknown as Window & typeof globalThis
    const first = openTokenNestRecharge('first')
    const second = openTokenNestRecharge('second')
    await Promise.resolve()
    expect(getUrl.mock.calls.map(call => call[0])).toEqual(['first', 'second'])
    close()
    await Promise.all([first, second])
  })
})

describe('external recharge recovery', () => {
  function browserWindow() {
    const events = new EventTarget()
    const openUrl = mock(async (_url: string) => {})
    const dispatchEvent = mock((event: Event) => events.dispatchEvent(event))
    globalThis.window = {
      electronAPI: { openUrl },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent,
    } as unknown as Window & typeof globalThis
    return { openUrl, dispatchEvent, events }
  }

  it('routes non-TokenNest balance failures to their own wallet, coalesces errors and refreshes on return', async () => {
    const { openUrl, dispatchEvent, events } = browserWindow()
    const gateway = account({ slug: 'gateway', authType: 'api_key', oauthProvider: undefined, baseUrl: 'https://gateway.example/v1' })
    expect(rechargeOnInsufficientBalance('余额不足', gateway)).toBe(true)
    await openConnectionRecharge(gateway)
    expect(openUrl.mock.calls).toEqual([['https://gateway.example/console/topup']])
    expect(dispatchEvent).not.toHaveBeenCalled()
    events.dispatchEvent(new Event('focus'))
    expect(dispatchEvent.mock.calls[0]?.[0].type).toBe(TOKENNEST_BALANCE_REFRESH_EVENT)
    await openConnectionRecharge(gateway)
    expect(openUrl).toHaveBeenCalledTimes(2)
    events.dispatchEvent(new Event('focus'))
  })

  it('recovers from native load failure using the regular wallet without reusing the ticket', async () => {
    const { openUrl, events } = browserWindow()
    window.electronAPI.getTokenNestRechargeUrl = mock(async () => ({ url: 'https://openai.goldgom.top/oauth/recharge?ticket=secret', requiresWebsiteLogin: false }))
    window.electronAPI.openTokenNestRecharge = mock(async () => { throw new Error('Error invoking remote method __tokennest:recharge ticket=secret') })
    const errorToast = spyOn(toast, 'error')
    await openTokenNestRecharge('fallback')
    expect(openUrl.mock.calls).toEqual([['https://openai.goldgom.top/wallet']])
    expect(errorToast).not.toHaveBeenCalled()
    events.dispatchEvent(new Event('focus'))
  })

  it('shows a readable error without IPC details or tickets if both opening methods fail', async () => {
    const { openUrl } = browserWindow()
    window.electronAPI.getTokenNestRechargeUrl = mock(async () => ({ url: 'https://openai.goldgom.top/oauth/recharge?ticket=secret', requiresWebsiteLogin: false }))
    window.electronAPI.openTokenNestRecharge = mock(async () => { throw new Error('ticket=secret') })
    openUrl.mockImplementation(async () => { throw new Error('__tokennest:recharge ticket=secret') })
    const errorToast = spyOn(toast, 'error')
    await openTokenNestRecharge('failed')
    expect(errorToast).toHaveBeenCalledTimes(1)
    const copy = JSON.stringify(errorToast.mock.calls)
    expect(copy).not.toContain('secret')
    expect(copy).not.toContain('__tokennest')
  })

  it('does not create a recharge session for a signed-out TokenNest account', async () => {
    const { openUrl } = browserWindow()
    const getUrl = mock(async () => ({ url: '', requiresWebsiteLogin: false }))
    window.electronAPI.getTokenNestRechargeUrl = getUrl
    await openConnectionRecharge(account({ isAuthenticated: false }))
    expect(getUrl).not.toHaveBeenCalled()
    expect(openUrl).not.toHaveBeenCalled()
  })
})
