import { describe, expect, it } from 'bun:test'
import { createManagedSession, SessionManager } from './SessionManager.ts'

const workspace = {
  id: 'ws-transcript',
  name: 'Transcript workspace',
  rootPath: 'X:\\nonexistent-transcript-test',
  createdAt: Date.now(),
}

function loadedSession(id: string) {
  return createManagedSession({ id }, workspace as never, {
    messagesLoaded: true,
    messages: [{ id: 'message-1', role: 'assistant', content: 'large transcript', timestamp: 1 }],
  }) as any
}

describe('SessionManager transcript release', () => {
  it('releases messages only after the last viewing client leaves', async () => {
    const manager = new SessionManager() as any
    const managed = loadedSession('session-1')
    manager.sessions.set(managed.id, managed)

    await manager.setSessionMessagesVisible(managed.id, 'client-a', true)
    await manager.setSessionMessagesVisible(managed.id, 'client-b', true)
    expect(await manager.setSessionMessagesVisible(managed.id, 'client-a', false)).toBe(false)
    expect(managed.messages).toHaveLength(1)

    expect(await manager.setSessionMessagesVisible(managed.id, 'client-b', false)).toBe(true)
    expect(managed.messages).toEqual([])
    expect(managed.messagesLoaded).toBe(false)
  })

  it('retains a transcript while its session is processing', async () => {
    const manager = new SessionManager() as any
    const managed = loadedSession('session-processing')
    managed.isProcessing = true
    manager.sessions.set(managed.id, managed)

    await manager.setSessionMessagesVisible(managed.id, 'client-a', true)
    expect(await manager.setSessionMessagesVisible(managed.id, 'client-a', false)).toBe(false)
    expect(managed.messages).toHaveLength(1)
    expect(managed.messagesLoaded).toBe(true)
  })

  it('cancels release when the transcript is touched while flush is pending', async () => {
    const manager = new SessionManager() as any
    const managed = loadedSession('session-race')
    manager.sessions.set(managed.id, managed)
    manager.flushSession = async () => {
      managed.transcriptAccessVersion = (managed.transcriptAccessVersion ?? 0) + 1
    }

    expect(await manager.setSessionMessagesVisible(managed.id, 'client-a', false)).toBe(false)
    expect(managed.messages).toHaveLength(1)
    expect(managed.messagesLoaded).toBe(true)
  })

  it('drops manager-owned transcript indexes during cleanup', async () => {
    const manager = new SessionManager() as any
    const managed = loadedSession('session-cleanup')
    manager.sessions.set(managed.id, managed)
    manager.transcriptViewers.set(managed.id, new Set(['client-a']))
    manager.activeViewingSession.set(workspace.id, managed.id)
    manager.taskOutputIndex.set('task-1', managed.id)
    manager.sessionCompletionListeners.add(() => {})

    await manager.cleanup()

    expect(manager.sessions.size).toBe(0)
    expect(manager.transcriptViewers.size).toBe(0)
    expect(manager.activeViewingSession.size).toBe(0)
    expect(manager.taskOutputIndex.size).toBe(0)
    expect(manager.sessionCompletionListeners.size).toBe(0)
  })
})
