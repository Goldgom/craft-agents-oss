/** Inspect the advertised tools at the wire without making a network request. */
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== 'https://browser-policy.invalid/v1/chat/completions') throw new Error('OFFLINE_FETCH_BLOCKED');
  const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '{}')));
  process.stdout.write(JSON.stringify({
    type: 'test_browser_tool_policy',
    tools: (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
  }) + '\n');
  throw new Error('OFFLINE_FETCH_BLOCKED_AFTER_TOOL_INSPECTION');
}, { preconnect() { throw new Error('OFFLINE_FETCH_BLOCKED'); } }) as typeof fetch;
