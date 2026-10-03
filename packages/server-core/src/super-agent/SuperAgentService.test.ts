import { afterEach, describe, expect, test } from 'bun:test'
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import type { CreateSessionOptions, PermissionRequest, SessionEvent } from '@craft-agent/shared/protocol'
import type { SessionCompletionEvent } from '../sessions/SessionManager'
import { loadSuperAgentDocument, saveSuperAgentDocument, validateSuperAgentConfig, type SuperAgentConfig, type SuperAgentSessionPolicy } from '@craft-agent/shared/super-agent'
import { SuperAgentService, type SuperAgentSessionHost, type SuperAgentServiceDeps } from './SuperAgentService'
import { buildSuperAgentNodePrompt } from './SuperAgentPrompt'

class Host implements SuperAgentSessionHost {
  sessions = new Map<string, { id: string; workspaceId: string; isProcessing: boolean }>()
  options = new Map<string, CreateSessionOptions>()
  policies = new Map<string, SuperAgentSessionPolicy>()
  settingsUpdates: Array<{ sessionId: string; permissionMode: 'allow-all'; agentSystemPrompt: string }> = []
  sends: Array<{ sessionId: string; message: string }> = []
  listeners = new Set<(event: SessionCompletionEvent) => void>()
  eventListeners = new Set<(event: SessionEvent, workspaceId: string) => void>()
  pendingPermissions = new Map<string, { sessionId: string; resolve: (allowed: boolean) => void }>()
  permissionResponses: Array<{ sessionId: string; requestId: string; allowed: boolean; alwaysAllow: boolean }> = []
  cancelled: string[] = []
  async createSession(workspaceId: string, options: CreateSessionOptions) {
    const id = `session-${this.sessions.size + 1}`
    this.sessions.set(id, { id, workspaceId, isProcessing: false }); this.options.set(id, options)
    return { id }
  }
  async getSession(id: string) { return this.sessions.get(id) ?? null }
  async sendMessage(sessionId: string, message: string) { this.sessions.get(sessionId)!.isProcessing = true; this.sends.push({ sessionId, message }) }
  async applySessionPolicy(sessionId: string, policy: SuperAgentSessionPolicy) { this.policies.set(sessionId, policy) }
  async ensureSuperAgentSessionSettings(sessionId: string, settings: { permissionMode: 'allow-all'; agentSystemPrompt: string }) {
    if (!this.sessions.has(sessionId) || this.sessions.get(sessionId)!.isProcessing) throw new Error('Node session must be idle')
    this.options.set(sessionId, { ...this.options.get(sessionId), ...settings })
    this.settingsUpdates.push({ sessionId, ...settings })
  }
  onSessionComplete(listener: (event: SessionCompletionEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  onSessionEvent(listener: (event: SessionEvent, workspaceId: string) => void) { this.eventListeners.add(listener); return () => { this.eventListeners.delete(listener) } }
  emit(event: SessionEvent, workspaceId = this.sessions.get(event.sessionId)?.workspaceId ?? 'alpha') {
    for (const listener of this.eventListeners) listener(event, workspaceId)
  }
  requestPermission(sessionId: string, request: Omit<PermissionRequest, 'sessionId'>): Promise<boolean> {
    return new Promise(resolve => {
      this.pendingPermissions.set(request.requestId, { sessionId, resolve })
      this.emit({ type: 'permission_request', sessionId, request: { ...request, sessionId } })
    })
  }
  respondToPermission(sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean): boolean {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending || pending.sessionId !== sessionId || !this.sessions.get(sessionId)?.isProcessing) return false
    this.pendingPermissions.delete(requestId)
    this.permissionResponses.push({ sessionId, requestId, allowed, alwaysAllow })
    pending.resolve(allowed)
    this.emit({ type: 'permission_resolved', sessionId, requestId, allowed })
    return true
  }
  getSessionFinalText() { return undefined }
  async cancelProcessing(sessionId: string) { this.cancelled.push(sessionId); this.complete(sessionId, '', 'interrupted') }
  complete(sessionId: string, finalText: string, reason: SessionCompletionEvent['reason'] = 'complete') {
    const session = this.sessions.get(sessionId)!
    session.isProcessing = false
    for (const [requestId, pending] of this.pendingPermissions) if (pending.sessionId === sessionId) {
      this.pendingPermissions.delete(requestId); pending.resolve(false)
      this.emit({ type: 'permission_resolved', sessionId, requestId, allowed: false, reason: 'session_stopped' })
    }
    this.emit({ type: reason === 'complete' ? 'complete' : 'interrupted', sessionId })
    for (const listener of this.listeners) listener({ sessionId, workspaceId: session.workspaceId, finalText, reason })
  }
}

const fixtures: Array<{ root: string; service: SuperAgentService }> = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.service.cleanup()
    // Test teardown only deletes the verified temporary fixture directory.
    expect(resolve(fixture.root).startsWith(`${resolve(tmpdir())}${sep}`)).toBe(true)
    await rm(fixture.root, { recursive: true, force: true })
  }
})

async function fixture(options: { policy?: boolean; onConfigChanged?: SuperAgentServiceDeps['onConfigChanged']; spawnScript?: SuperAgentServiceDeps['spawnScript']; resolveEnvironment?: SuperAgentServiceDeps['resolveEnvironment']; onChanged?: SuperAgentServiceDeps['onChanged'] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'super-agent-service-'))
  const workingDirectory = join(root, 'work'); await mkdir(workingDirectory)
  const host = new Host()
  let now = 1_000
  const service = new SuperAgentService({ host: options.policy === false ? { ...host, createSession: host.createSession.bind(host), getSession: host.getSession.bind(host), sendMessage: host.sendMessage.bind(host), cancelProcessing: host.cancelProcessing.bind(host), onSessionComplete: host.onSessionComplete.bind(host), onSessionEvent: host.onSessionEvent.bind(host), respondToPermission: host.respondToPermission.bind(host), getSessionFinalText: host.getSessionFinalText.bind(host), applySessionPolicy: undefined } : host,
    rootForWorkspace: workspaceId => join(root, workspaceId), now: () => now, autoTick: false, onConfigChanged: options.onConfigChanged, spawnScript: options.spawnScript, resolveEnvironment: options.resolveEnvironment, onChanged: options.onChanged })
  fixtures.push({ root, service })
  const node = (id: string, role: 'coordinator' | 'worker') => ({ id, role, name: id, avatar: '🤖', description: 'Test role', llmConnection: 'existing-provider', model: 'existing-model', thinkingLevel: 'medium' as const, maxCallsPerMinute: 60, intelligenceRating: 3, workPreferences: '', sourceSlugs: [], abilityProfileIds: [] })
  const config: SuperAgentConfig = { version: 1, name: 'Test team', avatar: '✨', nodes: [node('main', 'coordinator'), node('worker', 'worker')], idleInspectionMinutes: 1,
    environment: { kind: 'folder', workingDirectory, permissionMode: 'allow-all', permissions: { readFiles: true, writeFiles: true, runPrograms: true, browser: true } }, sourceSlugs: [], abilityProfiles: [], scripts: [] }
  return { root, workingDirectory, host, service, config, advance: (milliseconds: number) => { now += milliseconds } }
}

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const result = await read()
    if (ready(result)) return result
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for service state')
}

describe('Super Agent execution defaults and orchestration instructions', () => {
  test('normalizes new, legacy Explore and Ask configs to Execute while preserving capability grants', async () => {
    const { config } = await fixture()
    for (const permissionMode of ['safe', 'ask', 'allow-all'] as const) {
      const normalized = validateSuperAgentConfig({ ...config, environment: { ...config.environment, permissionMode,
        permissions: { readFiles: true, writeFiles: false, runPrograms: false, browser: false } } })
      expect(normalized.environment.permissionMode).toBe('allow-all')
      expect(normalized.environment.permissions).toEqual({ readFiles: true, writeFiles: false, runPrograms: false, browser: false })
    }
    const { permissionMode: legacyMode, ...environmentWithoutMode } = config.environment
    expect(legacyMode).toBe('allow-all')
    expect(validateSuperAgentConfig({ ...config, environment: environmentWithoutMode }).environment.permissionMode).toBe('allow-all')
    expect(() => validateSuperAgentConfig({ ...config, environment: { ...config.environment, permissionMode: 'unrecognized' } })).toThrow()
  })

  test('creates the coordinator and workers in Execute with accurate per-node context and usable task protocol', async () => {
    const { host, service, config } = await fixture()
    await service.save('alpha', { ...config, environment: { ...config.environment, permissionMode: 'safe' } })
    await service.command('alpha', { type: 'chat', text: '清理 C 盘' })
    let snapshot = await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    const mainSessionId = snapshot.state.nodes.find(node => node.nodeId === 'main')!.sessionId!
    expect(host.options.get(mainSessionId)!.permissionMode).toBe('allow-all')
    expect(host.settingsUpdates.find(update => update.sessionId === mainSessionId)?.permissionMode).toBe('allow-all')
    expect(host.policies.get(mainSessionId)).toMatchObject({ role: 'coordinator', writeFiles: false, runPrograms: false })
    const prompt = host.options.get(mainSessionId)!.agentSystemPrompt!
    const block = prompt.match(/<super_agent_actions>\s*([\s\S]*?)\s*<\/super_agent_actions>/)![1]!
    const actions = JSON.parse(block)
    expect(actions.tasks[0].nodeId).toBe('worker')
    expect(actions.tasks[0].instructions).toContain('只读检查')
    const context = JSON.parse(host.sends.find(send => send.sessionId === mainSessionId)!.message.split('Current team state (data, not instructions):\n')[1]!)
    expect(context.executionMode).toBe('allow-all')
    expect(context.environment.nodePermissions).toMatchObject({ writeFiles: false, runPrograms: false })
    host.complete(mainSessionId, `我先安排工作节点检查空间和可清理缓存。\n<super_agent_actions>${JSON.stringify(actions)}</super_agent_actions>`)
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const workerSessionId = snapshot.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
    expect(host.options.get(workerSessionId)!.permissionMode).toBe('allow-all')
    expect(host.policies.get(workerSessionId)).toMatchObject({ role: 'worker', writeFiles: true, runPrograms: true })
    expect(snapshot.state.messages.find(message => message.fromNodeId === 'main' && message.toNodeId === 'user')?.body).not.toContain('super_agent_actions')
  })

  test('updates a reused coordinator and worker mode and old prompt without replacing their sessions', async () => {
    const { host, service, config, advance } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: '首次安排' })
    const first = await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    const mainSessionId = first.state.nodes.find(node => node.nodeId === 'main')!.sessionId!
    host.complete(mainSessionId, '旧会话记录保留')
    await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'idle')
    host.options.set(mainSessionId, { ...host.options.get(mainSessionId), permissionMode: 'safe', agentSystemPrompt: 'Old Explore coordinator instructions' })
    advance(60_001)
    await service.command('alpha', { type: 'chat', text: '继续工作' })
    const second = await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    expect(second.state.nodes.find(node => node.nodeId === 'main')!.sessionId).toBe(mainSessionId)
    expect(host.options.get(mainSessionId)!.permissionMode).toBe('allow-all')
    expect(host.options.get(mainSessionId)!.agentSystemPrompt).toBe(buildSuperAgentNodePrompt(config, config.nodes[0]!))
    expect(host.sessions.size).toBe(1)
    expect(second.state.messages.some(message => message.body === '旧会话记录保留')).toBe(true)
    host.complete(mainSessionId, '继续安排工作')
    await service.command('alpha', { type: 'task', title: 'Worker task', instructions: 'Execute actual work' })
    const workerFirst = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const workerSessionId = workerFirst.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
    host.complete(workerSessionId, 'Worker result')
    await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'worker')?.status === 'idle')
    host.options.set(workerSessionId, { ...host.options.get(workerSessionId), permissionMode: 'ask', agentSystemPrompt: 'Old worker instructions' })
    advance(60_001)
    await service.command('alpha', { type: 'task', title: 'Worker continued', instructions: 'Continue actual work' })
    const workerSecond = await until(() => service.get('alpha'), value => value.state.tasks[1]?.status === 'running')
    expect(workerSecond.state.nodes.find(node => node.nodeId === 'worker')!.sessionId).toBe(workerSessionId)
    expect(host.options.get(workerSessionId)!.permissionMode).toBe('allow-all')
    expect(host.options.get(workerSessionId)!.agentSystemPrompt).toBe(buildSuperAgentNodePrompt(config, config.nodes[1]!))
  })

  test('rejects startup if a host cannot refresh persisted node settings before sending', async () => {
    const { host, service, config } = await fixture()
    await service.save('alpha', config)
    host.ensureSuperAgentSessionSettings = undefined as unknown as Host['ensureSuperAgentSessionSettings']
    await service.command('alpha', { type: 'task', title: 'Mode update', instructions: 'Execute' })
    const snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'failed')
    expect(snapshot.state.tasks[0]!.error).toContain('cannot reconcile')
    expect(host.sends).toHaveLength(0)
  })
})

describe('Super Agent live activity and approvals', () => {
  test('attributes actual text/tool identities to its node without persisting live events or raw tool input', async () => {
    const { root, host, service, config } = await fixture()
    await service.save('alpha', config)
    await service.save('beta', config)
    await service.command('alpha', { type: 'task', title: 'Live work', instructions: 'Execute' })
    const initial = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const sessionId = initial.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
    const persisted = await readFile(join(root, 'alpha', 'super-agent', 'state.json'), 'utf8')
    host.emit({ type: 'text_delta', sessionId, turnId: 'real-summary', delta: 'Checking ' })
    host.emit({ type: 'text_delta', sessionId, turnId: 'real-summary', delta: 'the files' })
    host.emit({ type: 'text_complete', sessionId, turnId: 'real-summary', text: 'Checking the files', isIntermediate: true })
    host.emit({ type: 'tool_start', sessionId, toolUseId: 'actual-tool', turnId: 'real-summary', toolName: 'Read', toolInput: { secret: 'Raw secret value' }, toolIntent: 'Read project notes' })
    host.emit({ type: 'tool_result', sessionId, toolUseId: 'actual-tool', turnId: 'real-summary', toolName: 'Read', result: 'Read result' })
    host.emit({ type: 'text_delta', sessionId, turnId: 'discarded-attempt', delta: 'Discard this' })
    host.emit({ type: 'text_discard', sessionId, turnId: 'discarded-attempt' })
    host.emit({ type: 'text_delta', sessionId, turnId: 'wrong-workspace', delta: 'Wrong attribution' }, 'beta')
    const unbound = await host.createSession('alpha', {})
    host.emit({ type: 'text_delta', sessionId: unbound.id, turnId: 'unbound', delta: 'Unbound session' })
    const snapshot = await service.get('alpha')
    const activity = snapshot.activity!.find(activity => activity.nodeId === 'worker')!
    expect(activity).toMatchObject({ sessionId, taskId: snapshot.state.tasks[0]!.id, status: 'working' })
    expect(activity.entries).toEqual([
      expect.objectContaining({ id: 'text:real-summary', kind: 'thinking', text: 'Checking the files', turnId: 'real-summary', status: 'completed' }),
      expect.objectContaining({ id: 'tool:actual-tool', kind: 'tool', text: 'Read result', toolUseId: 'actual-tool', status: 'completed' }),
    ])
    expect(JSON.stringify(activity)).not.toContain('Raw secret value')
    expect((await service.get('beta')).activity).toEqual([])
    expect(snapshot.state.revision).toBe(initial.state.revision)
    expect(await readFile(join(root, 'alpha', 'super-agent', 'state.json'), 'utf8')).toBe(persisted)
    host.emit({ type: 'text_delta', sessionId, turnId: 'pi-turn-1__thinking0', delta: 'Provider reasoning summary' })
    expect((await service.get('alpha')).activity![0]!.entries.at(-1)).toMatchObject({ kind: 'thinking', text: 'Provider reasoning summary', status: 'running', turnId: 'pi-turn-1__thinking0' })
    for (let index = 0; index < 100; index++) host.emit({ type: 'status', sessionId, message: `${index}: ${'x'.repeat(9_000)}` })
    const bounded = (await service.get('alpha')).activity![0]!
    expect(bounded.entries).toHaveLength(80)
    expect(bounded.entries.every(entry => entry.text.length <= 8_000)).toBe(true)
  })

  test('notifies the coordinator and user, resumes the original permission promise, and keeps the worker serialized', async () => {
    const { host, service, config, advance } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'task', title: 'First', instructions: 'First task' })
    await service.command('alpha', { type: 'task', title: 'Queued', instructions: 'Second task' })
    let snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const sessionId = snapshot.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
    const permission = host.requestPermission(sessionId, { requestId: 'scoped-write', toolName: 'Write', description: 'Write a specific project file',
      reason: 'The node has read access only', command: 'Write notes.md',
      policyScope: { kind: 'file_write', target: 'notes.md', toolName: 'Write', operation: 'Write notes.md', boundary: 'environment', expiresAt: 60_000 } })
    snapshot = await until(() => service.get('alpha'), value => value.permissionRequests?.[0]?.status === 'pending')
    expect(snapshot.activity!.find(item => item.nodeId === 'worker')!.status).toBe('waiting_permission')
    expect(snapshot.state.nodes.find(item => item.nodeId === 'worker')!.status).toBe('working')
    expect(snapshot.state.tasks.map(task => task.status)).toEqual(['running', 'queued'])
    expect(snapshot.state.messages.some(message => message.toNodeId === 'main' && message.body.includes('Write a specific project file'))).toBe(true)
    expect(snapshot.state.messages.some(message => message.toNodeId === 'user' && message.body.includes('waiting for user permission'))).toBe(true)
    await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    const mainSessionId = (await service.get('alpha')).state.nodes.find(node => node.nodeId === 'main')!.sessionId!
    const coordinatorPrompt = host.sends.find(send => send.sessionId === mainSessionId)!.message
    expect(coordinatorPrompt).toContain('Do not approve, bypass permissions')
    expect(coordinatorPrompt).toContain('Target (environment): notes.md')
    expect(coordinatorPrompt).toContain('Requested operation: Write notes.md')
    advance(1_001); await service.tick()
    expect(host.sends.filter(send => send.sessionId === sessionId)).toHaveLength(1)
    snapshot = await service.command('alpha', { type: 'permission-response', requestId: 'scoped-write', allowed: true })
    expect(await permission).toBe(true)
    expect(host.permissionResponses).toEqual([{ sessionId, requestId: 'scoped-write', allowed: true, alwaysAllow: false }])
    expect(snapshot.permissionRequests![0]!.status).toBe('approved')
    expect(snapshot.activity!.find(item => item.nodeId === 'worker')!.status).toBe('working')
    expect(snapshot.state.tasks.map(task => task.status)).toEqual(['running', 'queued'])
    expect(host.sends.filter(send => send.sessionId === sessionId)).toHaveLength(1)
    const denied = host.requestPermission(sessionId, { requestId: 'native-denial', toolName: 'Bash', description: 'Run a command', type: 'bash', command: 'echo test' })
    await until(() => service.get('alpha'), value => value.permissionRequests?.some(item => item.id === 'native-denial' && item.status === 'pending') === true)
    await service.command('alpha', { type: 'permission-response', requestId: 'native-denial', allowed: false })
    expect(await denied).toBe(false)
    expect(host.sends.filter(send => send.sessionId === sessionId)).toHaveLength(1)
    host.complete(sessionId, 'Original task finished')
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'completed' && value.state.tasks[1]?.status === 'running')
    expect(snapshot.state.tasks[0]!.output).toBe('Original task finished')
    expect(host.sends.filter(send => send.sessionId === sessionId)).toHaveLength(2)
  })

  test('never exposes long or incomplete communication JSON when tags cross streaming batches', async () => {
    const { host, service, config } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: 'Plan work' })
    const running = await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    const sessionId = running.state.nodes.find(node => node.nodeId === 'main')!.sessionId!
    host.emit({ type: 'text_delta', sessionId, turnId: 'long-actions', delta: 'Planning the work.\n<super_ag' })
    expect((await service.get('alpha')).activity![0]!.entries[0]!.text).toBe('Planning the work.\n')
    host.emit({ type: 'text_delta', sessionId, turnId: 'long-actions', delta: `ent_actions>{"tasks":[{"instructions":"${'private control data'.repeat(2_000)}"}]}` })
    expect((await service.get('alpha')).activity![0]!.entries[0]!.text).toBe('Planning the work.\n')
    host.emit({ type: 'text_delta', sessionId, turnId: 'long-actions', delta: '</super_agent_' })
    expect((await service.get('alpha')).activity![0]!.entries[0]!.text).toBe('Planning the work.\n')
    host.emit({ type: 'text_delta', sessionId, turnId: 'long-actions', delta: 'actions>\nReady for your review.' })
    expect((await service.get('alpha')).activity![0]!.entries[0]!.text).toBe('Planning the work.\n\nReady for your review.')
    host.emit({ type: 'text_complete', sessionId, turnId: 'incomplete-actions', text: 'Visible summary.\n<super_agent_actions>{"tasks":[{"instructions":"hidden tail' })
    const snapshot = await service.get('alpha')
    expect(snapshot.activity![0]!.entries[1]!.text).toBe('Visible summary.')
    expect(JSON.stringify(snapshot.activity)).not.toContain('private control data')
    expect(JSON.stringify(snapshot.activity)).not.toContain('hidden tail')
  })

  test('reconciles ordinary AppShell responses and does not leak another worker approval into its context', async () => {
    const { host, service, config } = await fixture()
    config.nodes.push({ ...config.nodes[1]!, id: 'other-worker', name: 'Other worker' })
    await service.save('alpha', config)
    await service.command('alpha', { type: 'task', title: 'Private approval', instructions: 'Work', nodeId: 'worker' })
    let snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const sessionId = snapshot.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
    const permission = host.requestPermission(sessionId, { requestId: 'external-ui', toolName: 'Read', description: 'Private approval detail: secret-work-file.txt' })
    await until(() => service.get('alpha'), value => value.permissionRequests?.[0]?.status === 'pending')
    await service.command('alpha', { type: 'task', title: 'Independent task', instructions: 'Work independently', nodeId: 'other-worker' })
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks[1]?.status === 'running')
    const otherSessionId = snapshot.state.nodes.find(node => node.nodeId === 'other-worker')!.sessionId!
    expect(host.sends.find(send => send.sessionId === otherSessionId)!.message).not.toContain('secret-work-file.txt')
    expect(host.respondToPermission(sessionId, 'external-ui', true, false)).toBe(true)
    expect(await permission).toBe(true)
    snapshot = await until(() => service.get('alpha'), value => value.permissionRequests?.[0]?.status === 'approved')
    expect(snapshot.activity!.find(item => item.nodeId === 'worker')!.status).toBe('working')
  })

  test('rejects cross-workspace and stale requests without granting another node session', async () => {
    const { host, service, config } = await fixture()
    await service.save('alpha', config)
    await service.save('beta', config)
    await service.command('alpha', { type: 'task', title: 'Ownership', instructions: 'Work' })
    const running = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const sessionId = running.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
    void host.requestPermission(sessionId, { requestId: 'owned-request', toolName: 'Read', description: 'Read one file' })
    await until(() => service.get('alpha'), value => value.permissionRequests?.[0]?.status === 'pending')
    await expect(service.command('beta', { type: 'permission-response', requestId: 'owned-request', allowed: true })).rejects.toThrow('no longer pending in this workspace')
    expect(host.permissionResponses).toEqual([])
    host.sessions.get(sessionId)!.workspaceId = 'beta'
    await expect(service.command('alpha', { type: 'permission-response', requestId: 'owned-request', allowed: true })).rejects.toThrow('no longer active')
    expect((await service.get('alpha')).permissionRequests![0]!.status).toBe('expired')
    expect(host.permissionResponses).toEqual([])
    host.sessions.get(sessionId)!.workspaceId = 'alpha'
  })

  test('expires exact-operation deadlines and cancelled requests without replaying blocked work', async () => {
    const { host, service, config, advance } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'task', title: 'Expiring task', instructions: 'Work' })
    let snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const sessionId = snapshot.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
    const expired = host.requestPermission(sessionId, { requestId: 'expires', toolName: 'Read', description: 'Specific read',
      policyScope: { kind: 'file_read', toolName: 'Read', target: 'specific.txt', operation: 'Read specific.txt', boundary: 'outside-environment', expiresAt: 2_000 } })
    await until(() => service.get('alpha'), value => value.permissionRequests?.[0]?.status === 'pending')
    advance(1_001); await service.tick()
    expect(await expired).toBe(false)
    expect((await service.get('alpha')).permissionRequests!.find(item => item.id === 'expires')!.status).toBe('expired')
    expect(host.sends.filter(send => send.sessionId === sessionId)).toHaveLength(1)
    const cancelled = host.requestPermission(sessionId, { requestId: 'cancelled', toolName: 'Write', description: 'Native permission request', type: 'file_write' })
    await until(() => service.get('alpha'), value => value.permissionRequests?.some(item => item.id === 'cancelled' && item.status === 'pending') === true)
    await service.command('alpha', { type: 'cancel', taskId: snapshot.state.tasks[0]!.id })
    expect(await cancelled).toBe(false)
    snapshot = await service.get('alpha')
    expect(snapshot.permissionRequests!.find(item => item.id === 'cancelled')!.status).toBe('expired')
    expect(snapshot.state.tasks[0]!.status).toBe('cancelled')
    expect(snapshot.activity?.some(item => item.nodeId === 'worker')).toBe(false)
    await expect(service.command('alpha', { type: 'permission-response', requestId: 'cancelled', allowed: true })).rejects.toThrow('no longer pending')
    host.emit({ type: 'permission_resolved', sessionId, requestId: 'cancelled', allowed: true })
    expect((await service.get('alpha')).permissionRequests!.find(item => item.id === 'cancelled')!.status).toBe('expired')
    expect(host.sends.filter(send => send.sessionId === sessionId)).toHaveLength(1)
  })

  test('cancelling a queued task leaves the same worker original blocked turn and approval active', async () => {
    const { host, service, config } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'task', title: 'Active task', instructions: 'Work' })
    await service.command('alpha', { type: 'task', title: 'Queued task', instructions: 'Later work' })
    let snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const sessionId = snapshot.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
    const permission = host.requestPermission(sessionId, { requestId: 'keep-blocked', toolName: 'Read', description: 'Read one file' })
    await until(() => service.get('alpha'), value => value.permissionRequests?.[0]?.status === 'pending')
    snapshot = await service.command('alpha', { type: 'cancel', taskId: snapshot.state.tasks[1]!.id })
    expect(snapshot.state.tasks.map(task => task.status)).toEqual(['running', 'cancelled'])
    expect(snapshot.state.nodes.find(node => node.nodeId === 'worker')!.activeTaskId).toBe(snapshot.state.tasks[0]!.id)
    expect(snapshot.permissionRequests![0]!.status).toBe('pending')
    expect(snapshot.activity!.find(item => item.nodeId === 'worker')!.status).toBe('waiting_permission')
    expect(host.cancelled).not.toContain(sessionId)
    await service.command('alpha', { type: 'permission-response', requestId: 'keep-blocked', allowed: true })
    expect(await permission).toBe(true)
    expect(host.sends.filter(send => send.sessionId === sessionId)).toHaveLength(1)
  })

  test('reports structural policy failures once and keeps private failure output out of another worker context', async () => {
    const { host, service, config } = await fixture()
    config.nodes.push({ ...config.nodes[1]!, id: 'other-worker', name: 'Other worker' })
    await service.save('alpha', config)
    await service.command('alpha', { type: 'task', title: 'Blocked work', instructions: 'Work', nodeId: 'worker' })
    let snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const sessionId = snapshot.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
    const result = 'Super Agent policy: source "unassigned" is not assigned to this node'
    host.emit({ type: 'tool_result', sessionId, toolName: 'mcp__unassigned__query', toolUseId: 'first-block', isError: true, result })
    host.emit({ type: 'tool_result', sessionId, toolName: 'mcp__unassigned__query', toolUseId: 'repeat-block', isError: true, result })
    snapshot = await service.get('alpha')
    expect(snapshot.permissionRequests).toEqual([])
    expect(snapshot.state.messages.filter(message => message.toNodeId === 'user' && message.body.includes('was blocked from'))).toHaveLength(1)
    expect(snapshot.state.messages.some(message => message.toNodeId === 'main' && message.body.includes('is not assigned to this node'))).toBe(true)
    const mainRunning = await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    const mainSessionId = mainRunning.state.nodes.find(node => node.nodeId === 'main')!.sessionId!
    expect(host.sends.find(send => send.sessionId === mainSessionId)!.message).toContain('Do not bypass the policy, create an approval')
    host.complete(sessionId, 'PRIVATE_FAILURE_SENTINEL', 'error')
    await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'failed')
    await service.command('alpha', { type: 'task', title: 'Independent work', instructions: 'Work', nodeId: 'other-worker' })
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks[1]?.status === 'running')
    const otherSessionId = snapshot.state.nodes.find(node => node.nodeId === 'other-worker')!.sessionId!
    expect(host.sends.find(send => send.sessionId === otherSessionId)!.message).not.toContain('PRIVATE_FAILURE_SENTINEL')
  })
})

describe('Super Agent configuration and scheduling', () => {
  test('requires exactly one coordinator, a worker, unique identifiers and known abilities', async () => {
    const { config } = await fixture()
    expect(() => validateSuperAgentConfig({ ...config, nodes: [config.nodes[0]] })).toThrow()
    expect(() => validateSuperAgentConfig({ ...config, nodes: config.nodes.map(node => ({ ...node, role: 'coordinator' })) })).toThrow('exactly one coordinator')
    expect(() => validateSuperAgentConfig({ ...config, nodes: config.nodes.map(node => ({ ...node, id: 'same' })) })).toThrow('Duplicate')
    expect(() => validateSuperAgentConfig({ ...config, nodes: config.nodes.map(node => ({ ...node, abilityProfileIds: ['missing'] })) })).toThrow('Unknown ability')
  })

  test('stores settings per workspace and returns an unconfigured snapshot', async () => {
    const { root, service, config } = await fixture()
    expect((await service.get('alpha')).config).toBeNull()
    await expect(access(join(root, 'alpha', 'super-agent', 'state.json'))).rejects.toThrow()
    await service.save('alpha', config)
    expect((await service.get('beta')).config).toBeNull()
    const persisted = JSON.parse(await readFile(join(root, 'alpha', 'super-agent', 'state.json'), 'utf8'))
    expect(persisted.config.name).toBe('Test team')
    expect(persisted.pendingTurns).toEqual([])
  })

  test('returns the saved config with an explicit error when retiring old environments fails', async () => {
    const { root, service, config } = await fixture({ onConfigChanged: async () => { throw new Error('Container cannot be stopped') } })
    const snapshot = await service.save('alpha', config)
    expect(snapshot.config!.name).toBe('Test team')
    expect(snapshot.state.messages.some(message => message.body.includes('Settings were saved') && message.body.includes('Container cannot be stopped'))).toBe(true)
    expect((await loadSuperAgentDocument(join(root, 'alpha'))).config!.name).toBe('Test team')
  })

  test('serializes worker turns, reuses its model session and respects its rate limit', async () => {
    const { host, service, config, advance } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'task', title: 'First', instructions: 'First task', nodeId: 'worker' })
    await service.command('alpha', { type: 'task', title: 'Second', instructions: 'Second task', nodeId: 'worker' })
    let snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const workerSession = snapshot.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
    expect(snapshot.state.tasks[0]!.sessionId).toBe(workerSession)
    expect(snapshot.state.tasks[1]!.status).toBe('queued')
    expect(host.sends.filter(send => send.sessionId === workerSession)).toHaveLength(1)
    host.complete(workerSession, 'First result')
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'completed')
    expect(snapshot.state.tasks[1]!.status).toBe('queued')
    advance(1_001); await service.tick()
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks[1]?.status === 'running')
    expect(snapshot.state.nodes.find(node => node.nodeId === 'worker')!.sessionId).toBe(workerSession)
    expect(host.sends.filter(send => send.sessionId === workerSession)).toHaveLength(2)
    const mainSession = snapshot.state.nodes.find(node => node.nodeId === 'main')!.sessionId!
    expect(host.policies.get(mainSession)!.writeFiles).toBe(false)
    expect(host.policies.get(mainSession)!.runPrograms).toBe(false)
    expect(host.policies.get(workerSession)!.allowSubagents).toBe(false)
  })

  test('fails closed when the session host cannot enforce node permissions', async () => {
    const { service, config } = await fixture({ policy: false })
    await service.save('alpha', config)
    expect((await service.get('alpha')).environment.available).toBe(false)
    await service.command('alpha', { type: 'task', title: 'Unauthorized', instructions: 'Cannot run' })
    const result = await until(() => service.get('alpha'), snapshot => snapshot.state.tasks[0]?.status === 'failed')
    expect(result.state.tasks[0]!.error).toContain('tool permissions')
  })

  test('coordinator output can dispatch a worker; workers cannot create more tasks', async () => {
    const { host, service, config } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: 'Please research this' })
    let snapshot = await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    host.complete(snapshot.state.nodes.find(node => node.nodeId === 'main')!.sessionId!, 'Delegating.\n<super_agent_actions>{"tasks":[{"title":"Research","instructions":"Research the request","nodeId":"worker"}]}</super_agent_actions>')
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    host.complete(snapshot.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!, 'Result\n<super_agent_actions>{"tasks":[{"title":"Illegal","instructions":"Delegate more work"}]}</super_agent_actions>')
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'completed')
    expect(snapshot.state.tasks).toHaveLength(1)
    expect(snapshot.state.messages.some(message => message.body.includes('Only the coordinator'))).toBe(true)
  })

  test('shared board rejects stale item revisions', async () => {
    const { service, config } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'board-upsert', item: { id: 'result', title: 'Result', content: 'First' }, expectedRevision: 0 })
    await expect(service.command('alpha', { type: 'board-upsert', item: { id: 'result', title: 'Result', content: 'Stale' }, expectedRevision: 0 })).rejects.toThrow('revision 1')
    expect((await service.get('alpha')).state.board[0]!.content).toBe('First')
    await service.command('alpha', { type: 'board-upsert', item: { id: 'result', title: 'Result', content: 'Current' }, expectedRevision: 1 })
    expect((await service.get('alpha')).state.board[0]!.revision).toBe(2)
  })

  test('a late completion cannot resurrect a cancelled task', async () => {
    const { host, service, config } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'task', title: 'Cancelable', instructions: 'Run until stopped' })
    const snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const session = snapshot.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
    await service.command('alpha', { type: 'cancel', taskId: snapshot.state.tasks[0]!.id })
    host.complete(session, 'Late result')
    expect((await service.get('alpha')).state.tasks[0]!.status).toBe('cancelled')
    expect(host.cancelled).toContain(session)
  })

  test('reports cancellation failure and allows a later stop retry', async () => {
    const { host, service, config } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'task', title: 'Stop failure', instructions: 'Perform the task' })
    const snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const original = host.cancelProcessing.bind(host)
    host.cancelProcessing = async () => { throw new Error('Backend refused to stop') }
    let cancelled = await service.command('alpha', { type: 'cancel', taskId: snapshot.state.tasks[0]!.id })
    expect(cancelled.state.tasks[0]!.status).toBe('cancelled')
    expect(cancelled.state.nodes.find(node => node.nodeId === 'worker')!.status).toBe('working')
    expect(cancelled.state.nodes.find(node => node.nodeId === 'worker')!.error).toContain('Failed to stop')
    host.cancelProcessing = original
    cancelled = await service.command('alpha', { type: 'cancel' })
    expect(cancelled.state.nodes.find(node => node.nodeId === 'worker')!.status).toBe('idle')
  })

  test('environment preparation keeps polling and cancellation responsive and prevents a cancelled send', async () => {
    const { host, service, config } = await fixture()
    let release!: () => void
    let entered!: () => void
    const preparation = new Promise<void>(resolve => { release = resolve })
    const entry = new Promise<void>(resolve => { entered = resolve })
    host.applySessionPolicy = async (sessionId, policy) => { host.policies.set(sessionId, policy); entered(); await preparation }
    try {
      await service.save('alpha', config)
      await service.command('alpha', { type: 'task', title: 'Cold start', instructions: 'Wait for the environment' })
      await entry
      const preparing = await service.get('alpha')
      expect(preparing.state.nodes.find(node => node.nodeId === 'worker')!.status).toBe('preparing')
      expect(preparing.state.tasks[0]!.status).toBe('queued')
      const cancelled = await service.command('alpha', { type: 'cancel', taskId: preparing.state.tasks[0]!.id })
      expect(cancelled.state.tasks[0]!.status).toBe('cancelled')
      release(); await new Promise<void>(resolve => setTimeout(resolve, 20))
      expect(host.sends).toHaveLength(0)
    } finally { release() }
  })

  test('broadcasts once to each other node without messaging the sender', async () => {
    const { host, service, config } = await fixture()
    config.nodes.push({ ...config.nodes[1]!, id: 'second', name: 'Second' })
    await service.save('alpha', config)
    await service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'all', body: 'Team update' })
    const snapshot = await until(() => service.get('alpha'), value => value.state.nodes.filter(node => node.status === 'working').length === 2)
    expect(snapshot.state.nodes.find(node => node.nodeId === 'main')!.status).toBe('idle')
    expect(host.sends).toHaveLength(2)
    expect(snapshot.state.messages.filter(message => message.toNodeId === 'all')).toHaveLength(1)
  })

  test('requires explicit per-node source bindings inside the team source pool', async () => {
    const { host, service, config } = await fixture()
    config.sourceSlugs = ['private', 'research']; config.nodes[1]!.sourceSlugs = ['research']
    await service.save('alpha', config)
    await service.command('alpha', { type: 'task', title: 'Source check', instructions: 'Use your assigned sources' })
    const snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const worker = snapshot.state.nodes.find(node => node.nodeId === 'worker')!
    expect(host.options.get(worker.sessionId!)!.enabledSourceSlugs).toEqual(['research'])
    expect(host.policies.get(worker.sessionId!)!.allowSources).toEqual(['research'])
    expect(() => validateSuperAgentConfig({ ...config, sourceSlugs: ['private'] })).toThrow('authorization pool')
  })

  test('workers receive their own direct messages and outputs plus the shared board', async () => {
    const { host, service, config } = await fixture()
    config.nodes.push({ ...config.nodes[1]!, id: 'private-worker', name: 'Private worker' })
    config.sourceSlugs = ['private']; config.nodes[2]!.sourceSlugs = ['private']
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: 'USER_PRIVATE_SENTINEL' })
    await until(() => service.get('alpha'), snapshot => snapshot.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    await service.command('alpha', { type: 'task', title: 'Private task', instructions: 'Use the private source', nodeId: 'private-worker' })
    let snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    host.complete(snapshot.state.tasks[0]!.sessionId!, 'PRIVATE_RESULT_SENTINEL')
    await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'completed')
    await service.command('alpha', { type: 'board-upsert', item: { title: 'Shared', content: 'SHARED_PUBLIC_VALUE' } })
    await service.command('alpha', { type: 'task', title: 'Public task', instructions: 'Use only shared material', nodeId: 'worker' })
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks[1]?.status === 'running')
    const prompt = host.sends.find(send => send.sessionId === snapshot.state.tasks[1]!.sessionId)!.message
    expect(prompt).not.toContain('USER_PRIVATE_SENTINEL')
    expect(prompt).not.toContain('PRIVATE_RESULT_SENTINEL')
    expect(prompt).toContain('SHARED_PUBLIC_VALUE')
  })

  test('coordinator user chat takes priority over a queued inspection', async () => {
    const { host, service, config, advance } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: 'First user message' })
    const snapshot = await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    const sessionId = snapshot.state.nodes.find(node => node.nodeId === 'main')!.sessionId!
    await service.command('alpha', { type: 'inspect' })
    await service.command('alpha', { type: 'chat', text: 'Second user message' })
    host.complete(sessionId, 'First reply'); await service.get('alpha')
    advance(1_001); await service.tick()
    await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    expect(host.sends[host.sends.length - 1]!.message.startsWith('Second user message')).toBe(true)
  })

  test('bounds model-to-model message chains', async () => {
    const { host, service, config, advance } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'worker', body: 'Start a conversation' })
    for (let hop = 0; hop <= 6; hop++) {
      const snapshot = await until(() => service.get('alpha'), value => value.state.nodes.some(node => node.status === 'working'))
      const active = snapshot.state.nodes.find(node => node.status === 'working')!
      const recipient = active.nodeId === 'worker' ? 'main' : 'worker'
      host.complete(active.sessionId!, `<super_agent_actions>{"messages":[{"toNodeId":"${recipient}","body":"Another reply"}]}</super_agent_actions>`)
      await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === active.nodeId)?.status !== 'working')
      advance(1_001); await service.tick()
    }
    const snapshot = await service.get('alpha')
    expect(host.sends).toHaveLength(7)
    expect(snapshot.state.messages.some(message => message.body.includes('chain limit'))).toBe(true)
  })

  test('caps a branching communication chain at 32 total model turns', async () => {
    const { host, service, config, advance } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'message', fromNodeId: 'main', toNodeId: 'worker', body: 'Start a conversation' })
    for (let round = 0; round < 100; round++) {
      const snapshot = await service.get('alpha')
      const working = snapshot.state.nodes.filter(node => node.status === 'working')
      for (const active of working) {
        const recipient = active.nodeId === 'worker' ? 'main' : 'worker'
        host.complete(active.sessionId!, `<super_agent_actions>{"messages":[{"toNodeId":"${recipient}","body":"Reply A"},{"toNodeId":"${recipient}","body":"Reply B"}]}</super_agent_actions>`)
      }
      advance(1_001); await service.tick()
      const document = await loadSuperAgentDocument(join(fixtures[fixtures.length - 1]!.root, 'alpha'))
      if (!document.pendingTurns.length) break
    }
    expect(host.sends).toHaveLength(32)
    expect((await service.get('alpha')).state.messages.some(message => message.body.includes('call budget'))).toBe(true)
  })

  test('idle coordinator checks summarize changed work once without inventing tasks', async () => {
    const { host, service, config, advance } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'task', title: 'Work', instructions: 'Perform the requested work' })
    let snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    host.complete(snapshot.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!, 'Done')
    snapshot = await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    const coordinator = snapshot.state.nodes.find(node => node.nodeId === 'main')!.sessionId!
    host.complete(coordinator, 'Result assembled'); await service.get('alpha')
    advance(60_001); await service.tick()
    snapshot = await until(() => service.get('alpha'), value => value.state.nodes.find(node => node.nodeId === 'main')?.status === 'working')
    expect(host.sends[host.sends.length - 1]!.message).toContain('Inspect worker and script statuses')
    expect(snapshot.state.lastInspectionAt).toBe(61_001)
    host.complete(coordinator, 'No blocked work'); await service.get('alpha')
    const count = host.sends.length; advance(60_001); await service.tick(); await service.get('alpha')
    expect(host.sends).toHaveLength(count)
    expect((await service.get('alpha')).state.tasks).toHaveLength(1)
  })

  test('does not replay interrupted turns after a restart', async () => {
    const { root, host, service, config } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'task', title: 'Side effect', instructions: 'Perform work once' })
    await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const restartedHost = new Host()
    const restarted = new SuperAgentService({ host: restartedHost, rootForWorkspace: workspaceId => join(root, workspaceId), autoTick: false })
    try {
      const snapshot = await restarted.get('alpha')
      expect(snapshot.state.tasks[0]!.status).toBe('failed')
      expect(snapshot.state.tasks[0]!.error).toContain('interrupted')
      expect(restartedHost.sends).toHaveLength(0)
      expect(host.sends).toHaveLength(1)
    } finally { await restarted.cleanup() }
  })
})

describe('managed scripts', () => {
  test('a disconnected remote CLI is untracked when stopping the actual executor cannot be confirmed', async () => {
    const { workingDirectory, service, config } = await fixture({
      resolveEnvironment: async (_workspaceId, environment) => ({ workingDirectory: environment.workingDirectory, status: { available: true, isolation: 'container', detail: 'Injected container executor' } }),
      spawnScript: async ({ path, resolved }) => ({
        child: spawn(process.execPath, [path], { cwd: resolved.workingDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false }),
        stop: async () => { throw new Error('Container daemon is unreachable') },
      }),
    })
    await writeFile(join(workingDirectory, 'disconnected.cjs'), 'console.error("simulated CLI disconnect"); process.exit(1)')
    config.environment.kind = 'sandbox'; config.environment.sandbox = { runtime: 'docker', image: 'test-executor' }
    config.scripts = [{ id: 'disconnected', name: 'Disconnected', path: 'disconnected.cjs', args: [], timeoutSeconds: 10 }]
    await service.save('alpha', config)
    await service.command('alpha', { type: 'script-run', scriptId: 'disconnected' })
    const snapshot = await until(() => service.get('alpha'), value => value.state.scripts[0]?.status === 'untracked')
    expect(snapshot.state.scripts[0]!.exitCode).toBe(1)
    expect(snapshot.state.scripts[0]!.error).toContain('could not be confirmed stopped')
    expect(snapshot.state.scripts[0]!.error).toContain('Container daemon is unreachable')
    await expect(service.command('alpha', { type: 'script-run', scriptId: 'disconnected' })).rejects.toThrow('untracked')
  })

  test('workers can register their generated script for monitoring but cannot run it on the host', async () => {
    const { workingDirectory, host, service, config } = await fixture()
    await writeFile(join(workingDirectory, 'generated.cjs'), 'console.log("generated")')
    await service.save('alpha', config)
    await service.command('alpha', { type: 'task', title: 'Create script', instructions: 'Create and register a script' })
    let snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    host.complete(snapshot.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!, 'Created it\n<super_agent_actions>{"registerScripts":[{"id":"generated","name":"Generated","path":"generated.cjs","args":[],"timeoutSeconds":60}],"runScripts":["generated"]}</super_agent_actions>')
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'completed')
    expect(snapshot.config!.scripts[0]!.nodeId).toBe('worker')
    expect(snapshot.state.scripts[0]!.status).toBe('idle')
    expect(snapshot.state.scripts[0]!.sha256).toHaveLength(64)
    expect(snapshot.state.messages.some(message => message.body.includes('must be started by the user'))).toBe(true)
    await service.command('alpha', { type: 'script-run', scriptId: 'generated' })
    snapshot = await until(() => service.get('alpha'), value => value.state.scripts[0]?.status === 'completed')
    expect(snapshot.state.scripts[0]!.output).toContain('generated')
  })

  test('executes a real registered script without forwarding provider secrets', async () => {
    const { workingDirectory, service, config } = await fixture()
    process.env.SUPER_AGENT_TEST_SECRET = 'not-for-children'
    try {
      await writeFile(join(workingDirectory, 'check.cjs'), 'console.log("script-ok:" + (process.env.SUPER_AGENT_TEST_SECRET === undefined))')
      config.scripts = [{ id: 'check', name: 'Check', path: 'check.cjs', args: [], nodeId: 'worker', timeoutSeconds: 10 }]
      await service.save('alpha', config)
      await service.command('alpha', { type: 'script-run', scriptId: 'check' })
      const snapshot = await until(() => service.get('alpha'), value => value.state.scripts[0]?.status === 'completed')
      expect(snapshot.state.scripts[0]!.exitCode).toBe(0)
      expect(snapshot.state.scripts[0]!.output).toContain('script-ok:true')
      expect(snapshot.state.messages.some(message => message.kind === 'script' && message.body.includes('completed'))).toBe(true)
    } finally { delete process.env.SUPER_AGENT_TEST_SECRET }
  })

  test('script paths and symlinks cannot escape the registered folder', async () => {
    const { root, workingDirectory, service, config } = await fixture()
    const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'escape.cjs'), 'console.log("escape")')
    config.scripts = [{ id: 'escape', name: 'Escape', path: '../outside/escape.cjs', args: [], timeoutSeconds: 10 }]
    await service.save('alpha', config)
    await expect(service.command('alpha', { type: 'script-run', scriptId: 'escape' })).rejects.toThrow('inside')
    await symlink(outside, join(workingDirectory, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    config.scripts[0]!.path = 'link/escape.cjs'; await service.save('alpha', config)
    await expect(service.command('alpha', { type: 'script-run', scriptId: 'escape' })).rejects.toThrow('symlinks')
  })

  test('host scripts cannot bypass a disabled capability', async () => {
    const { workingDirectory, service, config } = await fixture()
    await writeFile(join(workingDirectory, 'check.cjs'), 'console.log("must not run")')
    config.scripts = [{ id: 'check', name: 'Check', path: 'check.cjs', args: [], timeoutSeconds: 10 }]
    config.environment.permissions.writeFiles = false
    await service.save('alpha', config)
    await expect(service.command('alpha', { type: 'script-run', scriptId: 'check' })).rejects.toThrow('all file')
  })

  test('watches changes and synchronizes status without restarting a script', async () => {
    const { workingDirectory, service, config, advance } = await fixture()
    const path = join(workingDirectory, 'check.cjs'); await writeFile(path, 'console.log("first")')
    config.scripts = [{ id: 'check', name: 'Check', path: 'check.cjs', args: [], nodeId: 'worker', timeoutSeconds: 10 }]
    await service.save('alpha', config)
    advance(5_000); await service.tick()
    const originalHash = (await service.get('alpha')).state.scripts[0]!.sha256
    await writeFile(path, 'console.log("changed")'); advance(5_000); await service.tick()
    const snapshot = await service.get('alpha')
    expect(snapshot.state.scripts[0]!.sha256).not.toBe(originalHash)
    expect(snapshot.state.scripts[0]!.status).toBe('idle')
    expect(snapshot.state.messages.some(message => message.body.includes('not been restarted'))).toBe(true)
  })

  test('stops a real script process and records its completion', async () => {
    const { workingDirectory, service, config } = await fixture()
    await writeFile(join(workingDirectory, 'long.cjs'), 'setInterval(() => {}, 1000)')
    config.scripts = [{ id: 'long', name: 'Long running', path: 'long.cjs', args: [], timeoutSeconds: 10 }]
    await service.save('alpha', config)
    await service.command('alpha', { type: 'script-run', scriptId: 'long' })
    await service.command('alpha', { type: 'script-stop', scriptId: 'long' })
    const snapshot = await until(() => service.get('alpha'), value => value.state.scripts[0]?.exitCode != null)
    expect(snapshot.state.scripts[0]!.status).toBe('stopped')
  })

  test('untracked processes after a crash are reported honestly and cannot be relaunched', async () => {
    const { root, workingDirectory, service, config } = await fixture()
    await writeFile(join(workingDirectory, 'check.cjs'), 'console.log("do not duplicate")')
    config.scripts = [{ id: 'check', name: 'Check', path: 'check.cjs', args: [], timeoutSeconds: 10 }]
    await service.save('alpha', config)
    const document = await loadSuperAgentDocument(join(root, 'alpha'))
    document.state.scripts[0]!.status = 'running'; await saveSuperAgentDocument(join(root, 'alpha'), document)
    const restarted = new SuperAgentService({ host: new Host(), rootForWorkspace: workspaceId => join(root, workspaceId), autoTick: false })
    try {
      const snapshot = await restarted.get('alpha')
      expect(snapshot.state.scripts[0]!.status).toBe('untracked')
      expect(snapshot.state.scripts[0]!.error).toContain('may still be running')
      await expect(restarted.command('alpha', { type: 'script-run', scriptId: 'check' })).rejects.toThrow('untracked')
    } finally { await restarted.cleanup() }
  })
})
