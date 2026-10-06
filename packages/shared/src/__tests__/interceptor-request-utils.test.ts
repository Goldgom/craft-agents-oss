import { describe, expect, it } from 'bun:test';
import { resolveRequestContext } from '../interceptor-request-utils.ts';

describe('interceptor-request-utils', () => {
  it('preserves Request cancellation when rebuilding an adapted POST', async () => {
    const controller = new AbortController();
    const req = new Request('https://example.com/chat/completions', {
      method: 'POST', body: '{}', signal: controller.signal,
    });
    const result = await resolveRequestContext(req);
    controller.abort();
    expect(result.normalizedInit.signal?.aborted).toBe(true);
  });

  it('preserves init options and gives an explicit signal precedence', async () => {
    const requestController = new AbortController();
    const overrideController = new AbortController();
    const req = new Request('https://example.com/chat/completions', {
      method: 'POST', body: '{}', signal: requestController.signal,
    });
    const result = await resolveRequestContext(req, {
      signal: overrideController.signal, cache: 'no-store',
    });
    requestController.abort();
    expect(result.normalizedInit.signal).toBe(overrideController.signal);
    expect(result.normalizedInit.signal?.aborted).toBe(false);
    expect(result.normalizedInit.cache).toBe('no-store');
  });

  it('preserves the Request signal and headers when init overrides its body', async () => {
    const req = new Request('https://example.com/chat/completions', {
      method: 'POST', headers: { 'x-request-id': 'req-test' }, body: '{}',
    });
    const result = await resolveRequestContext(req, { body: '{"new":true}' });
    expect(result.normalizedInit.signal).toBe(req.signal);
    expect(new Headers(result.normalizedInit.headers).get('x-request-id')).toBe('req-test');
    expect(result.normalizedInit.method).toBe('POST');
  });

  it('extracts JSON body from Request input when init.body is absent', async () => {
    const req = new Request('https://example.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    });

    const result = await resolveRequestContext(req, undefined);
    expect(result.bodyStr).toBe(JSON.stringify({ foo: 'bar' }));
    expect(result.normalizedInit.method).toBe('POST');
  });

  it('prefers init.body when provided', async () => {
    const req = new Request('https://example.com/messages', {
      method: 'POST',
      body: JSON.stringify({ old: true }),
    });

    const result = await resolveRequestContext(req, {
      method: 'POST',
      body: JSON.stringify({ new: true }),
    });

    expect(result.bodyStr).toBe(JSON.stringify({ new: true }));
  });
});
