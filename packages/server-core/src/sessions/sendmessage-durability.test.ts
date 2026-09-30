import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { getSessionFilePath } from '@craft-agent/shared/sessions/storage'
import { sessionPersistenceQueue } from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// Regression test for the High-severity finding in eb81086e:
//
//   sendMessage's `{ accepted, messageId }` ack contract was returning before
//   the user message hit disk because `persistSession` only enqueues with a
//   500ms debounce. A crash inside the debounce window after ack would lose
//   the message.
//
// The fix added `await this.flushSession(managed.id)` between persistSession
// and onAck. This test locks that ordering by reading the session file from
// inside the onAck callback and asserting the user message is already there.

describe('sendMessage durability', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-durability-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    for (const id of (sm as any).sessions.keys()) sessionPersistenceQueue.cancel(id)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'durability test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function readPersistedMessageIds(sessionId: string): string[] {
    const path = getSessionFilePath(tmpRoot, sessionId)
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf-8').trim().split('\n')
    // First line is the header, remaining lines are messages.
    return lines.slice(1).map(l => JSON.parse(l)).map(m => m.id as string)
  }

  it('user message is on disk before onAck fires (normal branch)', async () => {
    const sessionId = 'durability-normal'
    buildSession(sessionId)

    let ackedMessageId: string | null = null
    let onDiskAtAck = false

    // sendMessage continues past the ack into agent-init, which would throw
    // because we haven't called `setSessionPlatform()` in this minimal test
    // harness. That's fine — we only care about the persist+flush+ack ordering
    // that happens before agent-init. Catch the post-ack rejection.
    await sm
      .sendMessage(
        sessionId,
        'hello',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (messageId) => {
          ackedMessageId = messageId
          onDiskAtAck = readPersistedMessageIds(sessionId).includes(messageId)
        },
      )
      .catch(() => { /* expected post-ack agent-init failure */ })

    expect(ackedMessageId).not.toBeNull()
    expect(onDiskAtAck).toBe(true)
  })

  it('user message is on disk before onAck fires (mid-stream / queued branch)', async () => {
    const sessionId = 'durability-midstream'
    const managed = buildSession(sessionId)
    // Force the mid-stream branch. Agent is null, so redirect() falls back to
    // false and the queue path runs.
    managed.isProcessing = true

    let ackedMessageId: string | null = null
    let onDiskAtAck = false

    await sm.sendMessage(
      sessionId,
      'queued message',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (messageId) => {
        ackedMessageId = messageId
        onDiskAtAck = readPersistedMessageIds(sessionId).includes(messageId)
      },
    )

    expect(ackedMessageId).not.toBeNull()
    expect(onDiskAtAck).toBe(true)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('normal send rejects a real disk failure before ACK or agent initialization', async () => {
    const sessionId = 'durability-disk-failure'
    const managed = buildSession(sessionId)
    ;(sm as any).persistSession(managed, true)
    await sm.flushSession(sessionId)
    const path = getSessionFilePath(tmpRoot, sessionId)
    let original = readFileSync(path, 'utf8')
    let acknowledged = false, agentInitializations = 0
    ;(sm as any).getOrCreateAgent = () => { agentInitializations++; throw new Error('Unexpected agent initialization') }
    const persist = (sm as any).persistSession.bind(sm)
    ;(sm as any).persistSession = (...args: unknown[]) => {
      persist(...args)
      if (managed.messages.length) {
        // Let the earlier pending-plan metadata save finish, then fail the
        // actual user-message snapshot at the real filesystem boundary.
        original = readFileSync(path, 'utf8')
        chmodSync(dirname(path), 0o500)
      }
    }
    try {
      await expect(sm.sendMessage(sessionId, 'owned message', undefined, undefined, undefined, undefined, undefined,
        () => { acknowledged = true })).rejects.toThrow()
      expect(acknowledged).toBe(false)
      expect(agentInitializations).toBe(0)
      expect(readFileSync(path, 'utf8')).toBe(original)
      expect(sessionPersistenceQueue.hasPending(sessionId)).toBe(true)
      chmodSync(dirname(path), 0o700)
      await sm.flushSession(sessionId)
      expect(readPersistedMessageIds(sessionId)).toEqual([managed.messages[0]!.id])
    } finally { chmodSync(dirname(path), 0o700) }
  })

  it('best-effort SDK metadata flush catches disk rejection and keeps the dirty snapshot retryable', async () => {
    const sessionId = 'durability-metadata-failure'
    const managed = buildSession(sessionId)
    ;(sm as any).persistSession(managed, true)
    await sm.flushSession(sessionId)
    const originalFlush = sm.flushSession.bind(sm)
    const reported = spyOn(console, 'error').mockImplementation(() => {})
    managed.name = 'Updated metadata'
    ;(sm as any).persistSession(managed)
    sm.flushSession = async () => { throw new Error('Owned metadata flush failure') }
    try {
      expect((sm as any).flushSessionBestEffort(sessionId)).toBeUndefined()
      await Bun.sleep(10)
      expect(reported.mock.calls.length).toBeGreaterThan(0)
      expect(sessionPersistenceQueue.hasPending(sessionId)).toBe(true)
      await originalFlush(sessionId)
      expect(sessionPersistenceQueue.hasPending(sessionId)).toBe(false)
    } finally { reported.mockRestore(); sm.flushSession = originalFlush }
  })
})
