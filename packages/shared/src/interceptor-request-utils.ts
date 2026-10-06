/**
 * Resolve method/body/headers from fetch(input, init), including Request inputs.
 */
export async function resolveRequestContext(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<{ bodyStr?: string; normalizedInit: RequestInit }> {
  const normalizedInit: RequestInit = input instanceof Request
    ? {
        ...init,
        method: init?.method ?? input.method,
        headers: init?.headers ?? input.headers,
        signal: init?.signal ?? input.signal,
      }
    : init ?? {};
  // Prefer explicit init body (already detached from Request stream)
  if (typeof init?.body === 'string') {
    return { bodyStr: init.body, normalizedInit };
  }

  // Fallback: parse Request body when caller used fetch(new Request(...))
  if (input instanceof Request) {
    try {
      const bodyStr = await input.clone().text();
      return { bodyStr, normalizedInit: { ...normalizedInit, body: init?.body ?? bodyStr } };
    } catch {
      // Ignore body read errors — interception will be skipped
    }
  }

  return { bodyStr: undefined, normalizedInit };
}
