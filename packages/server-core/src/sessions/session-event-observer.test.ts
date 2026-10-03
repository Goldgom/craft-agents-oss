import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import type { SessionEvent } from '@craft-agent/shared/protocol'
import { SessionManager } from './SessionManager'

type EventHarness = {
  sessionEventListeners: Set<(event: SessionEvent, workspaceId: string) => void>
  pendingDeltas: Map<string, { delta: string; turnId?: string }>
  deltaFlushTimers: Map<string, ReturnType<typeof setTimeout>>
  setEventSink(sink: (...args: any[]) => void): void
  onSessionEvent(listener: (event: SessionEvent, workspaceId: string) => void): () => void
  sendEvent(event: SessionEvent, workspaceId?: string): void
  queueDelta(sessionId: string, workspaceId: string, delta: string, turnId?: string): void
}

function harness(): EventHarness {
  const manager = Object.create(SessionManager.prototype) as EventHarness
  manager.sessionEventListeners = new Set()
  manager.pendingDeltas = new Map()
  manager.deltaFlushTimers = new Map()
  return manager
}

beforeEach(() => { jest.useFakeTimers() })
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers() })

describe('in-process session event observation', () => {
  test('observes workspace events without an attached renderer transport and unsubscribes', () => {
    const manager = harness()
    const seen: Array<{ event: SessionEvent; workspaceId: string }> = []
    const unsubscribe = manager.onSessionEvent((event, workspaceId) => { seen.push({ event, workspaceId }) })
    const event: SessionEvent = { type: 'status', sessionId: 'node-session', message: 'Preparing' }
    manager.sendEvent(event, 'workspace-a')
    manager.sendEvent(event)
    unsubscribe()
    manager.sendEvent(event, 'workspace-a')
    expect(seen).toEqual([{ event, workspaceId: 'workspace-a' }])
  })

  test('keeps other observers and the original transport active when an observer throws', () => {
    const manager = harness()
    const observed: SessionEvent[] = []
    const delivered: unknown[][] = []
    manager.setEventSink((...args) => { delivered.push(args) })
    manager.onSessionEvent(() => { throw new Error('Listener fault') })
    manager.onSessionEvent(event => { observed.push(event) })
    const event: SessionEvent = { type: 'text_delta', sessionId: 'session', delta: 'live', turnId: 'actual-message-id' }
    manager.sendEvent(event, 'workspace')
    expect(observed).toEqual([event])
    expect(delivered).toHaveLength(1)
    expect(delivered[0]![1]).toEqual({ to: 'workspace', workspaceId: 'workspace' })
    expect(delivered[0]![2]).toBe(event)
  })

  test('flushes text before a new assistant identity instead of fusing intermediate and final text', () => {
    const manager = harness()
    const seen: SessionEvent[] = []
    manager.setEventSink(() => {})
    manager.onSessionEvent(event => { seen.push(event) })
    manager.queueDelta('session', 'workspace', 'Intermediate ', 'message-one')
    manager.queueDelta('session', 'workspace', 'summary', 'message-one')
    manager.queueDelta('session', 'workspace', 'Final answer', 'message-two')
    expect(seen).toEqual([{ type: 'text_delta', sessionId: 'session', delta: 'Intermediate summary', turnId: 'message-one' }])
    jest.advanceTimersByTime(100)
    expect(seen[1]).toEqual({ type: 'text_delta', sessionId: 'session', delta: 'Final answer', turnId: 'message-two' })
    expect(manager.pendingDeltas.size).toBe(0)
    expect(manager.deltaFlushTimers.size).toBe(0)
  })
})
