import { expect, test } from 'bun:test'
import { SessionManager, type SessionCompletionEvent } from './SessionManager'

test('processing stop emits the current network error instead of an earlier action block', async () => {
  const manager = Object.create(SessionManager.prototype) as any
  const managed = {
    id: 'session', workspace: { id: 'workspace' }, isProcessing: true,
    turnStartFinalMessageId: 'old', messageQueue: [],
    messages: [
      { id: 'old', role: 'assistant', content: '<super_agent_actions>{"tasks":[]}</super_agent_actions>', timestamp: 1 },
      { id: 'current-user', role: 'user', content: 'Continue validation', timestamp: 2 },
      { id: 'network-error', role: 'error', content: 'Connection Error: Could not reach the AI service.', timestamp: 3 },
    ],
  }
  const completions: SessionCompletionEvent[] = []
  manager.sessions = new Map([['session', managed]])
  manager.transcriptViewers = new Map([['session', new Set(['viewer'])]])
  manager.pendingMcpReloadSessionIds = new Set()
  manager.clearPendingPermissionRequestsForSession = () => {}
  manager.setProcessing = (_managed: unknown, value: boolean) => { managed.isProcessing = value }
  manager.markOrphanedBackgroundTasks = () => {}
  manager.getBrowserPaneManagerForSession = () => null
  manager.isSessionBeingViewed = () => true
  manager.markSessionRead = () => { throw new Error('A failed turn must not be marked as a new answer') }
  manager.sendEvent = () => {}
  manager.emitSessionComplete = (event: SessionCompletionEvent) => { completions.push(event) }
  manager.enforceWarmRuntimeLimit = async () => {}
  manager.persistSession = () => {}
  await manager.onProcessingStopped('session', 'complete')
  expect(managed.isProcessing).toBe(false)
  expect(completions).toHaveLength(1)
  expect(completions[0]).toMatchObject({ reason: 'error', finalText: managed.messages[2]!.content })
  expect(completions[0]!.finalMessageId).toBeUndefined()
})

test('guarded history deletion rejects a newly active or changed session before teardown', async () => {
  const manager = Object.create(SessionManager.prototype) as any
  const managed = { id: 'session', workspace: { id: 'alpha' }, isProcessing: false, messageQueue: [], lastMessageAt: 10, sessionStatus: 'done' }
  manager.sessions = new Map([['session', managed]])
  const guard = { workspaceId: 'alpha', lastMessageAt: 10, onlyIdle: true as const }
  await expect(manager.deleteSession('session', { ...guard, workspaceId: 'beta' })).rejects.toThrow('changed')
  await expect(manager.deleteSession('session', { ...guard, lastMessageAt: 9 })).rejects.toThrow('changed')
  managed.isProcessing = true
  await expect(manager.deleteSession('session', guard)).rejects.toThrow('changed')
  expect(manager.sessions.has('session')).toBe(true)
})

test('a session undergoing deletion cannot start another model turn', async () => {
  const manager = Object.create(SessionManager.prototype) as any
  manager.sessions = new Map([['session', { id: 'session', persistenceRetired: true }]])
  await expect(manager.sendMessage('session', 'Start new work')).rejects.toThrow('being deleted')
})
