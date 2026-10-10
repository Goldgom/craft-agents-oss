import { describe, expect, it } from 'bun:test'
import { handleTextComplete, handleTextDelta } from '../text'
import { handleInterrupted } from '../session'
import type { SessionState, TextCompleteEvent } from '../../types'

function makeState(messages: any[]): SessionState {
  return {
    session: {
      id: 'session-1',
      messages,
      lastMessageAt: Date.now(),
    } as any,
    streaming: null,
  }
}

describe('handleTextComplete messageId synchronization', () => {
  for (const turnId of ['stopped-turn', undefined]) {
    it(`keeps the authoritative partial reply ID after interruption (${turnId ?? 'no turn ID'})`, () => {
      const streaming = handleTextDelta(makeState([]), {
        type: 'text_delta', sessionId: 'session-1', delta: 'partial reply', turnId,
      })
      const temporaryId = streaming.session.messages[0]!.id
      const finalized = handleTextComplete(streaming, {
        type: 'text_complete', sessionId: 'session-1', text: 'partial reply',
        messageId: 'persisted-partial', turnId, timestamp: 200,
      })
      const stopped = handleInterrupted(finalized, {
        type: 'interrupted', sessionId: 'session-1',
        message: { id: 'stop-marker', role: 'info', content: 'Response interrupted', timestamp: 201 },
      }).state
      expect(stopped.session.messages).toHaveLength(2)
      expect(stopped.session.messages[0]).toMatchObject({
        id: 'persisted-partial', content: 'partial reply', isStreaming: false, isPending: false,
      })
      expect(stopped.session.messages[0]!.id).not.toBe(temporaryId)
      expect(stopped.streaming).toBeNull()
    })
  }

  it('overwrites existing streaming message id with authoritative messageId', () => {
    const state = makeState([
      {
        id: 'msg-local-temp-1',
        role: 'assistant',
        content: 'partial',
        isStreaming: true,
        isPending: true,
        turnId: 'turn-1',
        timestamp: 100,
      },
    ])

    const event: TextCompleteEvent = {
      type: 'text_complete',
      sessionId: 'session-1',
      text: 'final response',
      turnId: 'turn-1',
      messageId: 'msg-main-1',
      timestamp: 200,
    }

    const next = handleTextComplete(state, event)
    const msg = next.session.messages[0] as any

    expect(msg.id).toBe('msg-main-1')
    expect(msg.content).toBe('final response')
    expect(msg.isStreaming).toBe(false)
    expect(msg.isPending).toBe(false)
    expect(msg.timestamp).toBe(200)
  })

  it('uses authoritative messageId when creating message in race path', () => {
    const state = makeState([])

    const event: TextCompleteEvent = {
      type: 'text_complete',
      sessionId: 'session-1',
      text: 'created from complete',
      turnId: 'turn-race',
      messageId: 'msg-main-race',
      timestamp: 300,
    }

    const next = handleTextComplete(state, event)
    expect(next.session.messages).toHaveLength(1)
    expect((next.session.messages[0] as any).id).toBe('msg-main-race')
  })

  it('keeps backward compatibility when messageId is missing', () => {
    const state = makeState([])

    const event: TextCompleteEvent = {
      type: 'text_complete',
      sessionId: 'session-1',
      text: 'legacy payload',
      turnId: 'turn-legacy',
      timestamp: 400,
    }

    const next = handleTextComplete(state, event)
    const id = (next.session.messages[0] as any).id as string

    expect(id.startsWith('msg-')).toBe(true)
    expect(id).not.toBe('')
  })
})
