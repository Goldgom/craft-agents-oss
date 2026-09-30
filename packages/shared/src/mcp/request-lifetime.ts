/** Fixed, non-sensitive cancellation reason for an already failed request. */
export const MCP_REQUEST_FAILURE_REASON = 'MCP request ended with an error';

/**
 * Scope SDK cancellation to one request, even when the caller has no signal.
 *
 * The SDK retains abort listeners on supplied signals, and a rejected transport
 * send can leave a response handler behind. A private signal avoids retaining
 * the client through a caller-owned signal. Cancelling it only after rejection
 * lets the SDK clean up that request without closing concurrent sibling calls.
 */
export async function withMcpRequestLifetime<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) forwardAbort();
  else parentSignal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    return await operation(controller.signal);
  } catch (error) {
    // This may send a best-effort cancellation notification. It cannot undo
    // a remote mutation, and must never retry or replace the original error.
    try { controller.abort(MCP_REQUEST_FAILURE_REASON); } catch { /* Preserve the request outcome. */ }
    throw error;
  } finally {
    // Never abort after success, including a legitimate MCP isError result.
    try { parentSignal?.removeEventListener('abort', forwardAbort); } catch { /* Preserve the request outcome. */ }
  }
}
