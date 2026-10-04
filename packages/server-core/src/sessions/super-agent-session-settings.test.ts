import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { storedToMessage } from '@craft-agent/core/types'
import { authorizeSessionPolicyTool, checkSessionExecutionPolicy, clearSessionExecutionPolicy, getSessionProgramExecutor, hasSessionPolicyToolGrant, setSessionProgramExecutor } from '@craft-agent/shared/agent'
import { getPermissionModeDiagnostics, setPermissionMode, type PermissionMode } from '@craft-agent/shared/agent/mode-manager'
import { createSession, loadSession, saveSession, sessionPersistenceQueue } from '@craft-agent/shared/sessions'
import { getSourcesBySlugs, isSourceUsable } from '@craft-agent/shared/sources'
import { SessionManager, createManagedSession } from './SessionManager'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(options: { cold?: boolean; role?: 'coordinator' | 'worker'; fullControl?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'super-agent-session-settings-'))
  const created = await createSession(root, { name: 'Existing node', permissionMode: 'safe', agentSystemPrompt: 'Legacy node prompt' })
  const stored = loadSession(root, created.id)!
  const policy = { nodeId: options.role === 'worker' ? 'worker' : 'main', role: options.role ?? 'coordinator', rootPath: root,
    readFiles: true, writeFiles: false, runPrograms: false, browser: false, allowSources: [], allowSubagents: false as const,
    ...(options.fullControl !== undefined ? { fullControl: options.fullControl } : {}) }
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
  const permissionResponses: Array<{ requestId: string; allowed: boolean; alwaysAllow?: boolean }> = []
  let disposals = 0
  const agent = { getPermissionMode: () => backendMode, setPermissionMode: (mode: PermissionMode) => { backendMode = mode; modeCalls.push(mode) },
    isProcessing: () => false, redirect: () => false, forceAbort: () => {},
    respondToPermission: (requestId: string, allowed: boolean, alwaysAllow?: boolean) => { permissionResponses.push({ requestId, allowed, alwaysAllow }) },
    disposeForRestart: async () => { disposals++ }, dispose: () => { disposals++ } }
  managed.agent = agent as never
  cleanups.push(async () => {
    await manager.cleanup()
    sessionPersistenceQueue.cancel(managed.id)
    await sessionPersistenceQueue.cancelAndWait(managed.id)
    clearSessionExecutionPolicy(managed.id)
    expect(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)).toBe(true)
    await rm(root, { recursive: true, force: true })
  })
  return { root, stored, header, policy, manager, internals, managed, agent, modeCalls, permissionResponses, getDisposals: () => disposals }
}

describe('Super Agent session settings reconciliation', () => {
  test('live full control persists and restores access without recycling an active cold node or losing its limited capabilities', async () => {
    const f = await fixture({ cold: true, role: 'worker' })
    f.managed.isProcessing = true
    const input = { file_path: resolve(f.root, '..', 'outside-node.txt'), content: 'outside' }
    const enabling = f.manager.setSuperAgentSessionFullControl(f.managed.id, true)
    expect(checkSessionExecutionPolicy(f.managed.id, 'Write', input, f.root).allowed).toBe(true)
    expect(f.managed.isProcessing).toBe(true)
    await enabling
    expect(f.getDisposals()).toBe(0)
    expect(f.managed.agent as unknown).toBe(f.agent)
    const saved = loadSession(f.root, f.managed.id)!
    expect(saved.executionPolicy).toMatchObject({ fullControl: true, readFiles: true, writeFiles: false, runPrograms: false, browser: false })
    expect(saved.messages.map(message => message.id)).toEqual(['existing-user', 'existing-assistant'])
    expect(saved.sdkSessionId).toBe('existing-sdk-conversation')
    const { messages: savedMessages, ...savedHeader } = saved
    const restored = createManagedSession({ ...savedHeader, id: 'restored-full-control' }, f.managed.workspace)
    expect(restored.executionPolicy?.fullControl).toBe(true)
    expect(checkSessionExecutionPolicy(restored.id, 'Write', input, f.root).allowed).toBe(true)
    clearSessionExecutionPolicy(restored.id)
    const disabling = f.manager.setSuperAgentSessionFullControl(f.managed.id, false)
    expect(checkSessionExecutionPolicy(f.managed.id, 'Write', input, f.root).allowed).toBe(false)
    expect(f.managed.isProcessing).toBe(true)
    await disabling
    expect(loadSession(f.root, f.managed.id)!.executionPolicy).toMatchObject({ fullControl: false, writeFiles: false, runPrograms: false, browser: false })
    expect(f.getDisposals()).toBe(0)
    f.managed.isProcessing = false
  })

  test('enabling resumes the original pending operation and provider approval rather than cancelling either', async () => {
    const f = await fixture({ role: 'worker' })
    const outside = await mkdtemp(join(tmpdir(), 'super-agent-pending-outside-'))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    const input = { file_path: join(outside, 'requested.txt') }
    await writeFile(input.file_path, 'Original pending read')
    f.managed.isProcessing = true
    f.internals.attachNodePermissionHandler(f.managed)
    const events: any[] = []
    f.manager.onSessionEvent(event => events.push(event))
    const original = authorizeSessionPolicyTool(f.managed.id, 'Read', input, f.root)
    expect(f.internals.pendingNodePermissions.size).toBe(1)
    f.internals.pendingPermissionRequests.set('native-admin', { sessionId: f.managed.id, type: 'admin_approval', toolName: 'Bash', command: 'sudo arbitrary-command' })
    await f.manager.setSuperAgentSessionFullControl(f.managed.id, true)
    expect((await original).allowed).toBe(true)
    expect(f.permissionResponses).toEqual([{ requestId: 'native-admin', allowed: true, alwaysAllow: false }])
    expect(f.internals.pendingNodePermissions.size).toBe(0)
    expect(f.internals.pendingPermissionRequests.size).toBe(0)
    expect(events.filter(event => event.type === 'permission_request')).toHaveLength(1)
    expect(events.filter(event => event.type === 'permission_resolved' && event.allowed)).toHaveLength(2)
    expect(hasSessionPolicyToolGrant(f.managed.id, 'Read', input, f.root)).toBe(false)
    await f.manager.setSuperAgentSessionFullControl(f.managed.id, false)
    expect(checkSessionExecutionPolicy(f.managed.id, 'Read', input, f.root).allowed).toBe(false)
    f.managed.isProcessing = false
  })

  test('revocation reaches hidden previous nodes and keeps other workspaces and ordinary sessions unchanged', async () => {
    const f = await fixture({ role: 'worker', fullControl: true })
    const previousConfig = await createSession(f.root, { name: 'Hidden previous node', permissionMode: 'allow-all' })
    const previous = loadSession(f.root, previousConfig.id)!
    previous.executionPolicy = { ...f.policy, nodeId: 'previous-worker', fullControl: true }
    previous.hidden = true
    await saveSession(previous)
    const { messages, ...header } = previous
    const hidden = createManagedSession(header, f.managed.workspace, { messagesLoaded: false })
    f.internals.sessions.set(hidden.id, hidden)
    const foreign = createManagedSession({ ...f.header, id: 'other-workspace-node', executionPolicy: { ...f.policy, fullControl: true } }, { ...f.managed.workspace, id: 'other-workspace' })
    const ordinary = createManagedSession({ id: 'ordinary', permissionMode: 'safe' }, f.managed.workspace, { messagesLoaded: true })
    f.internals.sessions.set(foreign.id, foreign)
    f.internals.sessions.set(ordinary.id, ordinary)
    f.managed.isProcessing = true
    hidden.isProcessing = true
    const disabling = f.manager.setSuperAgentFullControl('workspace', false)
    expect(f.managed.executionPolicy?.fullControl).toBe(false)
    expect(hidden.executionPolicy?.fullControl).toBe(false)
    expect(foreign.executionPolicy?.fullControl).toBe(true)
    expect(ordinary.permissionMode).toBe('safe')
    await disabling
    expect(loadSession(f.root, hidden.id)!.executionPolicy?.fullControl).toBe(false)
    expect(loadSession(f.root, f.managed.id)!.executionPolicy?.fullControl).toBe(false)
    expect(f.managed.agent as unknown).toBe(f.agent)
    expect(f.getDisposals()).toBe(0)
    f.managed.isProcessing = false
    hidden.isProcessing = false
    f.internals.sessions.delete(foreign.id)
    f.internals.sessions.delete(ordinary.id)
    clearSessionExecutionPolicy(foreign.id)
  })

  test('flag-only changes revalidate and retain the actual verified sandbox executor without persisting its handle', async () => {
    const f = await fixture({ role: 'worker' })
    const runtimePath = join(f.root, process.platform === 'win32' ? 'docker.exe' : 'docker')
    await writeFile(runtimePath, 'Verified test runtime')
    setSessionProgramExecutor(f.managed.id, { runtimePath, containerId: 'tokenbird-super-test', workingDirectory: '/workspace' })
    await f.manager.setSuperAgentSessionFullControl(f.managed.id, true)
    expect(getSessionProgramExecutor(f.managed.id)?.containerId).toBe('tokenbird-super-test')
    await f.manager.setSuperAgentSessionFullControl(f.managed.id, false)
    expect(getSessionProgramExecutor(f.managed.id)?.containerId).toBe('tokenbird-super-test')
    expect(loadSession(f.root, f.managed.id)!.executionPolicy).not.toHaveProperty('containerExecutor')
  })

  test('full control permits queueing an outside attachment and real directory/source selection, then restores the direct gates', async () => {
    const f = await fixture({ role: 'worker' })
    const outside = await mkdtemp(join(tmpdir(), 'super-agent-direct-outside-'))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))
    const attachment = { type: 'text' as const, path: join(outside, 'document.txt'), name: 'document.txt', mimeType: 'text/plain', size: 1 }
    await writeFile(attachment.path, 'Existing outside attachment')
    await f.manager.setSuperAgentSessionFullControl(f.managed.id, true)
    f.managed.isProcessing = true
    await f.manager.sendMessage(f.managed.id, 'Read the outside attachment', [attachment])
    expect(f.managed.messageQueue.at(-1)?.attachments).toEqual([attachment])
    f.managed.messageQueue = []
    f.managed.isProcessing = false
    f.managed.agent = null
    f.manager.updateWorkingDirectory(f.managed.id, outside)
    expect(f.managed.workingDirectory).toBe(outside)
    const sourceFolder = join(f.root, 'sources', 'selected-real-source')
    await mkdir(sourceFolder, { recursive: true })
    await writeFile(join(sourceFolder, 'config.json'), JSON.stringify({ id: 'selected-real-source', name: 'Real Source', slug: 'selected-real-source',
      enabled: true, provider: 'test', type: 'api', api: { baseUrl: 'https://example.invalid', authType: 'none' } }))
    expect(getSourcesBySlugs(f.root, ['selected-real-source']).filter(isSourceUsable)).toHaveLength(1)
    await f.manager.setSessionSources(f.managed.id, ['selected-real-source'])
    expect(f.managed.enabledSourceSlugs).toEqual(['selected-real-source'])
    await f.manager.setSuperAgentSessionFullControl(f.managed.id, false)
    expect(() => f.manager.updateWorkingDirectory(f.managed.id, outside)).toThrow('working directory is outside')
    await expect(f.manager.setSessionSources(f.managed.id, ['selected-real-source'])).rejects.toThrow('data source is not assigned')
    await expect(f.manager.sendMessage(f.managed.id, 'Read blocked attachment', [attachment])).rejects.toThrow('attachment is outside')
  })
  test('a failed workspace activation rolls back successful peer nodes and their durable flags', async () => {
    const f = await fixture({ role: 'worker' })
    const peerConfig = await createSession(f.root, { name: 'Peer node', permissionMode: 'allow-all' })
    const peerStored = loadSession(f.root, peerConfig.id)!
    peerStored.executionPolicy = { ...f.policy, nodeId: 'peer-worker' }
    await saveSession(peerStored)
    const { messages, ...peerHeader } = peerStored
    const peer = createManagedSession(peerHeader, f.managed.workspace)
    f.internals.sessions.set(peer.id, peer)
    const realFlush = sessionPersistenceQueue.flush.bind(sessionPersistenceQueue)
    const flush = spyOn(sessionPersistenceQueue, 'flush').mockImplementation(async sessionId => {
      if (sessionId === f.managed.id && f.managed.executionPolicy?.fullControl) throw new Error('Injected activation persistence failure')
      await realFlush(sessionId)
    })
    try {
      await expect(f.manager.setSuperAgentFullControl('workspace', true)).rejects.toThrow('Injected activation persistence failure')
      expect(f.managed.executionPolicy?.fullControl).toBe(false)
      expect(peer.executionPolicy?.fullControl).toBe(false)
      expect(loadSession(f.root, f.managed.id)!.executionPolicy?.fullControl).toBe(false)
      expect(loadSession(f.root, peer.id)!.executionPolicy?.fullControl).toBe(false)
      expect(f.getDisposals()).toBe(0)
    } finally { flush.mockRestore() }
  })

  test('a delayed activation failure cannot undo a newer live revocation', async () => {
    const f = await fixture({ role: 'worker' }), entered = deferred(), release = deferred()
    const realFlush = sessionPersistenceQueue.flush.bind(sessionPersistenceQueue)
    let suspended = false
    const flush = spyOn(sessionPersistenceQueue, 'flush').mockImplementation(async sessionId => {
      if (sessionId === f.managed.id && f.managed.executionPolicy?.fullControl && !suspended) {
        suspended = true
        entered.resolve()
        await release.promise
        throw new Error('Late activation persistence failure')
      }
      await realFlush(sessionId)
    })
    try {
      const enabling = f.manager.setSuperAgentFullControl('workspace', true)
      const rejected = enabling.then(() => undefined, error => error as Error)
      await entered.promise
      await f.manager.setSuperAgentFullControl('workspace', false)
      expect(f.managed.executionPolicy?.fullControl).toBe(false)
      release.resolve()
      expect((await rejected)?.message).toBe('Late activation persistence failure')
      expect(f.managed.executionPolicy?.fullControl).toBe(false)
      expect(loadSession(f.root, f.managed.id)!.executionPolicy?.fullControl).toBe(false)
      expect(checkSessionExecutionPolicy(f.managed.id, 'Write', { file_path: resolve(f.root, '..', 'outside.txt'), content: 'blocked' }).allowed).toBe(false)
    } finally { release.resolve(); flush.mockRestore() }
  })

  test('failed revocation persistence keeps live and reused nodes restricted until durable retry succeeds', async () => {
    const f = await fixture({ role: 'worker', fullControl: true })
    const flush = spyOn(sessionPersistenceQueue, 'flush').mockRejectedValue(new Error('Injected revocation persistence failure'))
    try {
      await expect(f.manager.setSuperAgentFullControl('workspace', false)).rejects.toThrow('Injected revocation persistence failure')
      expect(f.managed.executionPolicy?.fullControl).toBe(false)
      const input = { file_path: resolve(f.root, '..', 'outside.txt'), content: 'blocked' }
      expect(checkSessionExecutionPolicy(f.managed.id, 'Write', input).allowed).toBe(false)
      f.internals.createAgentRuntime = async () => f.agent
      await f.internals.getOrCreateAgent(f.managed)
      expect(checkSessionExecutionPolicy(f.managed.id, 'Write', input).allowed).toBe(false)
      expect(f.getDisposals()).toBe(0)
    } finally { flush.mockRestore() }
    await f.manager.setSuperAgentFullControl('workspace', false)
    expect(loadSession(f.root, f.managed.id)!.executionPolicy?.fullControl).toBe(false)
  })

  test('failed verified-executor revalidation revokes an activation rather than leaving host access enabled', async () => {
    const f = await fixture({ role: 'worker' })
    const runtimePath = join(f.root, process.platform === 'win32' ? 'docker.exe' : 'docker')
    await writeFile(runtimePath, 'Verified test runtime')
    setSessionProgramExecutor(f.managed.id, { runtimePath, containerId: 'tokenbird-super-test', workingDirectory: '/workspace' })
    await rm(runtimePath)
    await expect(f.manager.setSuperAgentFullControl('workspace', true)).rejects.toThrow()
    expect(f.managed.executionPolicy?.fullControl).toBe(false)
    expect(checkSessionExecutionPolicy(f.managed.id, 'Bash', { command: 'echo blocked' }, f.root).allowed).toBe(false)
    expect(getSessionProgramExecutor(f.managed.id)).toBeUndefined()
    expect(loadSession(f.root, f.managed.id)!.executionPolicy?.fullControl).toBe(false)
  })

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
