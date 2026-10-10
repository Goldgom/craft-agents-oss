import { describe, expect, it, mock } from 'bun:test'
import { createManagedSession, SessionManager } from './SessionManager'

describe('workspace and frontend disconnection lifecycle', () => {
  it('retains the running agent, transcript, queue, and event observers after the last viewer leaves', async () => {
    const manager = new SessionManager() as any
    const workspace = { id: 'local-workspace', name: 'Local', rootPath: 'X:\\nonexistent-switch-test', createdAt: 1 }
    const managed = createManagedSession({ id: 'running-local-agent' }, workspace as never, {
      messagesLoaded: true,
      messages: [{ id: 'message', role: 'assistant', content: 'Working', timestamp: 1 }],
    }) as any
    const agent = { abort: mock(() => {}), disposeForRestart: mock(async () => {}) }
    managed.agent = agent
    managed.isProcessing = true
    const queued = { message: 'Continue with the next step' }
    managed.messageQueue.push(queued)
    manager.sessions.set(managed.id, managed)
    manager.activeViewingSession.set(workspace.id, managed.id)
    manager.browserHostByCanvas.set(managed.id, 'old-frontend')
    await manager.setSessionMessagesVisible(managed.id, 'old-frontend', true)
    const observed = mock(() => {})
    manager.setEventSink(() => {})
    const unsubscribe = manager.onSessionEvent(observed)

    manager.clearActiveViewingSession(workspace.id)
    manager.onClientDisconnected('old-frontend')
    await Promise.resolve()

    expect(manager.sessions.get(managed.id)).toBe(managed)
    expect(managed.agent).toBe(agent)
    expect(managed.isProcessing).toBe(true)
    expect(managed.messagesLoaded).toBe(true)
    expect(managed.messages).toHaveLength(1)
    expect(managed.messageQueue).toEqual([queued])
    expect(agent.abort).not.toHaveBeenCalled()
    expect(agent.disposeForRestart).not.toHaveBeenCalled()
    expect(manager.activeViewingSession.has(workspace.id)).toBe(false)
    expect(manager.browserHostByCanvas.has(managed.id)).toBe(false)
    manager.sendEvent({ type: 'text_delta', sessionId: managed.id, delta: 'Still running' }, workspace.id)
    expect(observed).toHaveBeenCalledTimes(1)
    unsubscribe()
    // Only test-owned in-memory state exists; no provider or disk writes.
    manager.sessions.clear()
  })
})
