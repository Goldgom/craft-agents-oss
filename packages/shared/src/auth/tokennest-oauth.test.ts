import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { CredentialManager } from '../credentials/manager.ts';
import {
  TOKENNEST_OAUTH_CONFIG,
  exchangeTokenNestTokens,
  getValidTokenNestCredentials,
  prepareTokenNestOAuth,
  refreshTokenNestTokens,
} from './tokennest-oauth.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('TokenNest OAuth', () => {
  test('prepares an S256 authorization request for the loopback callback', () => {
    const prepared = prepareTokenNestOAuth('http://127.0.0.1:6477/callback');
    const url = new URL(prepared.authUrl);
    expect(url.origin + url.pathname).toBe(TOKENNEST_OAUTH_CONFIG.authorizationUrl);
    expect(url.searchParams.get('client_id')).toBe(TOKENNEST_OAUTH_CONFIG.clientId);
    expect(url.searchParams.get('scope')).toBe('api balance:read offline_access');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:6477/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(prepared.state);
    expect(prepared.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });

  test('rejects non-IP and non-loopback callback URLs', () => {
    expect(() => prepareTokenNestOAuth('http://localhost:6477/callback')).toThrow();
    expect(() => prepareTokenNestOAuth('https://example.com/callback')).toThrow();
  });

  test('exchanges and rotates tokens without exposing a client secret', async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({
        access_token: `access-${bodies.length}`,
        refresh_token: `refresh-${bodies.length}`,
        expires_in: 3600,
      }));
    }) as typeof fetch;

    const exchanged = await exchangeTokenNestTokens('code', 'verifier', 'http://127.0.0.1:6477/callback');
    const refreshed = await refreshTokenNestTokens(exchanged.refreshToken!);
    expect(exchanged.accessToken).toBe('access-1');
    expect(refreshed.refreshToken).toBe('refresh-2');
    expect(bodies[0]).toContain('grant_type=authorization_code');
    expect(bodies[1]).toContain('grant_type=refresh_token');
    expect(bodies.join('&')).not.toContain('client_secret');
  });

  test('coalesces concurrent refreshes and atomically stores the rotated token', async () => {
    let stored = {
      accessToken: 'expired-access-token',
      refreshToken: 'one-time-refresh-token',
      expiresAt: Date.now() - 1,
    };
    const setLlmOAuth = mock(async (_slug: string, tokens: typeof stored) => {
      stored = tokens;
    });
    const credentialManager = {
      getLlmOAuth: mock(async () => stored),
      setLlmOAuth,
    } as unknown as CredentialManager;
    const refreshRequests: string[] = [];
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      refreshRequests.push(String(init?.body));
      await Promise.resolve();
      return Response.json({
        access_token: 'fresh-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600,
      });
    }) as unknown as typeof fetch;

    const [first, second] = await Promise.all([
      getValidTokenNestCredentials('tokennest', credentialManager),
      getValidTokenNestCredentials('tokennest', credentialManager),
    ]);

    expect(first).toEqual(second);
    expect(first?.accessToken).toBe('fresh-access-token');
    expect(first?.refreshToken).toBe('rotated-refresh-token');
    expect(refreshRequests).toHaveLength(1);
    expect(refreshRequests[0]).toContain('refresh_token=one-time-refresh-token');
    expect(setLlmOAuth).toHaveBeenCalledTimes(1);
    expect(stored.refreshToken).toBe('rotated-refresh-token');
  });
});
