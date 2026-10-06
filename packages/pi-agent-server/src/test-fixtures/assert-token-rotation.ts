/** Offline wire check: never send the fake credential to an external service. */
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== 'https://tokennest.invalid/v1/chat/completions') throw new Error('OFFLINE_FETCH_BLOCKED');
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  process.stdout.write(JSON.stringify({
    type: 'test_wire_auth', fresh: headers.get('authorization') === 'Bearer dummy-replacement',
  }) + '\n');
  return new Response('data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"auth-test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}, { preconnect() { throw new Error('OFFLINE_FETCH_BLOCKED'); } }) as typeof fetch;
