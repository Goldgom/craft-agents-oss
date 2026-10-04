import { afterEach, describe, expect, it } from 'bun:test'
import { CredentialManager } from '../credentials/manager.ts'
import type { StoredCredential } from '../credentials/types.ts'
import { checkTokenNestAuthorization, getValidTokenNestCredentials, TOKENNEST_OAUTH_CONFIG } from './tokennest-oauth.ts'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function credentials(scope?: string, expiresAt = Date.now() + 60 * 60_000): CredentialManager {
  return {
    getLlmOAuth: async () => ({ accessToken: 'saved-token', scope, expiresAt }),
  } as unknown as CredentialManager
}

describe('TokenNest startup authorization check', () => {
  it('stores and reloads the granted OAuth scope', async () => {
    const manager = new CredentialManager()
    let stored: StoredCredential | null = null
    manager.set = async (_id, value) => { stored = value }
    manager.get = async () => stored
    await manager.setLlmOAuth('tokennest', {
      accessToken: 'token', scope: TOKENNEST_OAUTH_CONFIG.scopes,
    })
    expect((await manager.getLlmOAuth('tokennest'))?.scope).toBe(TOKENNEST_OAUTH_CONFIG.scopes)
  })

  it('keeps the saved scope when a refresh response omits it', async () => {
    const manager = new CredentialManager()
    let stored: StoredCredential | null = {
      value: 'old-token', refreshToken: 'refresh-token',
      expiresAt: Date.now() - 1000, scope: TOKENNEST_OAUTH_CONFIG.scopes,
    }
    manager.set = async (_id, value) => { stored = value }
    manager.get = async () => stored
    manager.getSnapshot = async () => ({ credential: stored, revision: 'dummy-revision' })
    manager.compareAndSetMany = async (changes) => { stored = changes[0]!.credential; return true }
    globalThis.fetch = (async () => Response.json({ access_token: 'new-token', expires_in: 3600 })) as unknown as typeof fetch
    const credentials = await getValidTokenNestCredentials('tokennest', manager)
    expect(credentials?.scope).toBe(TOKENNEST_OAUTH_CONFIG.scopes)
    expect((await manager.getLlmOAuth('tokennest'))?.scope).toBe(TOKENNEST_OAUTH_CONFIG.scopes)
  })

  it('reports every missing permission from a saved OAuth scope without a network call', async () => {
    globalThis.fetch = (() => { throw new Error('unexpected fetch') }) as unknown as typeof fetch
    expect(await checkTokenNestAuthorization('tokennest', credentials('api balance:read'))).toEqual({
      connectionSlug: 'tokennest',
      reason: 'missing_scopes',
      missingScopes: ['groups:read', 'usage:read', 'invoice:read', 'offline_access'],
    })
  })

  it('accepts a full grant when the groups endpoint succeeds', async () => {
    globalThis.fetch = (async () => Response.json({ data: [] })) as unknown as typeof fetch
    expect(await checkTokenNestAuthorization('tokennest', credentials(TOKENNEST_OAUTH_CONFIG.scopes))).toBeNull()
  })

  it('detects a legacy grant without stored scope when TokenNest reports insufficient_scope', async () => {
    globalThis.fetch = (async () => Response.json({ error: 'insufficient_scope' }, { status: 403 })) as unknown as typeof fetch
    expect(await checkTokenNestAuthorization('tokennest', credentials())).toEqual({
      connectionSlug: 'tokennest', reason: 'missing_scopes', missingScopes: ['groups:read'],
    })
  })

  it('detects missing balance access on a legacy grant', async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => String(input).includes('/balance')
      ? Response.json({ error: 'insufficient_scope' }, { status: 403 })
      : Response.json({ data: [] })) as unknown as typeof fetch
    expect(await checkTokenNestAuthorization('tokennest', credentials())).toEqual({
      connectionSlug: 'tokennest', reason: 'missing_scopes', missingScopes: ['balance:read'],
    })
  })

  it('detects missing usage access on a legacy grant', async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => String(input).includes('/usage/summary')
      ? Response.json({ error: 'insufficient_scope' }, { status: 403 })
      : Response.json({ data: [] })) as unknown as typeof fetch
    expect(await checkTokenNestAuthorization('tokennest', credentials())).toEqual({
      connectionSlug: 'tokennest', reason: 'missing_scopes', missingScopes: ['usage:read'],
    })
  })

  it('ignores a temporary network failure', async () => {
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await checkTokenNestAuthorization('tokennest', credentials())).toBeNull()
  })

  it('reports an expired grant when it cannot be refreshed', async () => {
    expect(await checkTokenNestAuthorization('tokennest', credentials(undefined, Date.now() - 1000))).toEqual({
      connectionSlug: 'tokennest', reason: 'expired',
    })
  })

  it('repairs a missing access token during the authorization check', async () => {
    let stored: StoredCredential = { value: '', refreshToken: 'saved-refresh', scope: TOKENNEST_OAUTH_CONFIG.scopes }
    const manager = {
      getLlmOAuth: async () => ({ accessToken: stored.value, refreshToken: stored.refreshToken, scope: stored.scope, expiresAt: stored.expiresAt }),
      getSnapshot: async () => ({ credential: stored, revision: 'revision' }),
      compareAndSetMany: async (changes: import('../credentials/types.ts').CredentialCompareAndSet[]) => { stored = changes[0]!.credential!; return true },
    } as unknown as CredentialManager
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => String(input).endsWith('/token')
      ? Response.json({ access_token: 'repaired-token', refresh_token: 'rotated-refresh', expires_in: 3600 })
      : Response.json({ data: [] })) as unknown as typeof fetch
    expect(await checkTokenNestAuthorization('tokennest', manager)).toBeNull()
    expect(stored.value).toBe('repaired-token')
    expect(stored.refreshToken).toBe('rotated-refresh')
  })

  it('reports a rejected access token when no refresh token is available', async () => {
    globalThis.fetch = (async () => Response.json({ error: 'invalid_token' }, { status: 401 })) as unknown as typeof fetch
    expect(await checkTokenNestAuthorization('tokennest', credentials())).toEqual({
      connectionSlug: 'tokennest', reason: 'expired',
    })
  })
})
