import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { storedToMessage } from '@craft-agent/core/types'
import { checkSessionExecutionPolicy, clearSessionExecutionPolicy } from '@craft-agent/shared/agent'
import { getPermissionModeDiagnostics, setPermissionMode, type PermissionMode } from '@craft-agent/shared/agent/mode-manager'
import { createSession, loadSession, saveSession, sessionPersistenceQueue } from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(options: { cold?: boolean; role?: 'coordinator' | 'worker' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'super-agent-session-settings-'))
  const created = await createSession(root, { name: 'Existing node', permissionMode: 'safe', agentSystemPrompt: 'Legacy node prompt' })
  const stored = loadSession(root, created.id)!
  const policy = { nodeId: options.role === 'worker' ? 'worker' : 'main', role: options.role ?? 'coordinator', rootPath: root,
    readFiles: true, writeFiles: false, runPrograms: false, browser: false, allowSources: [], allowSubagents: false as const }
  stored.executionPolicy = policy
  stored.sdkSessionId = 'existing-sdk-conversation'
  stored.messages = [
    { id: 'existing-user', type: 'user', content: 'Existing user request', timestamp: 1 },
    { id: 'existing-assistant', type: 'assistant', content: 'Existing reply', timestamp: 2 },
  ]
  await saveSession(stored)
  const manager = new SessionManager()
  manager.setEventSink(() => {})
  const { messages, ...header } = stored
  const managed = createManagedSession(header, { id: 'workspace', slug: 'workspace', name: 'Workspace', rootPath: root, createdAt: 1 }, { messagesLoaded: !options.cold })
  if (!options.cold) managed.messages = messages.map(storedToMessage)
  // Simulate an already running application holding a legacy Explore node.
  managed.permissionMode = 'safe'
  setPermissionMode(managed.id, 'safe', { changedBy: 'restore' })
  const internals = manager as any
  internals.sessions.set(managed.id, managed)
  let backendMode: PermissionMode = 'safe'
  const modeCalls: PermissionMode[] = []
  let disposals = 0
  const agent = { getPermissionMode: () => backendMode, setPermissionMode: (mode: PermissionMode) => { backendMode = mode; modeCalls.push(mode) },
    isProcessing: () => false, disposeForRestart: async () => { disposals++ }, dispose: () => { disposals++ } }
  managed.agent = agent as never
  cleanups.push(async () => {
    await manager.cleanup()
    sessionPersistenceQueue.cancel(managed.id)
    await sessionPersistenceQueue.cancelAndWait(managed.id)
    clearSessionExecutionPolicy(managed.id)
    expect(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)).toBe(true)
    await rm(root, { recursive: true, force: true })
  })
  return { root, stored, header, policy, manager, internals, managed, agent, modeCalls, getDisposals: () => disposals }
}

describe('Super Agent session settings reconciliation', () => {
  test('restored coordinator and worker nodes default to Execute while ordinary sessions retain their mode', async () => {
    const f = await fixture()
    const restoredMain = createManagedSession({ ...f.header, id: 'restored-main', permissionMode: 'safe' }, f.managed.workspace)
    const restoredWorker = createManagedSession({ ...f.header, id: 'restored-worker', permissionMode: 'ask', executionPolicy: { ...f.policy, nodeId: 'worker', role: 'worker' } }, f.managed.workspace)
    const ordinary = createManagedSession({ id: 'ordinary-session', permissionMode: 'safe' }, f.managed.workspace)
    expect(restoredMain.permissionMode).toBe('allow-all')
    expect(restoredWorker.permissionMode).toBe('allow-all')
    expect(getPermissionModeDiagnostics(restoredMain.id).permissionMode).toBe('allow-all')
    expect(getPermissionModeDiagnostics(restoredWorker.id).permissionMode).toBe('allow-all')
    expect(ordinary.permissionMode).toBe('safe')
    clearSessionExecutionPolicy(restoredMain.id); clearSessionExecutionPolicy(restoredWorker.id)
  })

  test('heals managed, global and warm backend modes without recycling an unchanged prompt', async () => {
    const f = await fixture()
    await f.manager.ensureSuperAgentSessionSettings(f.managed.id, { permissionMode: 'allow-all', agentSystemPrompt: 'Legacy node prompt' })
    expect(f.managed.permissionMode).toBe('allow-all')
    expect(getPermissionModeDiagnostics(f.managed.id).permissionMode).toBe('allow-all')
    expect(f.agent.getPermissionMode()).toBe('allow-all')
    expect(f.modeCalls).toEqual(['allow-all'])
    expect(f.managed.agent as unknown).toBe(f.agent)
    expect(f.getDisposals()).toBe(0)
    const saved = loadSession(f.root, f.managed.id)!
    expect(saved.permissionMode).toBe('allow-all')
    expect(saved.messages.map(message => message.id)).toEqual(['existing-user', 'existing-assistant'])
    expect(checkSessionExecutionPolicy(f.managed.id, 'Write', { file_path: join(f.root, 'blocked.txt') }, f.root).allowed).toBe(false)
    f.manager.setSessionPermissionMode(f.managed.id, 'safe')
    expect(f.managed.permissionMode).toBe('allow-all')
    expect(f.agent.getPermissionMode()).toBe('allow-all')
  })

  test('updates a cold persisted prompt and recreates only its idle backend while keeping transcript and SDK conversation', async () => {
    const f = await fixture({ cold: true })
    await f.manager.ensureSuperAgentSessionSettings(f.managed.id, { permissionMode: 'allow-all', agentSystemPrompt: 'Updated dispatch prompt' })
    expect(f.managed.agentSystemPrompt).toBe('Updated dispatch prompt')
    expect(f.managed.agentPrompt).toBe('Updated dispatch prompt')
    expect(f.managed.sdkSessionId).toBe('existing-sdk-conversation')
    expect(f.managed.agent).toBeNull()
    expect(f.getDisposals()).toBe(1)
    expect(f.managed.messages.map(message => message.id)).toEqual(['existing-user', 'existing-assistant'])
    expect(f.managed.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    const saved = loadSession(f.root, f.managed.id)!
    expect(saved.agentSystemPrompt).toBe('Updated dispatch prompt')
    expect(saved.permissionMode).toBe('allow-all')
    expect(saved.sdkSessionId).toBe('existing-sdk-conversation')
    expect(saved.messages.map(message => message.id)).toEqual(['existing-user', 'existing-assistant'])
    let regenerated: { prompt: string; permissionMode: PermissionMode; sdkSessionId: string } | undefined
    f.internals.createAgentRuntime = async () => {
      regenerated = { prompt: f.managed.agentPrompt!, permissionMode: f.managed.permissionMode!, sdkSessionId: f.managed.sdkSessionId! }
      f.managed.agent = f.agent as never
      return f.agent
    }
    await f.internals.getOrCreateAgent(f.managed)
    expect(regenerated).toEqual({ prompt: 'Updated dispatch prompt', permissionMode: 'allow-all', sdkSessionId: 'existing-sdk-conversation' })
  })

  test('direct reuse and send paths heal legacy node mode before any operation without bypassing its ceiling', async () => {
    const f = await fixture({ role: 'worker' })
    f.internals.createAgentRuntime = async () => { expect(f.managed.permissionMode).toBe('allow-all'); expect(f.agent.getPermissionMode()).toBe('allow-all'); return f.agent }
    await f.internals.getOrCreateAgent(f.managed)
    expect(f.managed.permissionMode as PermissionMode).toBe('allow-all')
    f.managed.permissionMode = 'safe'
    setPermissionMode(f.managed.id, 'safe', { changedBy: 'restore' })
    f.agent.setPermissionMode('safe')
    await expect(f.manager.sendMessage(f.managed.id, 'Read an attachment', [{ type: 'text', path: join(f.root, '..', 'outside-node.txt'), name: 'outside-node.txt', mimeType: 'text/plain', size: 1 }])).rejects.toThrow('attachment is outside')
    expect(f.managed.permissionMode as PermissionMode).toBe('allow-all')
    expect(getPermissionModeDiagnostics(f.managed.id).permissionMode).toBe('allow-all')
    expect(f.agent.getPermissionMode()).toBe('allow-all')
    await f.manager.flushSession(f.managed.id)
    expect(loadSession(f.root, f.managed.id)!.permissionMode).toBe('allow-all')
    expect(f.managed.messages.map(message => message.id)).toEqual(['existing-user', 'existing-assistant'])
  })

  test('rejects processing, queued and non-node sessions without touching their prompt or backend', async () => {
    const f = await fixture()
    f.managed.isProcessing = true
    await expect(f.manager.ensureSuperAgentSessionSettings(f.managed.id, { permissionMode: 'allow-all', agentSystemPrompt: 'Rejected prompt' })).rejects.toThrow('Stop active and queued')
    f.managed.isProcessing = false
    f.managed.messageQueue.push({ message: 'Queued work' })
    await expect(f.manager.ensureSuperAgentSessionSettings(f.managed.id, { permissionMode: 'allow-all', agentSystemPrompt: 'Rejected prompt' })).rejects.toThrow('Stop active and queued')
    f.managed.messageQueue = []
    const ordinary = createManagedSession({ id: 'ordinary', permissionMode: 'safe' }, f.managed.workspace, { messagesLoaded: true })
    f.internals.sessions.set(ordinary.id, ordinary)
    await expect(f.manager.ensureSuperAgentSessionSettings(ordinary.id, { permissionMode: 'allow-all', agentSystemPrompt: 'Rejected prompt' })).rejects.toThrow('node session not found')
    f.manager.setSessionPermissionMode(ordinary.id, 'safe')
    expect(ordinary.permissionMode).toBe('safe')
    f.internals.sessions.delete(ordinary.id)
    expect(f.managed.agentSystemPrompt).toBe('Legacy node prompt')
    expect(f.managed.agent as unknown).toBe(f.agent)
    expect(f.modeCalls).toEqual([])
    expect(f.getDisposals()).toBe(0)
  })

  test('a lazy backend waits for all queued prompt updates and never starts with the stale prompt', async () => {
    const f = await fixture(), entered = deferred(), release = deferred()
    f.agent.disposeForRestart = async () => { entered.resolve(); await release.promise }
    const first = f.manager.ensureSuperAgentSessionSettings(f.managed.id, { permissionMode: 'allow-all', agentSystemPrompt: 'First new prompt' })
    await entered.promise
    let constructions = 0
    f.internals.createAgentRuntime = async () => { constructions++; expect(f.managed.agentPrompt).toBe('Latest new prompt'); expect(f.managed.permissionMode).toBe('allow-all'); return f.agent }
    const creating = f.internals.getOrCreateAgent(f.managed)
    const second = f.manager.ensureSuperAgentSessionSettings(f.managed.id, { permissionMode: 'allow-all', agentSystemPrompt: 'Latest new prompt' })
    expect(constructions).toBe(0)
    release.resolve()
    await Promise.all([first, second, creating])
    expect(constructions).toBe(1)
    expect(loadSession(f.root, f.managed.id)!.agentSystemPrompt).toBe('Latest new prompt')
  })

  test('rechecks idleness after an existing startup completes before mutating the prompt', async () => {
    const f = await fixture(), release = deferred()
    const startup = release.promise.then(() => { f.internals.agentCreationLocks.delete(f.managed.id); return f.agent })
    f.internals.agentCreationLocks.set(f.managed.id, startup)
    const update = f.manager.ensureSuperAgentSessionSettings(f.managed.id, { permissionMode: 'allow-all', agentSystemPrompt: 'Must not replace active prompt' })
    await Promise.resolve()
    f.managed.isProcessing = true
    release.resolve()
    await expect(update).rejects.toThrow('Stop active and queued')
    expect(f.managed.agentSystemPrompt).toBe('Legacy node prompt')
    expect(f.modeCalls).toEqual([])
    expect(f.getDisposals()).toBe(0)
    f.managed.isProcessing = false
  })
})
