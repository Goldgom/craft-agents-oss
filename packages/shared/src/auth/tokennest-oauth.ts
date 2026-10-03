/**
 * TokenNest OAuth 2.0 authorization-code flow for public native clients.
 *
 * The client id is intentionally public. Tokens and the PKCE verifier remain
 * server-side; the desktop preload only owns the temporary loopback listener.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { CredentialManager } from '../credentials/manager.ts';
import { CredentialChangedError } from '../credentials/types.ts';
import { TOKENNEST_RECHARGE_URL, validateTokenNestRechargeUrl } from '../utils/billing.ts';

export const TOKENNEST_OAUTH_CONFIG = {
  issuer: 'https://openai.goldgom.top',
  clientId: 'tnc_craft_agents_community',
  authorizationUrl: 'https://openai.goldgom.top/oauth/authorize',
  tokenUrl: 'https://openai.goldgom.top/api/oauth2/token',
  revocationUrl: 'https://openai.goldgom.top/api/oauth2/revoke',
  balanceUrl: 'https://openai.goldgom.top/api/oauth2/balance',
  rechargeSessionUrl: 'https://openai.goldgom.top/api/oauth2/recharge-session',
  groupsUrl: 'https://openai.goldgom.top/api/oauth2/groups',
  usageSummaryUrl: 'https://openai.goldgom.top/api/oauth2/usage/summary',
  usageRecordsUrl: 'https://openai.goldgom.top/api/oauth2/usage/records',
  apiBaseUrl: 'https://openai.goldgom.top/v1',
  scopes: 'api balance:read groups:read usage:read invoice:read offline_access',
} as const;

export interface TokenNestChannelGroup {
  id: string;
  name: string;
  ratio?: number | string;
  models?: string[];
}

export class TokenNestGroupsScopeError extends Error {
  constructor() {
    super('TokenNest authorization is missing groups:read; please sign in again')
    this.name = 'TokenNestGroupsScopeError'
  }
}

export interface TokenNestUsageSummary {
  startTimestamp: number;
  endTimestamp: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  chargedQuota: number;
  chargedAmountUsd: number;
  currency: string;
}

export interface TokenNestUsageRecord {
  timestamp: number;
  model: string;
  group: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  chargedQuota: number;
  chargedAmountUsd: number;
  status: string;
  requestId: string;
}

export interface TokenNestUsageRecordsPage {
  total: number;
  page: number;
  pageSize: number;
  items: TokenNestUsageRecord[];
}

export class TokenNestRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = 'TokenNestRequestError';
  }
}

async function tokenNestJson(accessToken: string, url: URL | string, method = 'GET'): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method,
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
  });
  const body = await response.text();
  let payload: unknown;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`TokenNest returned invalid JSON (${response.status})`);
  }
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  if (!response.ok) {
    const detail = typeof root.error_description === 'string'
      ? root.error_description
      : typeof root.message === 'string'
        ? root.message
        : typeof root.error === 'string' ? root.error : `HTTP ${response.status}`;
    const code = typeof root.error === 'string' ? root.error
      : root.error && typeof root.error === 'object' && 'code' in root.error && typeof root.error.code === 'string'
        ? root.error.code : undefined;
    throw new TokenNestRequestError(`TokenNest request failed: ${detail.slice(0, 300)}`, response.status, code);
  }
  const data = root.data;
  return data && typeof data === 'object' ? data as Record<string, unknown> : root;
}

export async function createTokenNestRechargeSession(accessToken: string): Promise<{ url: string; requiresWebsiteLogin: boolean }> {
  let data: Record<string, unknown>
  try {
    data = await tokenNestJson(accessToken, TOKENNEST_OAUTH_CONFIG.rechargeSessionUrl, 'POST')
  } catch (error) {
    // Older deployments can still recharge through the regular wallet login.
    if (error instanceof TokenNestRequestError && error.status === 404) {
      return { url: TOKENNEST_RECHARGE_URL, requiresWebsiteLogin: true }
    }
    throw error
  }
  if (typeof data.url !== 'string' || typeof data.expires_in !== 'number' || data.expires_in <= 0 || data.expires_in > 60) {
    throw new Error('TokenNest returned an invalid recharge session')
  }
  const url = validateTokenNestRechargeUrl(data.url)
  const parsed = new URL(url)
  if (parsed.pathname !== '/oauth/recharge' || !parsed.searchParams.get('ticket')) {
    throw new Error('TokenNest returned an invalid recharge session')
  }
  return { url, requiresWebsiteLogin: false }
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export async function fetchTokenNestUsageSummary(
  accessToken: string,
  startTimestamp: number,
  endTimestamp: number,
): Promise<TokenNestUsageSummary> {
  const url = new URL(TOKENNEST_OAUTH_CONFIG.usageSummaryUrl);
  url.searchParams.set('start_timestamp', String(startTimestamp));
  url.searchParams.set('end_timestamp', String(endTimestamp));
  const data = await tokenNestJson(accessToken, url);
  return {
    startTimestamp: finiteNumber(data.start_timestamp),
    endTimestamp: finiteNumber(data.end_timestamp),
    requestCount: finiteNumber(data.request_count),
    inputTokens: finiteNumber(data.input_tokens),
    outputTokens: finiteNumber(data.output_tokens),
    totalTokens: finiteNumber(data.total_tokens),
    chargedQuota: finiteNumber(data.charged_quota),
    chargedAmountUsd: finiteNumber(data.charged_amount_usd),
    currency: typeof data.currency === 'string' ? data.currency : 'USD',
  };
}

export async function fetchTokenNestUsageRecords(
  accessToken: string,
  options: { startTimestamp: number; endTimestamp: number; page?: number; pageSize?: number },
): Promise<TokenNestUsageRecordsPage> {
  const url = new URL(TOKENNEST_OAUTH_CONFIG.usageRecordsUrl);
  url.searchParams.set('start_timestamp', String(options.startTimestamp));
  url.searchParams.set('end_timestamp', String(options.endTimestamp));
  url.searchParams.set('page', String(options.page ?? 1));
  url.searchParams.set('page_size', String(Math.min(100, Math.max(1, options.pageSize ?? 100))));
  const data = await tokenNestJson(accessToken, url);
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const items = rawItems.flatMap((entry): TokenNestUsageRecord[] => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    return [{
      timestamp: finiteNumber(item.timestamp),
      model: typeof item.model === 'string' ? item.model : '',
      group: typeof item.group === 'string' ? item.group : '',
      inputTokens: finiteNumber(item.input_tokens),
      outputTokens: finiteNumber(item.output_tokens),
      totalTokens: finiteNumber(item.total_tokens),
      chargedQuota: finiteNumber(item.charged_quota),
      chargedAmountUsd: finiteNumber(item.charged_amount_usd),
      status: typeof item.status === 'string' ? item.status : '',
      requestId: typeof item.request_id === 'string' ? item.request_id : '',
    }];
  });
  return {
    total: finiteNumber(data.total),
    page: finiteNumber(data.page) || options.page || 1,
    pageSize: finiteNumber(data.page_size) || options.pageSize || 100,
    items,
  };
}

/**
 * Fetch groups available to the OAuth grant. This endpoint is an optional
 * TokenNest extension; older servers return 404 and the client keeps working
 * without a group selector.
 */
export async function fetchTokenNestChannelGroups(accessToken: string): Promise<TokenNestChannelGroup[]> {
  const response = await fetch(TOKENNEST_OAUTH_CONFIG.groupsUrl, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 403) {
    const payload = await response.json().catch(() => null) as { error?: string | { code?: string } } | null;
    if (payload?.error === 'insufficient_scope' ||
      (typeof payload?.error === 'object' && payload.error?.code === 'insufficient_scope')) {
      throw new TokenNestGroupsScopeError();
    }
  }
    if (response.status === 404) return [];
    if (!response.ok) throw new TokenNestRequestError(`TokenNest group discovery failed (HTTP ${response.status})`, response.status);
  const payload = await response.json() as unknown;
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : root;
  const entries = Array.isArray(data) ? data : Object.entries(data);
  const groups: TokenNestChannelGroup[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      groups.push({ id: entry, name: entry });
      continue;
    }
    if (Array.isArray(entry)) {
      const [id, raw] = entry;
      if (typeof id !== 'string') continue;
      const detail = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const models = Array.isArray(detail.models) ? detail.models.filter((model): model is string => typeof model === 'string') : [];
      groups.push({
        id,
        name: typeof detail.desc === 'string' && detail.desc.trim() ? detail.desc : id,
        ratio: typeof detail.ratio === 'number' || typeof detail.ratio === 'string' ? detail.ratio : undefined,
        ...(models.length > 0 ? { models } : {}),
      });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const detail = entry as Record<string, unknown>;
      const id = typeof detail.id === 'string' ? detail.id : typeof detail.name === 'string' ? detail.name : '';
      const models = Array.isArray(detail.models) ? detail.models.filter((model): model is string => typeof model === 'string') : [];
      if (id) groups.push({ id, name: typeof detail.description === 'string' ? detail.description : id, ratio: typeof detail.ratio === 'number' || typeof detail.ratio === 'string' ? detail.ratio : undefined, ...(models.length > 0 ? { models } : {}) });
    }
  }
  return groups;
}

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
    throw new TokenNestRequestError(`TokenNest token ${operation} failed: ${response.status} - ${detail.slice(0, 300)}`, response.status);
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

const credentialRefreshesByManager = new WeakMap<CredentialManager, Map<string, Promise<TokenNestTokens>>>();

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

  let credentialRefreshes = credentialRefreshesByManager.get(credentialManager);
  if (!credentialRefreshes) {
    credentialRefreshes = new Map();
    credentialRefreshesByManager.set(credentialManager, credentialRefreshes);
  }
  const existing = credentialRefreshes.get(connectionSlug);
  if (existing) return existing;
  const refresh = (async () => {
    const id = { type: 'llm_oauth' as const, connectionSlug };
    const snapshot = await credentialManager.getSnapshot(id);
    const latest = snapshot.credential;
    if (!latest?.value || !latest.refreshToken) {
      throw new Error('TokenNest refresh credentials are unavailable');
    }
    // Another caller may have completed a refresh before this mutex was set.
    if (!forceRefresh && latest.expiresAt && latest.expiresAt >= Date.now() + 5 * 60_000) {
      return { accessToken: latest.value, refreshToken: latest.refreshToken, expiresAt: latest.expiresAt, scope: latest.scope };
    }
    let tokens: TokenNestTokens;
    try { tokens = await refreshTokenNestTokens(latest.refreshToken); }
    catch (error) {
      // A late invalid_grant from the old token must not diagnose a newer
      // user-provided credential as expired or in need of reauthorization.
      if ((await credentialManager.getSnapshot(id)).revision !== snapshot.revision) throw new CredentialChangedError();
      throw error;
    }
    const updated = { ...tokens, scope: tokens.scope || latest.scope };
    const saved = await credentialManager.compareAndSetMany([{ id, expectedRevision: snapshot.revision,
      credential: { ...latest, value: updated.accessToken, refreshToken: updated.refreshToken, expiresAt: updated.expiresAt, scope: updated.scope },
    }]);
    // A user replacement, deletion, or metadata edit wins. Never retry the
    // remote rotation or return this superseded token for authorization.
    if (!saved) throw new CredentialChangedError();
    return updated;
  })().finally(() => credentialRefreshes.delete(connectionSlug));
  credentialRefreshes.set(connectionSlug, refresh);
  return refresh;
}

export type TokenNestAuthorizationIssue = {
  connectionSlug: string;
  reason: 'missing_scopes' | 'expired';
  missingScopes?: string[];
};

/** Check a saved grant without treating temporary provider failures as a sign-in problem. */
export async function checkTokenNestAuthorization(
  connectionSlug: string,
  credentialManager: CredentialManager,
): Promise<TokenNestAuthorizationIssue | null> {
  const saved = await credentialManager.getLlmOAuth(connectionSlug);
  // A deliberately disconnected account is handled by normal connection setup.
  if (!saved?.accessToken) return null;

  const requiredScopes = TOKENNEST_OAUTH_CONFIG.scopes.split(/\s+/);
  if (saved.scope) {
    const granted = new Set(saved.scope.split(/\s+/));
    const missingScopes = requiredScopes.filter(scope => !granted.has(scope));
    if (missingScopes.length) return { connectionSlug, reason: 'missing_scopes', missingScopes };
  }

  try {
    let credentials = await getValidTokenNestCredentials(connectionSlug, credentialManager);
    if (!credentials) return { connectionSlug, reason: 'expired' };
    const checkAccess = async (accessToken: string): Promise<TokenNestAuthorizationIssue | null> => {
      try {
        await fetchTokenNestChannelGroups(accessToken);
      } catch (error) {
        if (error instanceof TokenNestGroupsScopeError) throw error;
        if (error instanceof TokenNestRequestError && error.status === 401) throw error;
        // Other endpoint failures do not establish that the grant is incomplete.
      }
      const now = Date.now();
      const capabilities = [
        { url: TOKENNEST_OAUTH_CONFIG.balanceUrl, scope: 'balance:read' },
        { url: new URL(`${TOKENNEST_OAUTH_CONFIG.usageSummaryUrl}?start_timestamp=${now - 86_400_000}&end_timestamp=${now}`), scope: 'usage:read' },
      ];
      for (const capability of capabilities) {
        try {
          await tokenNestJson(accessToken, capability.url);
        } catch (error) {
          if (error instanceof TokenNestRequestError && error.status === 403 && error.code === 'insufficient_scope') {
            return { connectionSlug, reason: 'missing_scopes', missingScopes: [capability.scope] };
          }
          // Older TokenNest servers may not implement these optional endpoints.
          if (error instanceof TokenNestRequestError && error.status === 404) continue;
          if (error instanceof TokenNestRequestError && error.status === 401) throw error;
          // Keep probing other capabilities after a temporary or unrelated error.
        }
      }
      return null;
    };
    try {
      return await checkAccess(credentials.accessToken);
    } catch (error) {
      if (!(error instanceof TokenNestRequestError) || error.status !== 401) throw error;
      credentials = await getValidTokenNestCredentials(connectionSlug, credentialManager, true);
      if (!credentials) return { connectionSlug, reason: 'expired' };
      return await checkAccess(credentials.accessToken);
    }
  } catch (error) {
    if (error instanceof TokenNestGroupsScopeError) {
      return { connectionSlug, reason: 'missing_scopes', missingScopes: ['groups:read'] };
    }
    if (error instanceof TokenNestRequestError && (
      error.status === 401 || (error.status === 400 && error.message.startsWith('TokenNest token refresh failed'))
    )) {
      return { connectionSlug, reason: 'expired' };
    }
    // Offline, server error, or a temporarily unavailable extension endpoint.
    return null;
  }
}
