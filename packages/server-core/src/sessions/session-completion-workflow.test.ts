import { expect, test } from 'bun:test'
import { SessionManager, type SessionCompletionEvent } from './SessionManager'
import { superAgentFixture, until } from '../super-agent/SuperAgentTestSupport'

function setup(sessionId = 'session') {
  const manager = Object.create(SessionManager.prototype) as any
  const managed: any = { id: sessionId, workspace: { id: 'alpha' }, isProcessing: true,
    processingGeneration: 1, messagesLoaded: true, messageQueue: [],
    messages: [{ id: 'user', role: 'user', content: 'Check evidence', timestamp: 1 },
      { id: 'final', role: 'assistant', content: 'Evidence review completed.', timestamp: 2 }] }
  const completions: SessionCompletionEvent[] = []
  const events: any[] = []
  manager.sessions = new Map([[sessionId, managed]])
  manager.transcriptViewers = new Map([[sessionId, new Set(['viewer'])]])
  manager.pendingMcpReloadSessionIds = new Set()
  manager.clearPendingPermissionRequestsForSession = () => {}
  manager.markOrphanedBackgroundTasks = () => {}
  manager.setProcessing = (_: unknown, value: boolean) => { managed.isProcessing = value }
  manager.getBrowserPaneManagerForSession = () => null
  manager.isSessionBeingViewed = () => true
  manager.markSessionRead = async () => {}
  manager.sendEvent = (event: unknown) => { events.push(event) }
  manager.emitSessionComplete = (event: SessionCompletionEvent) => { completions.push(event) }
  manager.enforceWarmRuntimeLimit = async () => {}
  manager.persistSession = () => {}
  return { manager, managed, completions, events }
}
function gate() {
  let release!: () => void
  return { promise: new Promise<void>(resolve => { release = resolve }), release: () => release() }
}

test('browser cleanup and read-state persistence cannot hold completion hostage', async () => {
  const { manager, completions, events } = setup()
  const browser = gate(); const metadata = gate()
  manager.getBrowserPaneManagerForSession = () => ({ clearVisualsForSession: () => browser.promise, unbindAllForSession: () => {} })
  manager.markSessionRead = () => metadata.promise
  try {
    await manager.onProcessingStopped('session', 'complete')
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ reason: 'complete', finalText: 'Evidence review completed.' })
    expect(events.at(-1).type).toBe('complete')
  } finally { browser.release(); metadata.release() }
})

test('metadata and browser failures remain auxiliary failures', async () => {
  const { manager, completions } = setup()
  manager.getBrowserPaneManagerForSession = () => { throw new Error('Desktop disconnected') }
  manager.markSessionRead = async () => { throw new Error('Metadata write failed') }
  await manager.onProcessingStopped('session', 'complete')
  expect(completions).toHaveLength(1)
  expect(completions[0]!.reason).toBe('complete')
})

test('a delayed cleanup cannot unbind the next turn browser', async () => {
  const { manager, managed, completions } = setup()
  const browser = gate(); let unbound = false
  manager.getBrowserPaneManagerForSession = () => ({ clearVisualsForSession: () => browser.promise, unbindAllForSession: () => { unbound = true } })
  manager.emitSessionComplete = (event: SessionCompletionEvent) => {
    completions.push(event); managed.processingGeneration++; managed.isProcessing = true
  }
  await manager.onProcessingStopped('session', 'complete')
  browser.release(); await Promise.resolve(); await Promise.resolve()
  expect(unbound).toBe(false)
})

test('a node with browser disabled finishes without resolving a desktop client', async () => {
  const { manager, managed, completions } = setup()
  managed.executionPolicy = { browser: false }
  manager.getBrowserPaneManagerForSession = () => { throw new Error('Should not resolve desktop') }
  await manager.onProcessingStopped('session', 'complete')
  expect(completions).toHaveLength(1)
})

test('deferred MCP maintenance starts after completion was published', async () => {
  const { manager, completions } = setup()
  const reload = gate()
  manager.pendingMcpReloadSessionIds.add('session')
  manager.reloadSessionSources = async () => { expect(completions).toHaveLength(1); await reload.promise }
  const ending = manager.onProcessingStopped('session', 'complete')
  expect(completions).toHaveLength(1)
  reload.release(); await ending
})

test('a real workflow accepts completion even while the desktop cleanup is stalled', async () => {
  const f = await superAgentFixture()
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'task', title: 'Review', instructions: 'Review existing evidence.' })
  const started = await until(() => f.service.get('alpha'), s => s.state.tasks[0]?.status === 'running' && f.host.sends.length === 1)
  const sid = started.state.tasks[0]!.sessionId!
  f.host.emit({ type: 'tool_start', sessionId: sid, toolUseId: 'board', toolName: 'super_agent_board', toolInput: {} })
  f.host.emit({ type: 'tool_result', sessionId: sid, toolUseId: 'board', toolName: 'super_agent_board', result: 'applied' })
  await f.service.get('alpha')
  const { manager } = setup(sid); const browser = gate()
  manager.setProcessing = (_: unknown, value: boolean) => { f.host.sessions.get(sid)!.isProcessing = value }
  manager.getBrowserPaneManagerForSession = () => ({ clearVisualsForSession: () => browser.promise, unbindAllForSession: () => {} })
  manager.emitSessionComplete = (event: SessionCompletionEvent) => { for (const listener of f.host.listeners) listener(event) }
  try {
    await manager.onProcessingStopped(sid, 'complete')
    await until(() => f.service.get('alpha'), s => s.state.tasks[0]?.status === 'completed')
    f.advance(20_000); await f.service.tick()
    expect((await f.service.get('alpha')).state.tasks[0]).toMatchObject({ status: 'completed', output: 'Evidence review completed.' })
    expect(f.host.sends.filter(s => s.sessionId === sid)).toHaveLength(1)
  } finally { browser.release() }
})
