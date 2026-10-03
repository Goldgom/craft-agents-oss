import type { Session, TransportConnectionState } from '../../shared/types'

interface MessageLoadMeta {
  messageCount?: number
  lastFinalMessageId?: string
}

export interface SessionMessagesLoadStateInput {
  session: Pick<Session, 'messages' | 'messageCount' | 'lastFinalMessageId'> | null | undefined
  sessionMeta: MessageLoadMeta | null | undefined
  messagesLoaded: boolean
  loadError?: string | null
}

export interface SessionMessagesLoadState {
  hasLoadedFlag: boolean
  hasInMemoryMessages: boolean
  isKnownEmptySession: boolean
  hasExpectedPersistedMessages: boolean
  hasStaleLoadedFlag: boolean
  messagesReady: boolean
  messagesLoading: boolean
  error: string | null
}

/**
 * Derive the renderer's message-load UI state from both the explicit loaded flag
 * and the actual per-session atom payload.
 *
 * The loaded flag is intentionally separate from session data for lazy loading,
 * but recovery/reconnect paths can temporarily get them out of sync. If the
 * session atom already contains messages, the transcript should render instead
 * of staying hidden behind a stale loading spinner.
 */
export function deriveSessionMessagesLoadState({
  session,
  sessionMeta,
  messagesLoaded,
  loadError,
}: SessionMessagesLoadStateInput): SessionMessagesLoadState {
  const hasLoadedFlag = messagesLoaded
  const messageCount = session?.messageCount ?? sessionMeta?.messageCount
  const hasInMemoryMessages = (session?.messages?.length ?? 0) > 0
  const hasExpectedPersistedMessages = (messageCount ?? 0) > 0
    || !!session?.lastFinalMessageId
    || !!sessionMeta?.lastFinalMessageId
  const isKnownEmptySession = !!session
    && messageCount === 0
    && !session?.lastFinalMessageId
    && !sessionMeta?.lastFinalMessageId
  const hasStaleLoadedFlag = hasLoadedFlag && hasExpectedPersistedMessages && !hasInMemoryMessages
  const messagesReady = (hasLoadedFlag && !hasStaleLoadedFlag) || hasInMemoryMessages || isKnownEmptySession
  const error = messagesReady ? null : (loadError ?? null)

  return {
    hasLoadedFlag,
    hasInMemoryMessages,
    isKnownEmptySession,
    hasExpectedPersistedMessages,
    hasStaleLoadedFlag,
    messagesReady,
    messagesLoading: !messagesReady && !error,
    error,
  }
}

export function shouldTreatSessionLoadFailureAsTransportFallback(
  state: TransportConnectionState | null | undefined,
): boolean {
  if (!state || state.mode !== 'remote') return false

  if (state.lastError && ['auth', 'network', 'timeout'].includes(state.lastError.kind)) {
    return true
  }

  return state.status === 'connecting'
    || state.status === 'reconnecting'
    || state.status === 'failed'
    || state.status === 'disconnected'
}

export function formatSessionLoadFailure(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return 'Unknown error'
}

/** Ignore replies from superseded requests or a previous workspace. */
export function createSessionListRequestGuard() {
  let revision = 0
  return {
    begin: () => {
      const requestRevision = ++revision
      return () => requestRevision === revision
    },
    invalidate: () => { revision++ },
  }
}

/** A generation change cancels a read, not the underlying session data. */
export async function retryExpiredSessionListRequest<T>(
  request: () => Promise<T>,
  isCurrent: () => boolean,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request()
    } catch (error) {
      if (!isCurrent() || attempt >= 2
        || formatSessionLoadFailure(error) !== 'Remote client generation expired') {
        throw error
      }
    }
  }
}
