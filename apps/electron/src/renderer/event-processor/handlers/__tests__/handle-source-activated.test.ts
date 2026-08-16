import { describe, expect, it } from 'bun:test'
import { handleSourceActivated } from '../session'
import type { SessionState, SourceActivatedEvent } from '../../types'

function makeState(messages: any[]): SessionState {
  return {
    session: {
      id: 'session-1',
      messages,
      lastMessageAt: Date.now(),
      isProcessing: true,
    } as any,
    streaming: null,
  }
}

/**
 * Source-activation feedback must render as a small centered info notice
 * (role: 'info'), NOT as a duplicate user bubble. The server re-sends the
 * original message with `hidden: true`, so this notice is the only visible
 * transcript footprint of an activation.
 */
describe('handleSourceActivated', () => {
  it('appends a centered info notice with the activation slug', () => {
    const state = makeState([
      { id: 'msg-1', role: 'user', content: 'list my repos' },
    ])

    const event: SourceActivatedEvent = {
      type: 'source_activated',
      sessionId: 'session-1',
      sourceSlug: 'world-intel-mcp',
      originalMessage: 'list my repos',
    }

    const next = handleSourceActivated(state, event)

    const appended = next.state.session.messages[next.state.session.messages.length - 1]
    expect(appended.role).toBe('info')
    expect(appended.content).toBe('[world-intel-mcp activated]')
    expect(appended.infoLevel).toBe('success')
    // No user-role duplicate is added by this handler
    const userCount = next.state.session.messages.filter((m: { role?: string }) => m.role === 'user').length
    expect(userCount).toBe(1)
    // No side effects
    expect(next.effects).toEqual([])
    // streaming state untouched
    expect(next.state.streaming).toBeNull()
  })
})
