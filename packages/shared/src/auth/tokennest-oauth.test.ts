import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { CredentialManager } from '../credentials/manager.ts';
import {
  TOKENNEST_OAUTH_CONFIG,
  exchangeTokenNestTokens,
  fetchTokenNestChannelGroups,
  fetchTokenNestUsageRecords,
  fetchTokenNestUsageSummary,
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
    expect(url.searchParams.get('scope')).toBe('api balance:read groups:read usage:read invoice:read offline_access');
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

  test('normalizes OAuth channel groups and sends only the bearer grant', async () => {
    let authorization = '';
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return Response.json({ data: {
        default: { desc: 'Default', ratio: 1, models: ['gpt-5.6-sol'] },
        auto: { desc: 'Automatic', ratio: 'auto' },
      } });
    }) as unknown as typeof fetch;

    await expect(fetchTokenNestChannelGroups('oauth-access')).resolves.toEqual([
      { id: 'default', name: 'Default', ratio: 1, models: ['gpt-5.6-sol'] },
      { id: 'auto', name: 'Automatic', ratio: 'auto' },
    ]);
    expect(authorization).toBe('Bearer oauth-access');
  });

  test('hides the group selector when an older TokenNest has no OAuth groups endpoint', async () => {
    globalThis.fetch = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    await expect(fetchTokenNestChannelGroups('oauth-access')).resolves.toEqual([]);
  });

  test('normalizes provider-authoritative usage summary and records', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/summary')) return Response.json({ data: {
        start_timestamp: 10, end_timestamp: 20, request_count: 2,
        input_tokens: 30, output_tokens: 10, total_tokens: 40,
        charged_quota: 1500, charged_amount_usd: 0.003, currency: 'USD',
      } });
      return Response.json({ data: { total: 1, page: 1, page_size: 100, items: [{
        timestamp: 15, model: 'gpt-5', group: 'vip', input_tokens: 30,
        output_tokens: 10, total_tokens: 40, charged_quota: 1500,
        charged_amount_usd: 0.003, status: 'succeeded', request_id: 'req-1',
      }] } });
    }) as typeof fetch;

    await expect(fetchTokenNestUsageSummary('access', 10, 20)).resolves.toMatchObject({
      requestCount: 2, totalTokens: 40, chargedAmountUsd: 0.003,
    });
    await expect(fetchTokenNestUsageRecords('access', { startTimestamp: 10, endTimestamp: 20 })).resolves.toMatchObject({
      total: 1, items: [{ model: 'gpt-5', group: 'vip', totalTokens: 40, requestId: 'req-1' }],
    });
  });
});
