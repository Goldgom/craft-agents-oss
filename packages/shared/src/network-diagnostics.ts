import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** No headers, request/response bodies, proxy credentials or raw stacks. */
export function sanitizeNetworkMessage(value: unknown): string {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-|eyJ)[\w.-]+/g, '[redacted]')
    .replace(/((?:token|password|authorization|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/[\r\n]/g, ' ').slice(0, 500);
}

export function networkErrorChain(error: unknown): Record<string, string>[] {
  const result: Record<string, string>[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current) && result.length < 5) {
    seen.add(current);
    const item = current as Record<string, unknown>;
    const fields: Record<string, string> = {};
    for (const key of ['name', 'code', 'message', 'errno', 'syscall']) {
      if (typeof item[key] === 'string' || typeof item[key] === 'number') {
        fields[key] = sanitizeNetworkMessage(item[key]);
      }
    }
    result.push(fields);
    current = item.cause;
  }
  return result;
}

export function writeNetworkDiagnostic(record: Record<string, unknown>): void {
  try {
    const dir = process.env.CRAFT_SESSION_DIR || join(
      process.env.TOKENBIRD_CONFIG_DIR || join(homedir(), '.tokenbird'), 'logs',
    );
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'network-diagnostics.jsonl');
    try {
      if (statSync(file).size >= 2 * 1024 * 1024) renameSync(file, file + '.prev');
    } catch { /* Missing file or failed rotation must not affect requests. */ }
    appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n');
  } catch { /* Diagnostics must never break a request. */ }
}

/** Observe one actual wire request; never retry or replace its original error. */
export async function fetchWithNetworkDiagnostics(
  fetcher: typeof fetch,
  input: string | URL | Request,
  init?: RequestInit,
  write = writeNetworkDiagnostic,
): Promise<Response> {
  const id = randomUUID();
  const started = Date.now();
  let endpoint = '[invalid-url]';
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    endpoint = url.origin + url.pathname;
  } catch { /* Never log malformed raw input. */ }
  const base = {
    id, endpoint, method: init?.method || (input instanceof Request ? input.method : 'GET'),
    runtime: process.release.name, runtimeVersion: process.version,
    proxyConfigured: Boolean((init as RequestInit & { proxy?: string } | undefined)?.proxy),
  };
  const emit = (fields: Record<string, unknown>) => {
    try { write({ ...base, elapsedMs: Date.now() - started, ...fields }); } catch { /* best effort */ }
  };
  emit({ phase: 'start', aborted: init?.signal?.aborted ?? false });
  let response: Response;
  try {
    response = await fetcher(input, init);
  } catch (error) {
    emit({ phase: 'fetch_error', aborted: init?.signal?.aborted ?? false, errors: networkErrorChain(error) });
    throw error;
  }
  emit({ phase: 'headers', status: response.status,
    requestId: sanitizeNetworkMessage(response.headers.get('x-request-id') || response.headers.get('request-id')) });
  if (!response.body) return response;
  let chunks = 0;
  let lastChunkAt: number | undefined;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          emit({ phase: 'complete', chunks });
          controller.close();
          reader.releaseLock();
        } else {
          chunks++;
          lastChunkAt = Date.now();
          if (chunks === 1) emit({ phase: 'first_chunk' });
          controller.enqueue(next.value);
        }
      } catch (error) {
        emit({ phase: 'stream_error', chunks,
          idleMs: Date.now() - (lastChunkAt ?? started), errors: networkErrorChain(error) });
        controller.error(error);
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      emit({ phase: 'cancelled', chunks });
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}