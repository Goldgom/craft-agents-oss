import { describe, expect, it } from 'bun:test'
import type { LlmConnectionWithStatus } from '@config/llm-connections'
import { getOAuthReauthConnection } from '../oauth-reauth'

const tokenNest: LlmConnectionWithStatus = {
  slug: 'tokennest', name: 'TokenNest', providerType: 'pi_compat', authType: 'oauth',
  oauthProvider: 'tokennest', isAuthenticated: false, isDefault: true, createdAt: 1,
}
const copilot: LlmConnectionWithStatus = { ...tokenNest, slug: 'copilot', name: 'Copilot', oauthProvider: undefined, isDefault: false }
const expired = { code: 'expired_oauth_token' }

describe('runtime OAuth reauthentication routing', () => {
  it('selects the failing session account even when marked unauthenticated', () => {
    expect(getOAuthReauthConnection(expired, [tokenNest, copilot], 'copilot', 'tokennest')).toBe(copilot)
    expect(getOAuthReauthConnection(expired, [tokenNest, copilot], undefined, 'copilot')).toBe(copilot)
    expect(getOAuthReauthConnection(expired, [tokenNest])).toBe(tokenNest)
  })

  it('does not prompt another account when the session connection is missing or uses an API key', () => {
    expect(getOAuthReauthConnection(expired, [tokenNest], 'deleted', 'tokennest')).toBeUndefined()
    expect(getOAuthReauthConnection(expired, [{ ...tokenNest, authType: 'api_key' }])).toBeUndefined()
  })

  it('recognizes startup/plain expired login errors but ignores temporary refresh failures', () => {
    expect(getOAuthReauthConnection('Your login has expired. Please sign in again to continue.', [tokenNest])).toBe(tokenNest)
    for (const error of [null, 'Token refresh failed. Try again.', 'fetch failed', { code: 'network_error' }, { code: 'service_error' }, { code: 'rate_limited' }]) {
      expect(getOAuthReauthConnection(error, [tokenNest])).toBeUndefined()
    }
  })
})
