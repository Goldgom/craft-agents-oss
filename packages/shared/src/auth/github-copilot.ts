/**
 * GitHub Copilot OAuth (device flow + token exchange + model policy enablement).
 *
 * pi-ai 0.81.x privatized its imperative OAuth helpers — `refreshGitHubCopilotToken`
 * and `loginGitHubCopilot` are no longer exported from `@earendil-works/pi-ai/oauth`
 * (the SDK now drives OAuth internally through its CredentialStore pipeline, which
 * assumes SDK-owned credential storage). Our credential storage is app-owned, so
 * both flows live here, mirroring the SDK's internal implementation: GitHub's
 * public OAuth device flow, trading the long-lived GitHub access token for a
 * short-lived Copilot API token (whose `proxy-ep` field routes requests to the
 * correct endpoint for the user's subscription tier), then accepting the policy
 * for gated models so they appear in the account's model listing.
 *
 * Deliberate deltas from the SDK internals: github.com only (no enterprise
 * domains — the app never exposed them), and policy enablement targets the
 * account's live /models listing instead of the SDK's static catalog so newly
 * introduced models can't be missed.
 */

export interface GitHubCopilotTokenCredentials {
  /** The long-lived GitHub OAuth access token (doubles as the refresh credential). */
  refresh: string;
  /** The short-lived Copilot API token (carries proxy-ep routing metadata). */
  access: string;
  /** Expiry in epoch milliseconds, with a 5-minute safety margin applied. */
  expires: number;
}

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

/** VS Code Copilot Chat OAuth app id (same lightly-obfuscated constant as Pi SDK). */
const CLIENT_ID = atob('SXYxLmI1MDdhMDhjODdlY2ZlOTg=');

/** Headers that identify us as a VS Code Copilot client (same as Pi SDK). */
const COPILOT_CLIENT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
} as const;

const CANCEL_MESSAGE = 'GitHub Copilot login cancelled';
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/** RFC 8628 floor — never poll GitHub faster than 1 req/s even if the server misreports `interval`. */
const MIN_POLL_INTERVAL_MS = 1000;
const SLOW_DOWN_TIMEOUT_MESSAGE =
  'GitHub device authorization timed out after one or more slow_down responses. ' +
  'This is often caused by clock drift in WSL or VM environments — sync or restart the VM clock and try again.';
const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;
const MODEL_ENABLEMENT_TIMEOUT_MS = 10_000;

/**
 * Extract the API base URL from a Copilot API token's `proxy-ep` field.
 * Token format: `tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...`
 * → `https://api.individual.githubcopilot.com`.
 */
export function getBaseUrlFromToken(copilotToken: string): string | null {
  const match = copilotToken.match(/proxy-ep=([^;]+)/);
  if (!match?.[1]) return null;
  const apiHost = match[1].replace(/^proxy\./, 'api.');
  return `https://${apiHost}`;
}

export interface GitHubCopilotTokenExchangeOptions {
  /** Aborts the exchange (combined with the built-in timeout). */
  signal?: AbortSignal;
  /** Network timeout in milliseconds; a stalled exchange must not hang callers forever. */
  timeoutMs?: number;
}

/**
 * Exchange a GitHub OAuth access token for a fresh Copilot API token.
 */
export async function refreshGitHubCopilotToken(
  githubAccessToken: string,
  options: GitHubCopilotTokenExchangeOptions = {},
): Promise<GitHubCopilotTokenCredentials> {
  const timeoutMs = options.timeoutMs ?? TOKEN_EXCHANGE_TIMEOUT_MS;
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (options.signal) signals.push(options.signal);
  let response: Response;
  try {
    response = await fetch(COPILOT_TOKEN_URL, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${githubAccessToken}`,
        ...COPILOT_CLIENT_HEADERS,
      },
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if ((error as Error | undefined)?.name === 'TimeoutError') {
      throw new Error(`GitHub Copilot token exchange timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`GitHub Copilot token exchange failed: HTTP ${response.status}`);
  }
  const raw: unknown = await response.json();
  const token = (raw as { token?: unknown })?.token;
  const expiresAt = (raw as { expires_at?: unknown })?.expires_at;
  if (typeof token !== 'string' || typeof expiresAt !== 'number') {
    throw new Error('Invalid Copilot token response fields');
  }
  return {
    refresh: githubAccessToken,
    access: token,
    expires: expiresAt * 1000 - 5 * 60 * 1000,
  };
}

/**
 * Accept the usage policy for a single Copilot model (`POST /models/{id}/policy`).
 * Best-effort like the SDK: returns false instead of throwing — enablement must
 * never fail a login that already holds valid credentials.
 */
export async function enableGitHubCopilotModel(copilotToken: string, modelId: string): Promise<boolean> {
  const baseUrl = getBaseUrlFromToken(copilotToken);
  if (!baseUrl) return false;
  try {
    const response = await fetch(`${baseUrl}/models/${encodeURIComponent(modelId)}/policy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${copilotToken}`,
        ...COPILOT_CLIENT_HEADERS,
        'openai-intent': 'chat-policy',
        'x-interaction-type': 'chat-policy',
      },
      body: JSON.stringify({ state: 'enabled' }),
      signal: AbortSignal.timeout(MODEL_ENABLEMENT_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface GitHubCopilotModelEnablement {
  /** Policy-gated models found in the account's listing (`policy.state !== 'enabled'`). */
  attempted: number;
  /** How many of those the policy-acceptance POST succeeded for. */
  enabled: number;
}

/**
 * Enable every policy-gated model on the account.
 *
 * Some models (the Claude family, Grok, ...) require a one-time policy
 * acceptance before the Copilot API serves them; our model listing only
 * surfaces `policy.state === 'enabled'`, so without this step a fresh account
 * never sees them at all. The ≤0.80.x SDK login did this against its static
 * model catalog; we enable from the account's live /models listing instead.
 * Best-effort throughout: failures log via onProgress and never throw.
 */
export async function enableAllGitHubCopilotModels(
  copilotToken: string,
  onProgress?: (message: string) => void,
): Promise<GitHubCopilotModelEnablement> {
  const none: GitHubCopilotModelEnablement = { attempted: 0, enabled: 0 };
  const baseUrl = getBaseUrlFromToken(copilotToken);
  if (!baseUrl) {
    onProgress?.('Skipping Copilot model enablement: token carries no proxy-ep field');
    return none;
  }
  let gated: string[];
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${copilotToken}`,
        ...COPILOT_CLIENT_HEADERS,
      },
      signal: AbortSignal.timeout(MODEL_ENABLEMENT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const raw = await response.json() as Record<string, unknown>;
    // The Copilot API answers with either {data: [...]} or {models: [...]}.
    const items = raw.data ?? raw.models;
    if (!Array.isArray(items)) {
      throw new Error('Invalid Copilot models response');
    }
    gated = [];
    for (const item of items) {
      const id = (item as { id?: unknown })?.id;
      const state = (item as { policy?: { state?: unknown } })?.policy?.state;
      // A policy object marks the model as policy-gated; mirror the SDK's login
      // behavior of accepting everything not already enabled.
      if (typeof id === 'string' && typeof state === 'string' && state !== 'enabled') {
        gated.push(id);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    onProgress?.(`Skipping Copilot model enablement: could not list models (${msg})`);
    return none;
  }
  if (gated.length === 0) return none;
  const results = await Promise.all(gated.map((modelId) => enableGitHubCopilotModel(copilotToken, modelId)));
  const enabled = results.filter(Boolean).length;
  onProgress?.(`Enabled ${enabled}/${gated.length} policy-gated Copilot models`);
  return { attempted: gated.length, enabled };
}

export interface GitHubCopilotLoginOptions {
  /** Called once the device code is issued — surface it to the user. */
  onDeviceCode?: (info: { userCode: string; verificationUri: string }) => void;
  /** Progress messages suitable for logging. */
  onProgress?: (message: string) => void;
  /** Aborts the login flow (pending sleeps and requests). */
  signal?: AbortSignal;
  /** @internal Test hook — replaces the poll-loop sleep so the device flow runs without real waits. */
  sleepFn?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error(CANCEL_MESSAGE);
}

/** Sleep that rejects on abort — including a signal that is already aborted when called. */
export function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    // Abort events don't re-fire: an already-aborted signal would otherwise
    // wait out the full timer before the next fetch surfaces the abort.
    if (signal?.aborted) {
      reject(new Error(CANCEL_MESSAGE));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(CANCEL_MESSAGE));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run the GitHub OAuth device flow, exchange the resulting GitHub access token
 * for Copilot API credentials, and accept policies for gated models
 * (github.com only; no enterprise domains).
 */
export async function loginGitHubCopilot(
  options: GitHubCopilotLoginOptions = {},
): Promise<GitHubCopilotTokenCredentials> {
  const { onDeviceCode, onProgress, signal } = options;
  throwIfAborted(signal);

  // Step 1: request a device + user code pair
  const deviceResponse = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': COPILOT_CLIENT_HEADERS['User-Agent'],
    },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'read:user' }),
    signal,
  });
  if (!deviceResponse.ok) {
    throw new Error(`GitHub device code request failed: HTTP ${deviceResponse.status}`);
  }
  const device: unknown = await deviceResponse.json();
  const deviceCode = (device as { device_code?: unknown })?.device_code;
  const userCode = (device as { user_code?: unknown })?.user_code;
  const verificationUri = (device as { verification_uri?: unknown })?.verification_uri;
  const interval = (device as { interval?: unknown })?.interval;
  const expiresIn = (device as { expires_in?: unknown })?.expires_in;
  if (
    typeof deviceCode !== 'string' ||
    typeof userCode !== 'string' ||
    typeof verificationUri !== 'string' ||
    typeof expiresIn !== 'number'
  ) {
    throw new Error('Invalid device code response fields');
  }
  // The verification URI gets opened in a browser — only trust http(s) URLs.
  const parsedUri = new URL(verificationUri);
  if (parsedUri.protocol !== 'https:' && parsedUri.protocol !== 'http:') {
    throw new Error('Untrusted verification_uri in device code response');
  }

  onDeviceCode?.({ userCode, verificationUri: parsedUri.href });
  onProgress?.('Waiting for device authorization...');

  // Step 2: poll for the GitHub access token until authorized or expired
  const sleepFn = options.sleepFn ?? abortableSleep;
  let pollIntervalMs = Math.max(
    MIN_POLL_INTERVAL_MS,
    (typeof interval === 'number' && Number.isFinite(interval)
      ? interval
      : DEFAULT_POLL_INTERVAL_SECONDS) * 1000,
  );
  const deadline = Date.now() + expiresIn * 1000;
  let slowDownResponses = 0;
  let githubAccessToken: string | undefined;

  while (githubAccessToken === undefined) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        slowDownResponses > 0 ? SLOW_DOWN_TIMEOUT_MESSAGE : 'GitHub device authorization timed out',
      );
    }
    await sleepFn(Math.min(pollIntervalMs, remainingMs), signal);

    const tokenResponse = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': COPILOT_CLIENT_HEADERS['User-Agent'],
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
      signal,
    });
    // GitHub reports device-flow state as JSON (even errors ride HTTP 200), but
    // proxies and transient 5xx/429s can answer with HTML — read the body once
    // and surface those as status errors rather than a JSON SyntaxError.
    const bodyText = await tokenResponse.text();
    let raw: unknown;
    try {
      raw = JSON.parse(bodyText);
    } catch {
      throw new Error(`GitHub device flow failed: HTTP ${tokenResponse.status}: ${bodyText.slice(0, 200)}`);
    }
    const accessToken = (raw as { access_token?: unknown })?.access_token;
    if (typeof accessToken === 'string') {
      githubAccessToken = accessToken;
      break;
    }
    const error = (raw as { error?: unknown })?.error;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      slowDownResponses += 1;
      // Trust the server-provided interval when given (GitHub reports the new
      // required minimum), else apply RFC 8628's +5s; both go through the floor.
      const nextInterval = (raw as { interval?: unknown })?.interval;
      pollIntervalMs = Math.max(
        MIN_POLL_INTERVAL_MS,
        typeof nextInterval === 'number' && Number.isFinite(nextInterval) && nextInterval > 0
          ? nextInterval * 1000
          : pollIntervalMs + 5000,
      );
      continue;
    }
    const description = (raw as { error_description?: unknown })?.error_description;
    throw new Error(
      `GitHub device flow failed: ${typeof error === 'string' ? error : 'invalid token response'}` +
      (typeof description === 'string' ? `: ${description}` : ''),
    );
  }

  // Step 3: trade the GitHub token for Copilot API credentials
  onProgress?.('Exchanging GitHub token for Copilot credentials...');
  const credentials = await refreshGitHubCopilotToken(githubAccessToken, { signal });

  // Step 4: accept policies for gated models so they actually show up in the
  // account's model listing (the SDK's login did this too — see enableAll docs).
  onProgress?.('Enabling models...');
  await enableAllGitHubCopilotModels(credentials.access, onProgress);

  return credentials;
}
