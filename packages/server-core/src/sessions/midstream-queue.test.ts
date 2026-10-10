import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionManager,
  createManagedSession,
  resolveMidStreamDeliveryOutcome,
} from './SessionManager.ts'

describe('mid-stream queue runtime invariants', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-midstream-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'mid-stream test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  it('distinguishes non-interrupting queue mode from a failed steer', () => {
    expect(resolveMidStreamDeliveryOutcome('queue', false)).toEqual({
      shouldQueue: true,
      wasInterrupted: false,
    })
    expect(resolveMidStreamDeliveryOutcome('steer', false)).toEqual({
      shouldQueue: true,
      wasInterrupted: true,
    })
    expect(resolveMidStreamDeliveryOutcome('steer', true)).toEqual({
      shouldQueue: false,
      wasInterrupted: false,
    })
  })

  it('stops once and keeps the stopped and queued text on the interruption marker', async () => {
    const managed = buildSession('stop-with-queue')
    managed.isProcessing = true
    managed.messages = [
      { id: 'active-user', role: 'user', content: 'original prompt', timestamp: 1 },
      { id: 'queued-user', role: 'user', content: 'follow up', timestamp: 2, isQueued: true },
    ]
    managed.messageQueue.push({ message: 'follow up', messageId: 'queued-user' })
    const forceAbort = mock(() => {})
    managed.agent = { forceAbort } as unknown as typeof managed.agent
    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))

    try {
      await sm.cancelProcessing(managed.id)
      await sm.cancelProcessing(managed.id)

      expect(forceAbort).toHaveBeenCalledTimes(1)
      expect(managed.stopRequested).toBe(true)
      expect(managed.messageQueue).toEqual([])
      expect(managed.messages.some(message => message.id === 'queued-user')).toBe(false)
      expect(events.filter(event => event.type === 'interrupted')).toHaveLength(1)
      expect(events.find(event => event.type === 'interrupted')?.message?.interruptedInput)
        .toBe('original prompt\n\nfollow up')
    } finally {
      if (managed.stopCleanupTimer) clearTimeout(managed.stopCleanupTimer)
    }
  })

  it('re-stamps replay after the prior final response and emits that timestamp', async () => {
    const sessionId = 'queue-ordering'
    const managed = buildSession(sessionId)
    const priorFinalTimestamp = Date.now()
    managed.messages = [
      {
        id: 'initial-user',
        role: 'user',
        content: 'question',
        timestamp: priorFinalTimestamp - 200,
      },
      {
        id: 'queued-user',
        role: 'user',
        content: 'follow up',
        timestamp: priorFinalTimestamp - 100,
        isQueued: true,
      },
      {
        id: 'prior-answer',
        role: 'assistant',
        content: 'complete answer',
        timestamp: priorFinalTimestamp,
      },
    ]
    managed.messageQueue.push({
      message: 'follow up',
      messageId: 'queued-user',
      optimisticMessageId: 'optimistic-user',
      rpcContext: { callerClientId: 'remote-client', remoteAccess: true },
    })

    const events: any[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    ;(sm as unknown as { lastTimestamp: number }).lastTimestamp = priorFinalTimestamp
    ;(sm as unknown as { persistSession: () => void }).persistSession = () => {}
    const sendMessage = mock(async () => {})
    ;(sm as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage

    ;(sm as unknown as { processNextQueuedMessage: (id: string) => void })
      .processNextQueuedMessage(sessionId)
    await new Promise<void>(resolve => setImmediate(resolve))

    const replayed = managed.messages.find(message => message.id === 'queued-user')
    expect(replayed?.isQueued).toBe(false)
    expect(replayed?.timestamp).toBeGreaterThan(priorFinalTimestamp)

    const processingEvent = events.find(event => event.type === 'user_message')
    expect(processingEvent?.status).toBe('processing')
    expect(processingEvent?.message.timestamp).toBe(replayed?.timestamp)
    expect(processingEvent?.optimisticMessageId).toBe('optimistic-user')
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect((sendMessage.mock.calls[0] as unknown as unknown[])[8]).toEqual({ callerClientId: 'remote-client', remoteAccess: true })
  })
})
