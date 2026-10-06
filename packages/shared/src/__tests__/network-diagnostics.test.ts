import { describe, expect, it } from 'bun:test';
import { fetchWithNetworkDiagnostics, networkErrorChain, sanitizeNetworkMessage } from '../network-diagnostics.ts';

describe('network diagnostics', () => {
  it('records the actual Bun runtime and preserves the SDK signal', async () => {
    const controller = new AbortController();
    let receivedInit: RequestInit | undefined;
    const records: Record<string, unknown>[] = [];
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      receivedInit = init;
      return new Response('ok');
    }) as unknown as typeof fetch;
    const response = await fetchWithNetworkDiagnostics(fetcher, 'https://host/v1/chat/completions', {
      signal: controller.signal,
    }, r => { records.push(r); });
    await response.text();
    expect(receivedInit?.signal).toBe(controller.signal);
    expect(records[0]?.runtime).toBe('bun');
    expect(records[0]?.runtimeVersion).toBe(process.versions.bun);
  });

  it('cancels a pending AI request with the SDK signal', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    const controller = new AbortController();
    const reason = new Error('user stopped the request');
    const records: Record<string, unknown>[] = [];
    try {
      const pending = fetchWithNetworkDiagnostics(fetch, server.url, {
        signal: controller.signal,
      }, r => { records.push(r); });
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(records.at(-1)?.phase).toBe('fetch_error');
      expect(records.at(-1)?.aborted).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  it('keeps the cause code, redacts credentials and bounds cyclic causes', () => {
    const cause = Object.assign(new Error('timeout https://user:secret@host/v1?token=secret Bearer secret'), { code: 'ETIMEDOUT' });
    const error = new Error('fetch failed', { cause });
    Object.assign(cause, { cause: error });
    const chain = networkErrorChain(error);
    expect(chain).toHaveLength(2);
    expect(chain[1]?.code).toBe('ETIMEDOUT');
    expect(JSON.stringify(chain)).not.toContain('secret');
    expect(sanitizeNetworkMessage('api_key=secret sk-private')).not.toContain('secret');
  });

  it('logs a failed wire request once and rethrows the identical error', async () => {
    const error = new Error('fetch failed', { cause: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) });
    let calls = 0;
    const records: Record<string, unknown>[] = [];
    const fetcher = (async () => { calls++; throw error; }) as unknown as typeof fetch;
    await expect(fetchWithNetworkDiagnostics(fetcher, 'https://user:secret@host/v1/chat/completions?key=secret', {}, r => { records.push(r); })).rejects.toBe(error);
    expect(calls).toBe(1);
    expect(records.map(r => r.phase)).toEqual(['start', 'fetch_error']);
    expect(JSON.stringify(records)).not.toContain('secret');
  });

  it('preserves streaming data and records completion without content', async () => {
    const records: Record<string, unknown>[] = [];
    const fetcher = (async () => new Response('private-body', { headers: { 'x-request-id': 'req-123' } })) as unknown as typeof fetch;
    const response = await fetchWithNetworkDiagnostics(fetcher, 'https://host/v1/chat/completions', {}, r => { records.push(r); });
    expect(await response.text()).toBe('private-body');
    expect(records.map(r => r.phase)).toEqual(['start', 'headers', 'first_chunk', 'complete']);
    expect(JSON.stringify(records)).not.toContain('private-body');
  });

  it('preserves stream errors and records their cause', async () => {
    const error = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
    const records: Record<string, unknown>[] = [];
    const fetcher = (async () => new Response(new ReadableStream({ pull(c) { c.error(error); } }))) as unknown as typeof fetch;
    const response = await fetchWithNetworkDiagnostics(fetcher, 'https://host/v1/chat/completions', {}, r => { records.push(r); });
    await expect(response.text()).rejects.toBe(error);
    expect(records.at(-1)?.phase).toBe('stream_error');
    expect(JSON.stringify(records)).toContain('ECONNRESET');
  });

  it('does not resend an adapted POST after a transport failure', async () => {
    process.env.CRAFT_INTERCEPTOR_DISABLE_AUTO_INSTALL = '1';
    const { interceptedFetch } = await import('../unified-network-interceptor.ts');
    const error = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
    let calls = 0;
    const fetcher = (async () => { calls++; throw error; }) as unknown as typeof fetch;
    await expect(interceptedFetch('https://host/v1/chat/completions', {
      method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'private' }] }),
    }, fetcher)).rejects.toBe(error);
    expect(calls).toBe(1);
  });
});
