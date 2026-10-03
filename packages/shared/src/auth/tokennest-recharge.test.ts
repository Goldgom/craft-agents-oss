import { afterEach, describe, expect, it } from 'bun:test'
import { createTokenNestRechargeSession, TOKENNEST_OAUTH_CONFIG } from './tokennest-oauth'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

describe('TokenNest recharge session API', () => {
  it('creates a one-time entry using OAuth in the header only', async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(TOKENNEST_OAUTH_CONFIG.rechargeSessionUrl)
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access')
      expect(init?.body).toBeUndefined()
      return Response.json({ data: { url: 'https://openai.goldgom.top/oauth/recharge?ticket=opaque', expires_in: 60 } })
    }) as typeof fetch
    await expect(createTokenNestRechargeSession('access')).resolves.toEqual({
      url: 'https://openai.goldgom.top/oauth/recharge?ticket=opaque', requiresWebsiteLogin: false,
    })
  })

  it('falls back only when the endpoint is not deployed', async () => {
    globalThis.fetch = Object.assign(async () => Response.json({ error: 'not_found' }, { status: 404 }), { preconnect: originalFetch.preconnect })
    await expect(createTokenNestRechargeSession('access')).resolves.toMatchObject({ requiresWebsiteLogin: true })
    globalThis.fetch = Object.assign(async () => Response.json({ error: 'insufficient_scope' }, { status: 403 }), { preconnect: originalFetch.preconnect })
    await expect(createTokenNestRechargeSession('access')).rejects.toMatchObject({ status: 403 })
  })

  it('rejects missing, unsafe and overly long-lived ticket URLs', async () => {
    for (const data of [
      { url: 'https://evil.example/oauth/recharge?ticket=opaque', expires_in: 60 },
      { url: 'https://openai.goldgom.top/oauth/recharge', expires_in: 60 },
      { url: 'https://openai.goldgom.top/wallet', expires_in: 60 },
      { url: 'https://openai.goldgom.top/oauth/recharge?ticket=opaque', expires_in: 600 },
    ]) {
      globalThis.fetch = Object.assign(async () => Response.json({ data }), { preconnect: originalFetch.preconnect })
      await expect(createTokenNestRechargeSession('access')).rejects.toThrow()
    }
  })
})
