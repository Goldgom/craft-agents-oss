import { parseError } from '@craft-agent/shared/agent'
import type { SessionCompletionEvent } from '../sessions/SessionManager'

const TRANSIENT_CODES = new Set(['network_error', 'proxy_error', 'rate_limited', 'service_error', 'service_unavailable', 'provider_error'])
const TRANSPORT_CODES = /\b(?:ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE|ERR_STREAM_PREMATURE_CLOSE)\b/i
const REQUEST_TIMEOUT = /\b(?:request|connect|connection|socket|fetch)\b.{0,40}\b(?:timed?\s*out|timeout)\b/i

export function canRecoverSuperAgentTurn(event: Pick<SessionCompletionEvent, 'reason' | 'errorCode' | 'canRetry' | 'finalText'>): boolean {
  if (!['error', 'timeout'].includes(event.reason) || event.canRetry === false) return false
  if (event.errorCode) return TRANSIENT_CODES.has(event.errorCode)
  const raw = event.finalText ?? ''
  const code = parseError(new Error(raw)).code
  return TRANSIENT_CODES.has(code) || (code === 'unknown_error' && (TRANSPORT_CODES.test(raw) || REQUEST_TIMEOUT.test(raw)))
}

/** Keep trying while authorized; cap the interval to avoid flooding a down service. */
export function superAgentRetryDelay(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.min(5, Math.max(0, attempt - 1)))
}
