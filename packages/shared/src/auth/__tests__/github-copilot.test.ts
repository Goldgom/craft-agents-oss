import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import {
  abortableSleep,
  enableAllGitHubCopilotModels,
  enableGitHubCopilotModel,
  getBaseUrlFromToken,
  loginGitHubCopilot,
  refreshGitHubCopilotToken,
} from '../github-copilot';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const COPILOT_TOKEN = 'tid=1;exp=2;proxy-ep=proxy.individual.githubcopilot.com;st=x';
const COPILOT_BASE = 'https://api.individual.githubcopilot.com';
const CANCEL_MESSAGE = 'GitHub Copilot login cancelled';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function installFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

/** Never-resolving fetch that still honors the request's AbortSignal. */
function installHangingFetch(): void {
  installFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
}

/** Route the full device flow: device code → token polls → exchange → models → policy. */
function installDeviceFlowFetch(opts: {
  device?: Record<string, unknown>;
  polls: Response[];
  exchange?: Response;
  models?: () => Response;
  policy?: (url: string) => Response;
}): RecordedCall[] {
  const polls = [...opts.polls];
  return installFetch((url) => {
    if (url === DEVICE_CODE_URL) {
      return json({
        device_code: 'dev-code',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
        ...opts.device,
      });
    }
    if (url === ACCESS_TOKEN_URL) {
      const next = polls.shift();
      if (!next) throw new Error(`unexpected extra token poll: ${url}`);
      return next;
    }
    if (url === COPILOT_TOKEN_URL) {
      return opts.exchange ?? json({ token: COPILOT_TOKEN, expires_at: 4_102_444_800 });
    }
    if (url === `${COPILOT_BASE}/models`) {
      return opts.models ? opts.models() : json({ data: [] });
    }
    if (url.startsWith(`${COPILOT_BASE}/models/`) && url.endsWith('/policy')) {
      return opts.policy ? opts.policy(url) : json({ state: 'enabled' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const instantSleep = async (): Promise<void> => {};

describe('getBaseUrlFromToken', () => {
  it('derives the API base URL from the proxy-ep field', () => {
    expect(getBaseUrlFromToken(COPILOT_TOKEN)).toBe(COPILOT_BASE);
  });

  it('returns null when the token has no proxy-ep field', () => {
    expect(getBaseUrlFromToken('tid=1;exp=2')).toBeNull();
  });
});

describe('abortableSleep', () => {
  it('resolves after the given duration', async () => {
    const start = Date.now();
    await abortableSleep(10, undefined);
    expect(Date.now() - start).toBeGreaterThanOrEqual(8);
  });

  it('rejects immediately for an already-aborted signal instead of waiting out the timer', async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await expect(abortableSleep(60_000, controller.signal)).rejects.toThrow(CANCEL_MESSAGE);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('rejects when aborted mid-sleep', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await expect(abortableSleep(60_000, controller.signal)).rejects.toThrow(CANCEL_MESSAGE);
  });
});

describe('refreshGitHubCopilotToken', () => {
  it('exchanges the GitHub token and applies the 5-minute expiry margin', async () => {
    const calls = installFetch(() => json({ token: COPILOT_TOKEN, expires_at: 4_102_444_800 }));
    const creds = await refreshGitHubCopilotToken('gh-token');
    expect(creds.refresh).toBe('gh-token');
    expect(creds.access).toBe(COPILOT_TOKEN);
    expect(creds.expires).toBe(4_102_444_800 * 1000 - 5 * 60 * 1000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(COPILOT_TOKEN_URL);
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer gh-token');
  });

  it('throws a status error on a non-ok response', async () => {
    installFetch(() => json({ message: 'nope' }, 403));
    await expect(refreshGitHubCopilotToken('gh-token')).rejects.toThrow('HTTP 403');
  });

  it('rejects responses with missing or mistyped fields', async () => {
    installFetch(() => json({ token: 123, expires_at: 'later' }));
    await expect(refreshGitHubCopilotToken('gh-token')).rejects.toThrow(
      'Invalid Copilot token response fields',
    );
  });

  it('times out instead of hanging on a stalled connection', async () => {
    installHangingFetch();
    await expect(refreshGitHubCopilotToken('gh-token', { timeoutMs: 20 })).rejects.toThrow(
      'timed out after 20ms',
    );
  });

  it('honors a caller-provided abort signal', async () => {
    installHangingFetch();
    const controller = new AbortController();
    const promise = refreshGitHubCopilotToken('gh-token', {
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    setTimeout(() => controller.abort(), 5);
    let error: unknown;
    try {
      await promise;
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(String((error as Error).message ?? error)).not.toContain('timed out after');
  });
});

describe('loginGitHubCopilot', () => {
  it('completes the device flow and enables only policy-gated models', async () => {
    const calls = installDeviceFlowFetch({
      polls: [json({ error: 'authorization_pending' }), json({ access_token: 'gh-token' })],
      models: () =>
        json({
          data: [
            { id: 'claude-x', policy: { state: 'unconfigured' } },
            { id: 'gpt-5', policy: { state: 'enabled' } },
            { id: 'no-policy-model' },
          ],
        }),
    });
    const progress: string[] = [];
    let deviceInfo: { userCode: string; verificationUri: string } | undefined;
    const sleeps: number[] = [];

    const creds = await loginGitHubCopilot({
      onDeviceCode: (info) => {
        deviceInfo = info;
      },
      onProgress: (message) => progress.push(message),
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(creds.refresh).toBe('gh-token');
    expect(creds.access).toBe(COPILOT_TOKEN);
    expect(deviceInfo).toEqual({
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
    });
    expect(sleeps).toEqual([5_000, 5_000]);
    expect(progress).toContain('Enabling models...');
    expect(progress).toContain('Enabled 1/1 policy-gated Copilot models');

    const policyCalls = calls.filter((c) => c.url.endsWith('/policy'));
    expect(policyCalls).toHaveLength(1);
    expect(policyCalls[0]!.url).toBe(`${COPILOT_BASE}/models/claude-x/policy`);
    expect(policyCalls[0]!.init?.method).toBe('POST');
    expect(policyCalls[0]!.init?.body).toBe('{"state":"enabled"}');
  });

  it('honors server-provided slow_down intervals and the +5s fallback', async () => {
    installDeviceFlowFetch({
      polls: [
        json({ error: 'slow_down', interval: 7 }),
        json({ error: 'slow_down' }),
        json({ error: 'authorization_pending' }),
        json({ access_token: 'gh-token' }),
      ],
    });
    const sleeps: number[] = [];
    await loginGitHubCopilot({
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([5_000, 7_000, 12_000, 12_000]);
  });

  it('clamps misreported intervals to the 1-second floor', async () => {
    installDeviceFlowFetch({
      device: { interval: 0 },
      polls: [json({ error: 'slow_down', interval: 0.2 }), json({ access_token: 'gh-token' })],
    });
    const sleeps: number[] = [];
    await loginGitHubCopilot({
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([1_000, 1_000]);
  });

  it('surfaces terminal device-flow errors with their description', async () => {
    installDeviceFlowFetch({
      polls: [json({ error: 'access_denied', error_description: 'The user denied the request' })],
    });
    await expect(loginGitHubCopilot({ sleepFn: instantSleep })).rejects.toThrow(
      'GitHub device flow failed: access_denied: The user denied the request',
    );
  });

  it('reports non-JSON poll responses as status errors, not JSON parse errors', async () => {
    installDeviceFlowFetch({
      polls: [new Response('<html>bad gateway</html>', { status: 502 })],
    });
    await expect(loginGitHubCopilot({ sleepFn: instantSleep })).rejects.toThrow(
      'GitHub device flow failed: HTTP 502: <html>bad gateway</html>',
    );
  });

  it('times out at the device-code deadline', async () => {
    const nowSpy = spyOn(Date, 'now');
    let now = 0;
    nowSpy.mockImplementation(() => now);
    try {
      installDeviceFlowFetch({
        device: { expires_in: 10 },
        polls: [json({ error: 'authorization_pending' }), json({ error: 'authorization_pending' })],
      });
      await expect(
        loginGitHubCopilot({
          sleepFn: async (ms) => {
            now += ms;
          },
        }),
      ).rejects.toThrow('GitHub device authorization timed out');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('mentions clock drift when the flow times out after slow_down responses', async () => {
    const nowSpy = spyOn(Date, 'now');
    let now = 0;
    nowSpy.mockImplementation(() => now);
    try {
      installDeviceFlowFetch({
        device: { expires_in: 10 },
        polls: [json({ error: 'slow_down' }), json({ error: 'slow_down' })],
      });
      await expect(
        loginGitHubCopilot({
          sleepFn: async (ms) => {
            now += ms;
          },
        }),
      ).rejects.toThrow('clock drift');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('rejects immediately when called with an already-aborted signal', async () => {
    installHangingFetch();
    const controller = new AbortController();
    controller.abort();
    await expect(loginGitHubCopilot({ signal: controller.signal })).rejects.toThrow(CANCEL_MESSAGE);
  });

  it('still returns credentials when model enablement fails', async () => {
    installDeviceFlowFetch({
      polls: [json({ access_token: 'gh-token' })],
      models: () => json({ message: 'boom' }, 500),
    });
    const progress: string[] = [];
    const creds = await loginGitHubCopilot({
      onProgress: (message) => progress.push(message),
      sleepFn: instantSleep,
    });
    expect(creds.access).toBe(COPILOT_TOKEN);
    expect(progress.some((m) => m.startsWith('Skipping Copilot model enablement'))).toBe(true);
  });
});

describe('enableAllGitHubCopilotModels', () => {
  it('handles the {models: [...]} listing shape and counts per-model failures', async () => {
    installFetch((url) => {
      if (url === `${COPILOT_BASE}/models`) {
        return json({
          models: [
            { id: 'claude-x', policy: { state: 'unconfigured' } },
            { id: 'grok-y', policy: { state: 'disabled' } },
          ],
        });
      }
      if (url === `${COPILOT_BASE}/models/claude-x/policy`) return json({ state: 'enabled' });
      if (url === `${COPILOT_BASE}/models/grok-y/policy`) return json({ message: 'nope' }, 403);
      throw new Error(`unexpected fetch: ${url}`);
    });
    const result = await enableAllGitHubCopilotModels(COPILOT_TOKEN);
    expect(result).toEqual({ attempted: 2, enabled: 1 });
  });

  it('skips without throwing when the token has no proxy-ep field', async () => {
    const calls = installFetch(() => {
      throw new Error('should not fetch');
    });
    const progress: string[] = [];
    const result = await enableAllGitHubCopilotModels('tid=1;exp=2', (m) => progress.push(m));
    expect(result).toEqual({ attempted: 0, enabled: 0 });
    expect(calls).toHaveLength(0);
    expect(progress[0]).toContain('no proxy-ep');
  });

  it('skips without throwing when the listing request fails', async () => {
    installFetch(() => json({ message: 'boom' }, 500));
    const progress: string[] = [];
    const result = await enableAllGitHubCopilotModels(COPILOT_TOKEN, (m) => progress.push(m));
    expect(result).toEqual({ attempted: 0, enabled: 0 });
    expect(progress[0]).toContain('could not list models');
  });
});

describe('enableGitHubCopilotModel', () => {
  it('returns false instead of throwing on network errors', async () => {
    installFetch(() => {
      throw new Error('connection refused');
    });
    await expect(enableGitHubCopilotModel(COPILOT_TOKEN, 'claude-x')).resolves.toBe(false);
  });
});
