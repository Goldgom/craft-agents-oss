import { describe, expect, it } from 'bun:test'
import { groupMessagesByTurn } from '@tokenbird/ui/chat/turn-utils'
import { handleError, handleTypedError, handleUserMessage } from '../session'
import { resolveBranchMessageId } from '../../../components/app-shell/branching'
import type { SessionState, UserMessageEvent } from '../../types'

function makeState(messages: any[]): SessionState {
  return {
    session: {
      id: 'session-1',
      messages,
      lastMessageAt: 0,
      isProcessing: true,
    } as any,
    streaming: null,
  }
}

function processingEvent(timestamp: number): UserMessageEvent {
  return {
    type: 'user_message',
    sessionId: 'session-1',
    message: {
      id: 'backend-follow-up',
      role: 'user',
      content: 'follow up',
      timestamp,
    },
    status: 'processing',
    optimisticMessageId: 'optimistic-follow-up',
  }
}

describe('handleUserMessage queued replay', () => {
  it('ignores provider errors that arrive after a completed turn', () => {
    const state = makeState([
      { id: 'user', role: 'user', content: 'question', timestamp: 1 },
      { id: 'answer', role: 'assistant', content: 'answer', timestamp: 2, isStreaming: false },
    ])
    state.session.isProcessing = false

    const plain = handleError(state, {
      type: 'error', sessionId: 'session-1', error: 'late provider failure', timestamp: 3,
    })
    expect(plain.state.session.messages).toHaveLength(2)
    expect(plain.state.session.messages.at(-1)?.role).toBe('assistant')

    const typed = handleTypedError(state, {
      type: 'typed_error', sessionId: 'session-1', timestamp: 3,
      error: { code: 'unknown_error', title: 'Unknown Error', message: 'late provider failure', actions: [], canRetry: false },
    })
    expect(typed.state.session.messages).toHaveLength(2)
    expect(typed.state.session.messages.at(-1)?.role).toBe('assistant')
  })

  it('uses the persisted message for an edited branch after a failed request', () => {
    const state = makeState([{
      id: 'optimistic-follow-up', role: 'user', content: 'follow up',
      timestamp: 200, isPending: true,
    }])
    const accepted = handleUserMessage(state, { ...processingEvent(300), status: 'accepted' })
    const failed = handleError(accepted.state, {
      type: 'error', sessionId: 'session-1', error: 'Upstream request failed',
    })
    expect(failed.state.session.isProcessing).toBe(false)
    expect(failed.state.session.messages[0]?.id).toBe('optimistic-follow-up')
    expect(resolveBranchMessageId(failed.state.session.messages, 'optimistic-follow-up')).toBe('backend-follow-up')
  })

  it('matches a later canonical event without optimistic ID or timestamp fallback', () => {
    const accepted = handleUserMessage(makeState([{
      id: 'optimistic-follow-up', role: 'user', content: 'follow up', timestamp: 200, isQueued: true,
    }]), { ...processingEvent(300), status: 'queued' })
    const replayed = handleUserMessage(accepted.state, {
      ...processingEvent(10_000), optimisticMessageId: undefined,
    })
    expect(replayed.state.session.messages).toHaveLength(1)
    expect(replayed.state.session.messages[0]?.timestamp).toBe(10_000)
    expect(resolveBranchMessageId(replayed.state.session.messages, 'optimistic-follow-up')).toBe('backend-follow-up')
  })

  it('applies the canonical replay timestamp without replacing the optimistic id', () => {
    const state = makeState([
      {
        id: 'optimistic-follow-up',
        role: 'user',
        content: 'follow up',
        timestamp: 200,
        isPending: false,
        isQueued: true,
      },
    ])

    const next = handleUserMessage(state, processingEvent(300))
    const message = next.state.session.messages[0]

    expect(message.id).toBe('optimistic-follow-up')
    expect(message.backendMessageId).toBe('backend-follow-up')
    expect(message.timestamp).toBe(300)
    expect(message.isPending).toBe(false)
    expect(message.isQueued).toBe(false)
  })

  it('keeps the completed prior answer above the replayed message in live grouping', () => {
    const state = makeState([
      { id: 'initial-user', role: 'user', content: 'question', timestamp: 100 },
      {
        id: 'optimistic-follow-up',
        role: 'user',
        content: 'follow up',
        timestamp: 200,
        isQueued: true,
      },
      {
        id: 'prior-answer',
        role: 'assistant',
        content: 'complete answer',
        timestamp: 250,
      },
    ])

    const next = handleUserMessage(state, processingEvent(300))
    const turns = groupMessagesByTurn(next.state.session.messages)

    expect(turns.map(turn => turn.type)).toEqual(['user', 'assistant', 'user'])
    const assistantTurn = turns[1]
    expect(assistantTurn?.type).toBe('assistant')
    if (assistantTurn?.type === 'assistant') {
      expect(assistantTurn.response?.text).toBe('complete answer')
    }
  })

  it('ignores a late queued event after the message is already processing', () => {
    const state = makeState([
      {
        id: 'optimistic-follow-up',
        role: 'user',
        content: 'follow up',
        timestamp: 300,
        isQueued: false,
      },
    ])
    const lateQueuedEvent: UserMessageEvent = {
      ...processingEvent(200),
      status: 'queued',
    }

    const next = handleUserMessage(state, lateQueuedEvent)

    expect(next.state).toBe(state)
    expect(next.state.session.messages[0]?.timestamp).toBe(300)
    expect(next.state.session.messages[0]?.isQueued).toBe(false)
  })
})
