import { describe, expect, it, mock } from 'bun:test'
import { createManagedSession, resolveMaxWarmRuntimes, SessionManager } from './SessionManager.ts'

const workspace = {
  id: 'ws-warm',
  name: 'Warm workspace',
  rootPath: '/tmp/warm-workspace',
  createdAt: Date.now(),
}

function warmSession(id: string, lastUsedAt: number) {
  const managed = createManagedSession({ id }, workspace as never, { messagesLoaded: true }) as any
  managed.runtimeLastUsedAt = lastUsedAt
  managed.agent = {
    isProcessing: () => false,
    disposeForRestart: mock(async () => {}),
    dispose: mock(() => {}),
  }
  managed.poolServer = { stop: mock(async () => {}) }
  managed.mcpPool = { disconnectAll: mock(async () => {}) }
  return managed
}

describe('SessionManager warm runtime eviction', () => {
  it('uses LRU to dispose the complete session runtime over the global limit', async () => {
    const manager = new SessionManager({ maxWarmRuntimes: 1 }) as any
    const older = warmSession('older', 100)
    const newer = warmSession('newer', 200)
    manager.sessions.set(older.id, older)
    manager.sessions.set(newer.id, newer)

    await manager.enforceWarmRuntimeLimit()

    expect(older.agent).toBeNull()
    expect(older.poolServer).toBeUndefined()
    expect(older.mcpPool).toBeUndefined()
    expect(newer.agent).not.toBeNull()
  })

  it('does not evict a runtime with an active background task', async () => {
    const manager = new SessionManager({ maxWarmRuntimes: 0 }) as any
    const managed = warmSession('background', 100)
    managed.backgroundTaskRegistry.set('task-1', { taskId: 'task-1', startTime: 1, status: 'running' })
    manager.sessions.set(managed.id, managed)

    await manager.enforceWarmRuntimeLimit()

    expect(managed.agent).not.toBeNull()
  })

  it('parses the configured warm runtime limit defensively', () => {
    expect(resolveMaxWarmRuntimes(undefined)).toBe(2)
    expect(resolveMaxWarmRuntimes('0')).toBe(0)
    expect(resolveMaxWarmRuntimes('3')).toBe(3)
    expect(resolveMaxWarmRuntimes('-1')).toBe(2)
    expect(resolveMaxWarmRuntimes('bad')).toBe(2)
  })
})
