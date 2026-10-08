import { describe, expect, it } from 'bun:test'
import type { Session, TransportConnectionState } from '../../../shared/types'
import { createSessionListRequestGuard, deriveSessionMessagesLoadState, formatSessionLoadFailure, retrySessionListRequest, shouldTreatSessionLoadFailureAsTransportFallback } from '../session-load'

function createState(overrides?: Partial<TransportConnectionState>): TransportConnectionState {
  return {
    mode: 'remote',
    status: 'connected',
    url: 'wss://remote.example.test',
    attempt: 0,
    updatedAt: Date.now(),
    ...overrides,
  }
}

function createSession(overrides?: Partial<Session>): Session {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    lastMessageAt: Date.now(),
    messages: [],
    isProcessing: false,
    ...overrides,
  }
}

describe('deriveSessionMessagesLoadState', () => {
  it('loads metadata-only sessions that are not marked loaded', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messages: [], messageCount: 2 }),
      sessionMeta: { messageCount: 2 },
      messagesLoaded: false,
    })

    expect(state.messagesReady).toBe(false)
    expect(state.messagesLoading).toBe(true)
  })

  it('treats in-memory messages as ready even when the loaded flag is stale', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({
        messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: Date.now() }],
        messageCount: 1,
      }),
      sessionMeta: { messageCount: 1 },
      messagesLoaded: false,
    })

    expect(state.hasInMemoryMessages).toBe(true)
    expect(state.messagesReady).toBe(true)
    expect(state.messagesLoading).toBe(false)
  })

  it('treats loaded empty sessions as ready', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messages: [], messageCount: 0 }),
      sessionMeta: { messageCount: 0 },
      messagesLoaded: true,
    })

    expect(state.messagesReady).toBe(true)
    expect(state.messagesLoading).toBe(false)
  })

  it('treats an empty loaded atom with expected messages as stale', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messages: [], messageCount: 2 }),
      sessionMeta: { messageCount: 2 },
      messagesLoaded: true,
    })

    expect(state.hasStaleLoadedFlag).toBe(true)
    expect(state.messagesReady).toBe(false)
    expect(state.messagesLoading).toBe(true)
  })

  it('surfaces load errors instead of continuing to load forever', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({ messages: [], messageCount: 2 }),
      sessionMeta: { messageCount: 2 },
      messagesLoaded: false,
      loadError: 'boom',
    })

    expect(state.messagesReady).toBe(false)
    expect(state.messagesLoading).toBe(false)
    expect(state.error).toBe('boom')
  })

  it('clears stale load errors once messages are ready', () => {
    const state = deriveSessionMessagesLoadState({
      session: createSession({
        messages: [{ id: 'm1', role: 'assistant', content: 'ready', timestamp: Date.now() }],
        messageCount: 1,
      }),
      sessionMeta: { messageCount: 1 },
      messagesLoaded: false,
      loadError: 'old failure',
    })

    expect(state.messagesReady).toBe(true)
    expect(state.error).toBe(null)
  })
})

describe('shouldTreatSessionLoadFailureAsTransportFallback', () => {
  it('returns true for remote reconnecting state', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({ status: 'reconnecting' }),
    )).toBe(true)
  })

  it('returns true for remote auth/network/timeout failures', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({
        status: 'connected',
        lastError: { kind: 'auth', message: 'Bad token' },
      }),
    )).toBe(true)
  })

  it('returns false for remote connected state without transport errors', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({ status: 'connected' }),
    )).toBe(false)
  })

  it('returns false for local transport state', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({ mode: 'local', status: 'failed' }),
    )).toBe(false)
  })
})

describe('formatSessionLoadFailure', () => {
  it('prefers Error.message', () => {
    expect(formatSessionLoadFailure(new Error('boom'))).toBe('boom')
  })

  it('falls back to a generic message', () => {
    expect(formatSessionLoadFailure(null)).toBe('Unknown error')
  })
})

describe('session list request recovery', () => {
  it('recovers a first remote timeout while the connection stays healthy', async () => {
    let calls = 0
    const sessions = ['remote-session']
    const result = await retrySessionListRequest(async () => {
      if (++calls === 1) throw Object.assign(new Error('Remote request timed out'), { code: 'TIMEOUT' })
      return sessions
    }, () => true, async () => createState())
    expect(result).toBe(sessions)
    expect(calls).toBe(2)
  })

  it('bounds retries when a connected remote keeps timing out', async () => {
    let calls = 0
    await expect(retrySessionListRequest(async () => {
      calls++
      throw Object.assign(new Error('Timed out'), { code: 'TIMEOUT' })
    }, () => true, async () => createState())).rejects.toThrow('Timed out')
    expect(calls).toBe(3)
  })

  it('leaves local, disconnected, auth, protocol and data failures visible', async () => {
    for (const [code, state] of [
      ['TIMEOUT', createState({ mode: 'local' })],
      ['NETWORK', createState({ status: 'reconnecting' })],
      ['AUTH', createState()],
      ['PROTOCOL', createState()],
      ['FAILED', createState()],
    ] as const) {
      let calls = 0
      await expect(retrySessionListRequest(async () => {
        calls++
        throw Object.assign(new Error(code), { code })
      }, () => true, async () => state)).rejects.toThrow(code)
      expect(calls).toBe(1)
    }
  })

  it('cancels a retry if the workspace changes during the retry delay', async () => {
    const guard = createSessionListRequestGuard()
    const isCurrent = guard.begin()
    let calls = 0
    await expect(retrySessionListRequest(async () => {
      calls++
      throw Object.assign(new Error('Old workspace timed out'), { code: 'TIMEOUT' })
    }, isCurrent, async () => {
      setTimeout(() => guard.invalidate(), 10)
      return createState()
    })).rejects.toThrow('Old workspace timed out')
    expect(calls).toBe(1)
  })

  it('rejects old request ownership when a newer refresh starts', () => {
    const guard = createSessionListRequestGuard()
    const oldRequest = guard.begin()
    const newRequest = guard.begin()
    expect(oldRequest()).toBe(false)
    expect(newRequest()).toBe(true)
    guard.invalidate()
    expect(newRequest()).toBe(false)
  })

  it('retries an expired read on the current client', async () => {
    let calls = 0
    const sessions = ['session-1']
    const result = await retrySessionListRequest(async () => {
      if (++calls === 1) throw new Error('Remote client generation expired')
      return sessions
    }, () => true)
    expect(result).toBe(sessions)
    expect(calls).toBe(2)
  })

  it('does not retry a superseded read', async () => {
    let calls = 0
    await expect(retrySessionListRequest(async () => {
      calls++
      throw new Error('Remote client generation expired')
    }, () => false)).rejects.toThrow('Remote client generation expired')
    expect(calls).toBe(1)
  })

  it('does not hide real server or data errors', async () => {
    let calls = 0
    await expect(retrySessionListRequest(async () => {
      calls++
      throw new Error('Invalid session data')
    }, () => true)).rejects.toThrow('Invalid session data')
    expect(calls).toBe(1)
  })

  it('bounds retries if the current client keeps expiring', async () => {
    let calls = 0
    await expect(retrySessionListRequest(async () => {
      calls++
      throw new Error('Remote client generation expired')
    }, () => true)).rejects.toThrow('Remote client generation expired')
    expect(calls).toBe(3)
  })

  it('prevents a late rejection from overwriting a successful refresh', async () => {
    const guard = createSessionListRequestGuard()
    const oldRequest = guard.begin()
    let rejectOld!: (error: Error) => void
    let error: string | null = null
    const oldRead = new Promise<void>((_, reject) => { rejectOld = reject })
      .catch(failure => {
        if (oldRequest()) error = formatSessionLoadFailure(failure)
      })
    const refresh = guard.begin()
    expect(refresh()).toBe(true)
    error = null
    rejectOld(new Error('Remote client generation expired'))
    await oldRead
    expect(error).toBe(null)
  })
})
