import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import type { AgentEvent } from '@craft-agent/core/types'
import type { SessionEvent } from '@craft-agent/shared/protocol'
import { SessionManager, createManagedSession } from './SessionManager.ts'

type ManagedSession = ReturnType<typeof createManagedSession>
type EventHarness = {
  processEvent(managed: ManagedSession, event: AgentEvent): Promise<void>
  pendingDeltas: Map<string, { delta: string; turnId?: string }>
  deltaFlushTimers: Map<string, ReturnType<typeof setTimeout>>
  sendEvent(event: SessionEvent, workspaceId?: string): void
  persistSession(managed: ManagedSession): void
  monotonic(): number
}

/** Exercise the real batching/event methods without agents, disk writes or watchers. */
function harness() {
  const manager = Object.create(SessionManager.prototype) as EventHarness
  const events: SessionEvent[] = []
  manager.pendingDeltas = new Map()
  manager.deltaFlushTimers = new Map()
  manager.sendEvent = event => { events.push(event) }
  manager.persistSession = () => {}
  manager.monotonic = () => Date.now()
  const managed = createManagedSession({ id: 'retry-test' }, {
    id: 'workspace', slug: 'workspace', name: 'Test', rootPath: '/unused-retry-test', createdAt: Date.now(),
  })
  return { manager, managed, events, fire: (event: AgentEvent) => manager.processEvent(managed, event) }
}

describe('Pi retry streaming boundaries', () => {
  beforeEach(() => { jest.useFakeTimers() })
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers() })

  it('discards pending failed deltas before backoff and never sends them later', async () => {
    const { manager, managed, events, fire } = harness()
    await fire({ type: 'text_delta', text: 'Failed partial', turnId: 'attempt-0' })
    expect(events).toHaveLength(0)
    expect(managed.streamingText).toBe('Failed partial')
    await fire({ type: 'text_discard', turnId: 'attempt-0' })
    await fire({ type: 'retry', phase: 'backoff', message: 'Retrying in 2s...' })
    jest.advanceTimersByTime(100)

    expect(events).toEqual([
      { type: 'text_discard', sessionId: managed.id, turnId: 'attempt-0' },
      { type: 'retry', sessionId: managed.id, phase: 'backoff', message: 'Retrying in 2s...' },
    ])
    expect(managed.streamingText).toBe('')
    expect(managed.streamingTurnId).toBeUndefined()
    expect(manager.pendingDeltas.size).toBe(0)
    expect(manager.deltaFlushTimers.size).toBe(0)
    expect(managed.messages).toHaveLength(0)
  })

  it('discards already-flushed partials and persists only the recovered answer', async () => {
    const { managed, events, fire } = harness()
    const completed = { id: 'completed', role: 'assistant' as const, content: 'Earlier commentary', timestamp: 1, isIntermediate: true, turnId: 'earlier' }
    managed.messages.push(completed)
    await fire({ type: 'text_delta', text: 'Discard me', turnId: 'attempt-0' })
    jest.advanceTimersByTime(100)
    expect(events[0]).toMatchObject({ type: 'text_delta', delta: 'Discard me' })
    await fire({ type: 'text_discard', turnId: 'attempt-0' })
    expect(managed.streamingText).toBe('')
    await fire({ type: 'retry', phase: 'backoff', message: 'Retrying...' })
    await fire({ type: 'retry', phase: 'active' })
    await fire({ type: 'text_delta', text: 'Recovered', turnId: 'attempt-1' })
    await fire({ type: 'text_complete', text: 'Recovered', turnId: 'attempt-1' })
    await fire({ type: 'retry', phase: 'end' })

    expect(managed.messages).toHaveLength(2)
    expect(managed.messages[0]).toBe(completed)
    expect(managed.messages[1]).toMatchObject({ role: 'assistant', content: 'Recovered', turnId: 'attempt-1' })
    expect(managed.streamingText).toBe('')
    expect(managed.streamingTurnId).toBeUndefined()
    expect(events.filter(e => e.type === 'text_complete')).toHaveLength(1)
  })

  it('a discard for another identity cannot wipe a newer stream or its batch', async () => {
    const { managed, events, fire } = harness()
    await fire({ type: 'text_delta', text: 'Keep me', turnId: 'newer-attempt' })
    await fire({ type: 'text_discard', turnId: 'older-attempt' })
    expect(managed.streamingText).toBe('Keep me')
    expect(managed.streamingTurnId).toBe('newer-attempt')
    jest.advanceTimersByTime(100)
    expect(events).toContainEqual({ type: 'text_delta', sessionId: managed.id, delta: 'Keep me', turnId: 'newer-attempt' })
  })

  it('repeated failed attempts leave no fused text or unfinished delta timer', async () => {
    const { manager, managed, events, fire } = harness()
    for (let attempt = 0; attempt < 3; attempt++) {
      await fire({ type: 'text_delta', text: `Partial ${attempt}`, turnId: `attempt-${attempt}` })
      if (attempt === 1) jest.advanceTimersByTime(100)
      await fire({ type: 'text_discard', turnId: `attempt-${attempt}` })
      if (attempt < 2) {
        await fire({ type: 'retry', phase: 'backoff', message: 'Retrying...' })
        await fire({ type: 'retry', phase: 'active' })
      }
    }
    await fire({ type: 'retry', phase: 'end' })
    jest.advanceTimersByTime(100)
    expect(managed.streamingText).toBe('')
    expect(managed.messages).toHaveLength(0)
    expect(manager.pendingDeltas.size).toBe(0)
    expect(manager.deltaFlushTimers.size).toBe(0)
    expect(events.filter(e => e.type === 'text_discard')).toHaveLength(3)
    expect(events.filter(e => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', sessionId: managed.id, delta: 'Partial 1', turnId: 'attempt-1' },
    ])
  })
})
