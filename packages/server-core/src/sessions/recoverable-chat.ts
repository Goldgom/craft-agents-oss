import type { AgentEvent } from '@tokenbird/core/types'
import { createAgentError, parseError } from '@tokenbird/shared/agent'

const TRANSIENT_CODES = new Set(['network_error', 'proxy_error', 'service_error', 'service_unavailable'])
const CONTINUE_MESSAGE = '<system-reminder>The previous response was interrupted by a connection or configuration change. Continue the current task from the existing conversation and tool results. Do not repeat completed operations, tool calls, orders, payments, or other side effects. If an operation outcome is uncertain, verify its state before proceeding.</system-reminder>'

/** Keep a configuration handoff inside the same logical turn, after the old iterator closes. */
export async function* recoverableChat(options: {
  chat: (continuing: boolean) => AsyncIterable<AgentEvent>
  isCurrent: () => boolean
  refresh: () => Promise<void>
  onHandoffComplete?: (event: Extract<AgentEvent, { type: 'complete' }>) => Promise<void>
  wait?: (ms: number) => Promise<void>
}): AsyncGenerator<AgentEvent> {
  let continuing = false
  let failures = 0
  let activations = 0
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  while (options.isCurrent()) {
    let activated = false
    let completed = false
    let terminalError = false
    let partialText = ''
    let partialTurnId: string | undefined
    let failure: Extract<AgentEvent, { type: 'typed_error' }> | undefined
    try {
      for await (const event of options.chat(continuing)) {
        if (!options.isCurrent()) return
        if (event.type === 'source_activated') activated = true
        if (event.type === 'text_delta') {
          partialText += event.text
          partialTurnId = event.turnId
        } else if (event.type === 'text_complete' || event.type === 'text_discard') {
          partialText = ''
        }
        if (event.type === 'typed_error' || event.type === 'error') {
          const error = event.type === 'typed_error' ? event.error : parseError(new Error(event.message))
          if (error.canRetry && TRANSIENT_CODES.has(error.code) && failures < 2) {
            failure = { type: 'typed_error', error }
            continue
          }
          terminalError = true
        }
        // A backend may emit complete after an error/intentional source abort.
        if (event.type === 'complete') {
          completed = true
          if (failure || activated) {
            await options.onHandoffComplete?.(event)
            continue
          }
        }
        yield event
      }
    } catch (error) {
      if (!options.isCurrent()) return
      const parsed = parseError(error)
      if (!parsed.canRetry || !TRANSIENT_CODES.has(parsed.code) || failures >= 2) throw error
      failure = { type: 'typed_error', error: parsed }
    }
    if (!options.isCurrent()) return
    if (terminalError) return
    if (completed && !failure && !activated) return
    if (!failure && !activated) {
      failure = { type: 'typed_error', error: createAgentError('service_error') }
      if (failures >= 2) {
        yield failure
        yield { type: 'complete' }
        return
      }
    }
    if (activated && ++activations > 8) {
      yield { type: 'typed_error', error: createAgentError('service_error') }
      yield { type: 'complete' }
      return
    }
    // The iterator has fully unwound (including forceAbort/finally). Never race
    // a fixed timer against tool results, subprocess abort, or runtime refresh.
    if (partialText) yield { type: 'text_complete', text: partialText, turnId: partialTurnId, isIntermediate: true }
    yield { type: 'retry', phase: 'backoff', message: 'Reconnecting…' }
    if (failure) {
      const delay = Math.min(5000, Math.max(1000 * 2 ** failures, failure.error.retryDelayMs ?? 0))
      failures++
      for (let remaining = delay; remaining > 0 && options.isCurrent(); remaining -= 50) {
        await wait(Math.min(50, remaining))
      }
    }
    if (!options.isCurrent()) return
    await options.refresh()
    if (!options.isCurrent()) return
    yield { type: 'retry', phase: 'active' }
    continuing = true
  }
}

export { CONTINUE_MESSAGE }
