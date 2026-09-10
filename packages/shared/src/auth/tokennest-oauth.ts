/**
 * TokenNest OAuth 2.0 authorization-code flow for public native clients.
 *
 * The client id is intentionally public. Tokens and the PKCE verifier remain
 * server-side; the desktop preload only owns the temporary loopback listener.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { CredentialManager } from '../credentials/manager.ts';

export const TOKENNEST_OAUTH_CONFIG = {
  issuer: 'https://openai.goldgom.top',
  clientId: 'tnc_craft_agents_community',
  authorizationUrl: 'https://openai.goldgom.top/oauth/authorize',
  tokenUrl: 'https://openai.goldgom.top/api/oauth2/token',
  revocationUrl: 'https://openai.goldgom.top/api/oauth2/revoke',
  balanceUrl: 'https://openai.goldgom.top/api/oauth2/balance',
  apiBaseUrl: 'https://openai.goldgom.top/v1',
  scopes: 'api balance:read offline_access',
} as const;

export interface TokenNestTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

export interface TokenNestPreparedFlow {
  authUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

function validateLoopbackRedirectUri(redirectUri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new Error('TokenNest OAuth callback URL is invalid');
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.pathname !== '/callback' ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error('TokenNest OAuth requires a 127.0.0.1 loopback callback');
  }
}

export function prepareTokenNestOAuth(redirectUri: string): TokenNestPreparedFlow {
  validateLoopbackRedirectUri(redirectUri);
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const url = new URL(TOKENNEST_OAUTH_CONFIG.authorizationUrl);
  url.search = new URLSearchParams({
    client_id: TOKENNEST_OAUTH_CONFIG.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: TOKENNEST_OAUTH_CONFIG.scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return { authUrl: url.toString(), state, codeVerifier, redirectUri };
}

async function requestTokens(params: URLSearchParams, operation: 'exchange' | 'refresh'): Promise<TokenNestTokens> {
  const response = await fetch(TOKENNEST_OAUTH_CONFIG.tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!response.ok) {
    const payload = await response.text();
    let detail = payload;
    try {
      const parsed = JSON.parse(payload) as { error_description?: string; error?: string };
      detail = parsed.error_description || parsed.error || payload;
    } catch {
      // Keep the provider response as a bounded diagnostic below.
    }
    throw new Error(`TokenNest token ${operation} failed: ${response.status} - ${detail.slice(0, 300)}`);
  }

  const data = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!data.access_token) throw new Error('TokenNest returned no access token');
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Number.isFinite(data.expires_in) ? Date.now() + data.expires_in! * 1000 : undefined,
    scope: data.scope,
  };
}

export function exchangeTokenNestTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenNestTokens> {
  validateLoopbackRedirectUri(redirectUri);
  return requestTokens(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: TOKENNEST_OAUTH_CONFIG.clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  }), 'exchange');
}

export async function refreshTokenNestTokens(refreshToken: string): Promise<TokenNestTokens> {
  const tokens = await requestTokens(new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: TOKENNEST_OAUTH_CONFIG.clientId,
    refresh_token: refreshToken,
  }), 'refresh');
  // TokenNest rotates refresh tokens. A missing replacement is tolerated for
  // interoperability, but the previous value is never discarded accidentally.
  return { ...tokens, refreshToken: tokens.refreshToken || refreshToken };
}

export async function revokeTokenNestToken(token: string): Promise<void> {
  const response = await fetch(TOKENNEST_OAUTH_CONFIG.revocationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });
  if (!response.ok) throw new Error(`TokenNest token revocation failed: ${response.status}`);
}

const credentialRefreshes = new Map<string, Promise<TokenNestTokens>>();

/**
 * Return a usable TokenNest access token and atomically persist rotated tokens.
 * The per-connection mutex is required because TokenNest treats refresh-token
 * reuse as a replay and revokes the whole grant.
 */
export async function getValidTokenNestCredentials(
  connectionSlug: string,
  credentialManager: CredentialManager,
  forceRefresh = false,
): Promise<TokenNestTokens | null> {
  const stored = await credentialManager.getLlmOAuth(connectionSlug);
  if (!stored?.accessToken) return null;
  const expiring = !stored.expiresAt || stored.expiresAt < Date.now() + 5 * 60_000;
  if (!forceRefresh && !expiring) return stored;
  if (!stored.refreshToken) return forceRefresh || expiring ? null : stored;

  const existing = credentialRefreshes.get(connectionSlug);
  if (existing) return existing;
  const refresh = (async () => {
    const latest = await credentialManager.getLlmOAuth(connectionSlug);
    if (!latest?.accessToken || !latest.refreshToken) {
      throw new Error('TokenNest refresh credentials are unavailable');
    }
    // Another caller may have completed a refresh before this mutex was set.
    if (!forceRefresh && latest.expiresAt && latest.expiresAt >= Date.now() + 5 * 60_000) {
      return latest;
    }
    const tokens = await refreshTokenNestTokens(latest.refreshToken);
    await credentialManager.setLlmOAuth(connectionSlug, tokens);
    return tokens;
  })().finally(() => credentialRefreshes.delete(connectionSlug));
  credentialRefreshes.set(connectionSlug, refresh);
  return refresh;
}
