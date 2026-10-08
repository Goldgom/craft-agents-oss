export const EMPTY_RESPONSE_ERROR_CODE = 'empty_response'

type CompletionMessage = {
  id: string
  role: string
  content: string
  statusType?: string
  errorCode?: string
  errorCanRetry?: boolean
}

/** A persistent session's previous answer must never settle a later turn. */
export function resolveSessionTurnCompletion(
  messages: readonly CompletionMessage[],
  reason: 'complete' | 'interrupted' | 'error' | 'timeout',
  startFinalMessageId: string | undefined,
  currentFinalMessageId: string | undefined,
): { reason: typeof reason; finalMessageId?: string; finalText?: string; errorCode?: string; canRetry?: boolean } {
  const finalIndex = currentFinalMessageId && currentFinalMessageId !== startFinalMessageId
    ? messages.findIndex(message => message.id === currentFinalMessageId && message.role === 'assistant' && message.content.trim().length > 0) : -1
  const userIndex = messages.findLastIndex(message => message.role === 'user')
  const startIndex = startFinalMessageId ? messages.findIndex(message => message.id === startFinalMessageId) : -1
  const errorIndex = messages.findLastIndex(message => message.role === 'error')
  const terminalError = errorIndex > Math.max(userIndex, startIndex, finalIndex) ? messages[errorIndex] : undefined
  const final = finalIndex > userIndex ? messages[finalIndex] : undefined
  if (terminalError) {
    return { reason: reason === 'complete' ? 'error' : reason, finalText: terminalError.content,
      ...(terminalError.errorCode ? { errorCode: terminalError.errorCode } : {}),
      ...(terminalError.errorCanRetry != null ? { canRetry: terminalError.errorCanRetry } : {}) }
  }
  if (reason === 'complete' && !final) {
    // Native /compact produces a completion notice instead of an assistant answer.
    const user = messages[userIndex]
    const compacted = user?.content.trim().match(/^\/compact(?:\s|$)/i)
      && messages.slice(userIndex + 1).findLast(message => message.role === 'info' && message.statusType === 'compaction_complete')
    if (compacted) return { reason: 'complete', finalText: compacted.content }
    return { reason: 'error', finalText: 'Turn completed without a new final assistant response.', errorCode: EMPTY_RESPONSE_ERROR_CODE, canRetry: true }
  }
  return { reason, finalMessageId: final?.id, finalText: final?.content }
}
