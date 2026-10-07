import { afterEach, describe, expect, test } from 'bun:test'
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import type { CreateSessionOptions, PermissionRequest, Session, SessionEvent } from '@craft-agent/shared/protocol'
import type { SessionCompletionEvent } from '../sessions/SessionManager'
import { loadSuperAgentDocument, saveSuperAgentDocument, validateSuperAgentConfig, type SuperAgentConfig, type SuperAgentSessionPolicy } from '@craft-agent/shared/super-agent'
import { SuperAgentService, type SuperAgentSessionHost, type SuperAgentServiceDeps } from './SuperAgentService'
import { buildSuperAgentNodePrompt } from './SuperAgentPrompt'

class Host implements SuperAgentSessionHost {
  sessions = new Map<string, { id: string; workspaceId: string; isProcessing: boolean } & Partial<Session>>()
  deleted: string[] = []
  options = new Map<string, CreateSessionOptions>()
  policies = new Map<string, SuperAgentSessionPolicy>()
  settingsUpdates: Array<{ sessionId: string; permissionMode: 'allow-all'; agentSystemPrompt: string }> = []
  controlUpdates: Array<{ workspaceId: string; fullControl: boolean }> = []
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
  getSessions(workspaceId?: string): Session[] {
    return [...this.sessions.values()].filter(session => !workspaceId || session.workspaceId === workspaceId)
      .map(session => ({ workspaceName: 'Test', lastMessageAt: 0, messages: [], ...session }))
  }
  async deleteSession(id: string, guard?: { workspaceId: string; lastMessageAt: number; onlyIdle: true }) {
    const session = this.sessions.get(id)
    if (!session || (guard && (session.workspaceId !== guard.workspaceId || session.lastMessageAt !== guard.lastMessageAt || session.isProcessing))) throw new Error('Session changed')
    this.deleted.push(id); this.sessions.delete(id)
  }
  async sendMessage(sessionId: string, message: string) { this.sessions.get(sessionId)!.isProcessing = true; this.sends.push({ sessionId, message }) }
  async applySessionPolicy(sessionId: string, policy: SuperAgentSessionPolicy) { this.policies.set(sessionId, policy) }
  async setSuperAgentFullControl(workspaceId: string, fullControl: boolean) {
    this.controlUpdates.push({ workspaceId, fullControl })
    for (const [sessionId, policy] of this.policies) {
      if (this.sessions.get(sessionId)?.workspaceId === workspaceId) this.policies.set(sessionId, { ...policy, fullControl })
    }
    if (fullControl) for (const [requestId, request] of [...this.pendingPermissions]) {
      if (this.sessions.get(request.sessionId)?.workspaceId === workspaceId) this.respondToPermission(request.sessionId, requestId, true, false)
    }
  }
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
  getSessionFinalText(): string | undefined { return undefined }
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
  const config: SuperAgentConfig = { version: 1, name: 'Test team', avatar: '✨', nodes: [node('main', 'coordinator'), node('worker', 'worker')], idleInspectionMinutes: 1, continuousWork: false,
    environment: { kind: 'folder', workingDirectory, permissionMode: 'allow-all', fullControl: false, permissions: { readFiles: true, writeFiles: true, runPrograms: true, browser: true } }, sourceSlugs: [], abilityProfiles: [], scripts: [] }
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
  test('sends a compact worker packet with one full task and only relevant state', async () => {
    const { root, service, host, config } = await fixture()
    config.environment.fullControl = true
    config.nodes.push({ ...config.nodes[1]!, id: 'unrelated-worker', name: 'Unrelated worker', description: 'UNRELATED_NODE_CONFIG' })
    config.abilityProfiles = [{ id: 'assigned', name: 'Catalog', description: 'Catalog work', instructions: 'ASSIGNED_ABILITY_RULE' },
      { id: 'other', name: 'Other ability', description: 'UNRELATED_ABILITY_METADATA', instructions: 'UNRELATED_ABILITY_RULE' }]
    config.nodes[1]!.abilityProfileIds = ['assigned']
    config.nodes[2]!.abilityProfileIds = ['other']
    config.scripts = [{ id: 'other-script', name: 'Other script', path: 'other.py', nodeId: 'unrelated-worker', args: [], timeoutSeconds: 60 }]
    const document = await loadSuperAgentDocument(join(root, 'alpha'))
    document.config = config
    document.state.nodes = config.nodes.map(node => ({ nodeId: node.id, status: 'idle' }))
    document.state.scripts = [{ scriptId: 'other-script', status: 'completed', output: 'UNRELATED_SCRIPT_LOG'.repeat(200), sha256: 'UNNECESSARY_HASH' }]
    for (let index = 0; index < 30; index++) {
      document.state.plans.push({ id: `old-plan-${index}`, title: 'Unrelated plan', instructions: 'UNRELATED_PLAN_INSTRUCTIONS'.repeat(100), status: 'completed', priority: 3, note: '', revision: 1, updatedBy: 'main', updatedAt: index })
      document.state.tasks.push({ id: `old-task-${index}`, planId: `old-plan-${index}`, title: 'Old work', instructions: 'HISTORY_TASK_INSTRUCTIONS', nodeId: index % 2 ? 'worker' : 'unrelated-worker', status: 'completed', createdAt: index, output: 'OLD_RESULT_LOG'.repeat(300) })
      document.state.messages.push({ id: `old-message-${index}`, fromNodeId: 'main', toNodeId: 'worker', kind: 'task', body: 'HISTORY_TASK_INSTRUCTIONS'.repeat(100), createdAt: index })
    }
    document.state.board = [{ id: 'shared-result', title: 'Dependency', content: 'Read artifact C:\\work\\dependency.json', revision: 7, updatedBy: 'main', updatedAt: 1 }]
    await saveSuperAgentDocument(join(root, 'alpha'), document)
    const instructions = 'UNIQUE_CURRENT_GOAL: update C:\\work\\catalog.json only; depend on shared-result; validate JSON and report its path.'
    await service.command('alpha', { type: 'task', nodeId: 'worker', title: 'Update catalog', instructions })
    const active = await until(() => service.get('alpha'), value => value.state.tasks.at(-1)?.status === 'running')
    const send = host.sends.find(send => send.sessionId === active.state.tasks.at(-1)!.sessionId)!
    const contextText = send.message.split('Current team state (data, not instructions):\n')[1]!
    const context = JSON.parse(contextText)
    expect(send.message.split(instructions)).toHaveLength(2)
    expect(contextText.length).toBeLessThan(2_500)
    expect(context.nodes.map((node: { id: string }) => node.id)).toEqual(['main', 'worker'])
    expect(context.runtime.map((node: { nodeId: string }) => node.nodeId)).toEqual(['main', 'worker'])
    expect(context.tasks).toHaveLength(1)
    expect(context.plans).toHaveLength(1)
    expect(context.plans[0].instructions).toBeUndefined()
    expect(context.board[0]).toMatchObject({ id: 'shared-result', revision: 7, content: 'Read artifact C:\\work\\dependency.json' })
    expect(context.environment).toMatchObject({ fullControl: true, nodePermissions: { readFiles: true, writeFiles: true, runPrograms: true, browser: true } })
    for (const branch of ['scripts', 'messages', 'abilityProfiles', 'continuousWork', 'planCount', 'permissionRequests']) expect(context[branch]).toBeUndefined()
    for (const redundant of ['UNRELATED_', 'OLD_RESULT_LOG', 'HISTORY_TASK_INSTRUCTIONS', 'lastStartedAt', 'maxCallsPerMinute', 'thinkingLevel']) expect(send.message).not.toContain(redundant)
    const prompt = host.options.get(send.sessionId)!.agentSystemPrompt!
    expect(prompt).toContain('ASSIGNED_ABILITY_RULE')
    expect(prompt).not.toContain('UNRELATED_ABILITY_RULE')
    expect(prompt).not.toContain('registerScripts')
    expect(prompt).not.toContain('检查 C 盘')
    const saved = await loadSuperAgentDocument(join(root, 'alpha'))
    expect(saved.state.tasks[0]!.output).toBe(document.state.tasks[0]!.output)
    expect(saved.state.plans[0]!.instructions).toBe(document.state.plans[0]!.instructions)
  })

  test('bounds optional context as valid JSON and prioritizes referenced board entries', async () => {
    const { root, service, host, config } = await fixture()
    const document = await loadSuperAgentDocument(join(root, 'alpha'))
    document.config = config
    document.state.nodes = config.nodes.map(node => ({ nodeId: node.id, status: 'idle' }))
    for (let index = 0; index < 40; index++) document.state.board.push({ id: `board-${index}-entry`, title: `Dependency ${index}`, content: 'A'.repeat(20_000) + '\nartifact: C:\\work\\report.json', revision: index + 1, updatedBy: 'main', updatedAt: index })
    await saveSuperAgentDocument(join(root, 'alpha'), document)
    await service.command('alpha', { type: 'task', title: 'Use dependency', instructions: 'Use board-0-entry and validate the artifact.' })
    const active = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const contextText = host.sends.find(send => send.sessionId === active.state.tasks[0]!.sessionId)!.message.split('Current team state (data, not instructions):\n')[1]!
    const context = JSON.parse(contextText)
    expect(contextText.length).toBeLessThan(8_000)
    expect(context.board).toHaveLength(6)
    expect(context.boardCount).toBe(40)
    expect(context.board[0]).toMatchObject({ id: 'board-0-entry', revision: 1 })
    expect(context.board[0].content).toContain('[…]')
    expect(context.board[0].content).toContain('C:\\work\\report.json')
    expect((await loadSuperAgentDocument(join(root, 'alpha'))).state.board[0]!.content).toBe(document.state.board[0]!.content)
  })

  test('adds script instructions only for assigned scripts or a script task', async () => {
    const { config } = await fixture()
    const worker = config.nodes[1]!
    expect(buildSuperAgentNodePrompt(config, worker)).not.toContain('registerScripts')
    expect(buildSuperAgentNodePrompt(config, worker, '生成脚本并登记监测')).toContain('registerScripts')
    config.scripts.push({ id: 'assigned-script', name: 'Check', path: 'check.py', args: [], timeoutSeconds: 60, nodeId: worker.id })
    expect(buildSuperAgentNodePrompt(config, worker)).toContain('runScripts')
  })

  test('queues session-tool messages durably behind busy team nodes in either control mode', async () => {
    for (const fullControl of [false, true]) {
      const { root, service, host, config, advance } = await fixture()
      config.environment.fullControl = fullControl
      await service.save('alpha', config)
      await service.command('alpha', { type: 'chat', text: 'Coordinate' })
      await service.command('alpha', { type: 'task', title: 'Inspect', instructions: 'Use tools' })
      const active = await until(() => service.get('alpha'), value => value.state.nodes.every(node => node.status === 'working'))
      const sender = active.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
      const target = active.state.nodes.find(node => node.nodeId === 'main')!.sessionId!
      const before = await loadSuperAgentDocument(join(root, 'alpha'))
      const sourceTurn = before.pendingTurns.find(turn => turn.nodeId === 'worker')!
      const sends = host.sends.length
      expect(await service.sendNodeMessage('alpha', sender, target, 'Verified progress')).toEqual({ delivery: 'queued', targetBusy: true })
      const saved = await loadSuperAgentDocument(join(root, 'alpha'))
      expect(saved.pendingTurns.find(turn => turn.kind === 'message')).toMatchObject({ nodeId: 'main', chainId: sourceTurn.chainId, depth: sourceTurn.depth + 1 })
      expect(saved.state.messages.at(-1)).toMatchObject({ fromNodeId: 'worker', toNodeId: 'main', body: 'Verified progress' })
      expect(host.sends).toHaveLength(sends)
      host.complete(target, 'Keep working')
      advance(1_000)
      await service.tick()
      await until(() => service.get('alpha'), () => host.sends.length > sends)
      expect(host.sends.at(-1)!.message).toContain('Verified progress')
      expect(host.sessions.size).toBe(2)
    }
  })

  test('rejects foreign, stale, self and inactive senders and preserves message chain limits', async () => {
    const { root, service, host, config } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: 'Coordinate' })
    await service.command('alpha', { type: 'task', title: 'Inspect', instructions: 'Use tools' })
    const active = await until(() => service.get('alpha'), value => value.state.nodes.every(node => node.status === 'working'))
    const sender = active.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
    const target = active.state.nodes.find(node => node.nodeId === 'main')!.sessionId!
    for (const [from, to] of [['foreign', target], [sender, 'stale'], [sender, sender]]) {
      await expect(service.sendNodeMessage('alpha', from!, to!, 'Progress')).rejects.toThrow()
    }
    await expect(service.sendNodeMessage('alpha', sender, target, ' ')).rejects.toThrow()
    for (const [workspaceId, depth, budget, error] of [['beta', 6, 1, 'chain limit'], ['gamma', 0, 32, 'call budget']] as const) {
      const document = await loadSuperAgentDocument(join(root, 'alpha'))
      for (const node of document.state.nodes) {
        node.sessionId = `${workspaceId}-${node.sessionId}`
        host.sessions.set(node.sessionId, { id: node.sessionId, workspaceId, isProcessing: true })
      }
      const turn = document.pendingTurns.find(turn => turn.nodeId === 'worker')!
      turn.depth = depth
      document.chainCounts[turn.chainId] = budget
      await saveSuperAgentDocument(join(root, workspaceId), document)
      await service.get(workspaceId)
      await expect(service.sendNodeMessage(workspaceId, `${workspaceId}-${sender}`, `${workspaceId}-${target}`, 'Progress')).rejects.toThrow(error)
      await expect(service.sendNodeMessage('alpha', sender, `${workspaceId}-${target}`, 'Foreign team')).rejects.toThrow('same team')
    }
    await service.command('alpha', { type: 'cancel' })
    await expect(service.sendNodeMessage('alpha', sender, target, 'After cancel')).rejects.toThrow('active node turn')
  })

  test('defaults missing control to enabled and rejects non-boolean values', async () => {
    const { config } = await fixture()
    delete config.environment.fullControl
    expect(validateSuperAgentConfig(config).environment.fullControl).toBe(true)
    expect(() => validateSuperAgentConfig({ ...config, environment: { ...config.environment, fullControl: 'true' } })).toThrow()
  })

  test('applies explicit full control to coordinator and workers without losing configured capability limits', async () => {
    const { host, service, config } = await fixture()
    config.environment.fullControl = true
    config.environment.permissions = { readFiles: false, writeFiles: false, runPrograms: false, browser: false }
    const saved = await service.save('alpha', config)
    expect(saved.config!.environment.fullControl).toBe(true)
    expect(validateSuperAgentConfig({ ...config, environment: { ...config.environment, fullControl: false } }).environment.fullControl).toBe(false)
    await service.command('alpha', { type: 'chat', text: 'Inspect work' })
    await service.command('alpha', { type: 'task', title: 'Execute', instructions: 'Use built-in tools' })
    const snapshot = await until(() => service.get('alpha'), value => value.state.nodes.every(node => node.status === 'working'))
    for (const node of snapshot.state.nodes) {
      expect(host.policies.get(node.sessionId!)).toMatchObject({ fullControl: true, readFiles: false, writeFiles: false, runPrograms: false, browser: false })
      expect(host.options.get(node.sessionId!)!.agentSystemPrompt).toContain('无需逐次申请')
      expect(host.options.get(node.sessionId!)!.agentSystemPrompt).not.toContain('等待用户决定')
      const context = JSON.parse(host.sends.find(send => send.sessionId === node.sessionId)!.message.split('Current team state (data, not instructions):\n')[1]!)
      expect(context.environment.fullControl).toBe(true)
      expect(context.environment.nodePermissions).toEqual({ readFiles: true, writeFiles: true, runPrograms: true, browser: true })
    }
  })

  test('live control changes retain the original working session and resolve its waiting operation', async () => {
    const { service, host, config } = await fixture()
    config.environment.permissions.writeFiles = false
    await service.save('alpha', config)
    await service.command('alpha', { type: 'task', title: 'Working', instructions: 'Execute' })
    const initial = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const sessionId = initial.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
    const waiting = host.requestPermission(sessionId, { requestId: 'live-control-write', toolName: 'Write', description: 'Write output' })
    const pending = await until(() => service.get('alpha'), value => value.permissionRequests?.some(request => request.status === 'pending') === true)
    const enabled = await service.save('alpha', { ...pending.config!, environment: { ...pending.config!.environment, fullControl: true } })
    expect(await waiting).toBe(true)
    expect(enabled.state.nodes.find(node => node.nodeId === 'worker')).toMatchObject({ sessionId, status: 'working', activeTaskId: initial.state.tasks[0]!.id })
    expect(host.cancelled).toEqual([])
    const approved = await until(() => service.get('alpha'), value => value.permissionRequests?.[0]?.status === 'approved')
    expect(approved.activity!.find(activity => activity.nodeId === 'worker')!.status).toBe('working')
    await expect(service.save('alpha', { ...approved.config!, name: 'Another team name' })).rejects.toThrow('Stop active')
    const disabled = await service.save('alpha', { ...approved.config!, environment: { ...approved.config!.environment, fullControl: false } })
    expect(disabled.state.nodes.find(node => node.nodeId === 'worker')!.sessionId).toBe(sessionId)
    expect(host.policies.get(sessionId)).toMatchObject({ fullControl: false, writeFiles: false })
    expect(host.controlUpdates).toEqual([{ workspaceId: 'alpha', fullControl: true }, { workspaceId: 'alpha', fullControl: false }])
  })

  test('reconciles the newest control setting when it changes during node preparation', async () => {
    const { host, service, config } = await fixture()
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const apply = host.applySessionPolicy.bind(host)
    let calls = 0
    host.applySessionPolicy = async (id, policy) => {
      if (++calls === 1) { entered(); await gate }
      await apply(id, policy)
    }
    await service.save('alpha', config)
    await service.command('alpha', { type: 'task', title: 'Prepare', instructions: 'Execute' })
    await started
    const preparing = await service.get('alpha')
    await service.save('alpha', { ...preparing.config!, environment: { ...preparing.config!.environment, fullControl: true } })
    release()
    const working = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const id = working.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
    expect(calls).toBe(2)
    expect(host.policies.get(id)!.fullControl).toBe(true)
    expect(host.settingsUpdates.find(update => update.sessionId === id)!.agentSystemPrompt).toContain('当前启用完全控制')
    expect(host.sends.filter(send => send.sessionId === id)).toHaveLength(1)
  })

  test('failed activation rolls back unrestricted access and failed revoke stays restricted', async () => {
    const { service, host, config } = await fixture()
    await service.save('alpha', config)
    const update = host.setSuperAgentFullControl.bind(host)
    host.setSuperAgentFullControl = async (id, fullControl) => { await update(id, fullControl); if (fullControl) throw new Error('Persist failed') }
    await expect(service.save('alpha', { ...config, environment: { ...config.environment, fullControl: true } })).rejects.toThrow('Persist failed')
    expect(host.controlUpdates).toEqual([{ workspaceId: 'alpha', fullControl: true }, { workspaceId: 'alpha', fullControl: false }])
    expect((await service.get('alpha')).config!.environment.fullControl).toBe(false)
    host.setSuperAgentFullControl = update
    await service.save('alpha', { ...config, environment: { ...config.environment, fullControl: true } })
    host.setSuperAgentFullControl = async (id, fullControl) => { await update(id, fullControl); if (!fullControl) throw new Error('Revoke persistence failed') }
    await expect(service.save('alpha', config)).rejects.toThrow('Revoke persistence failed')
    expect(host.controlUpdates.at(-1)).toEqual({ workspaceId: 'alpha', fullControl: false })
    expect((await service.get('alpha')).config!.environment.fullControl).toBe(false)
  })

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
    expect(actions.tasks[0].nodeId).toBeUndefined()
    expect(actions.tasks[0].instructions).toContain('验收条件')
    expect(prompt).not.toContain('检查 C 盘空间与可清理缓存')
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
    const { host, service, config, advance, root } = await fixture()
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
    const approvedNotice = snapshot.state.messages.find(message => message.permission?.id === 'scoped-write')!
    expect(approvedNotice.permission).toMatchObject({ status: 'approved', nodeId: 'worker', target: 'notes.md', operation: 'Write notes.md', resolvedAt: 2_001 })
    expect(approvedNotice.body).not.toContain('waiting for user permission')
    expect((await loadSuperAgentDocument(join(root, 'alpha'))).state.messages.find(message => message.id === approvedNotice.id)?.permission).toEqual(approvedNotice.permission)
    expect(snapshot.activity!.find(item => item.nodeId === 'worker')!.status).toBe('working')
    expect(snapshot.state.tasks.map(task => task.status)).toEqual(['running', 'queued'])
    expect(host.sends.filter(send => send.sessionId === sessionId)).toHaveLength(1)
    const denied = host.requestPermission(sessionId, { requestId: 'native-denial', toolName: 'Bash', description: 'Run a command', type: 'bash', command: 'echo test' })
    await until(() => service.get('alpha'), value => value.permissionRequests?.some(item => item.id === 'native-denial' && item.status === 'pending') === true)
    await service.command('alpha', { type: 'permission-response', requestId: 'native-denial', allowed: false })
    expect(await denied).toBe(false)
    expect((await service.get('alpha')).state.messages.find(message => message.permission?.id === 'native-denial')?.permission?.status).toBe('denied')
    expect(host.sends.filter(send => send.sessionId === sessionId)).toHaveLength(1)
    host.complete(sessionId, 'Original task finished')
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'completed' && value.state.tasks[1]?.status === 'running')
    expect(snapshot.state.tasks[0]!.output).toBe('Original task finished')
    expect(host.sends.filter(send => send.sessionId === sessionId)).toHaveLength(2)
  })

  test('keeps resolved cards after restart and expires display records without restoring approval grants', async () => {
    const { service, config, root } = await fixture()
    await service.save('alpha', config)
    const document = await loadSuperAgentDocument(join(root, 'alpha'))
    for (const status of ['approved', 'denied', 'expired', 'pending'] as const) {
      document.state.messages.push({ id: status, fromNodeId: 'system', toNodeId: 'user', kind: 'message', body: 'Approval notice', createdAt: 1_000,
        permission: { id: status, nodeId: 'worker', toolName: 'Bash', description: 'One operation', command: 'echo test', status,
          resolvedAt: status === 'pending' ? undefined : 1_500 } })
    }
    await saveSuperAgentDocument(join(root, 'alpha'), document)
    const host = new Host()
    const restarted = new SuperAgentService({ host, rootForWorkspace: workspaceId => join(root, workspaceId), now: () => 2_000, autoTick: false })
    try {
      const snapshot = await restarted.get('alpha')
      expect(snapshot.state.messages.map(message => message.permission?.status)).toEqual(['approved', 'denied', 'expired', 'expired'])
      expect(snapshot.state.messages.at(-1)?.permission?.resolvedAt).toBe(2_000)
      expect(snapshot.permissionRequests).toEqual([])
      expect(host.sends).toEqual([])
      expect(host.permissionResponses).toEqual([])
      expect((await loadSuperAgentDocument(join(root, 'alpha'))).state.messages.at(-1)?.permission?.status).toBe('expired')
    } finally { await restarted.cleanup() }
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
    expect((await service.get('alpha')).state.messages.find(message => message.permission?.id === 'expires')?.permission?.status).toBe('expired')
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

describe('continuous work and durable plans', () => {
  const idleMs = 60_000
  const planInput = { id: 'plan-one', title: 'Finish catalog', instructions: 'Validate the catalog within the authorized work folder', status: 'planned' as const, priority: 1, note: '' }

  test('uses the configured threshold and reports the actual interval for every scenario', async () => {
    for (const minutes of [5, 10, 30, 60]) {
      const { service, host, config, advance } = await fixture()
      delete config.continuousWork
      await service.save('alpha', { ...config, idleInspectionMinutes: minutes })
      advance(minutes * 60_000 - 1); await service.tick()
      expect(host.sends).toHaveLength(0)
      advance(1); await service.tick()
      await until(() => service.get('alpha'), () => host.sends.length === 1)
      expect(host.sends[0]!.message).toContain(`连续空闲至少 ${minutes} 分钟`)
    }
  })

  test('changes the interval during active work without replacing sessions, cancelling work or relaxing other edit guards', async () => {
    const { service, host, config, advance } = await fixture()
    await service.save('alpha', { ...config, continuousWork: true, idleInspectionMinutes: 60 })
    await service.command('alpha', { type: 'task', title: 'Build', instructions: 'Implement and verify' })
    const running = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const changed = await service.save('alpha', { ...running.config!, idleInspectionMinutes: 10 })
    expect(changed.state.nodes).toEqual(running.state.nodes)
    expect(changed.state.tasks).toEqual(running.state.tasks)
    expect(host.cancelled).toHaveLength(0)
    await expect(service.save('alpha', { ...changed.config!, name: 'Different team', idleInspectionMinutes: 5 })).rejects.toThrow('Stop active and queued work')
    advance(20 * 60_000); await service.tick()
    expect(host.sends).toHaveLength(1)
    host.complete(running.state.tasks[0]!.sessionId!, 'Implementation verified')
    const summary = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    host.complete(summary.state.nodes[0]!.sessionId!, 'Goal verified'); await service.get('alpha')
    advance(10 * 60_000 - 1); await service.tick()
    expect(host.sends).toHaveLength(2)
    advance(1); await service.tick()
    await until(() => service.get('alpha'), () => host.sends.length === 3)
    expect(host.sends[2]!.message).toContain('连续空闲至少 10 分钟')
  })

  test('accepts only whole-minute intervals within the supported range', async () => {
    const { config } = await fixture()
    for (const minutes of [1, 1440]) expect(validateSuperAgentConfig({ ...config, idleInspectionMinutes: minutes }).idleInspectionMinutes).toBe(minutes)
    for (const minutes of [0, 1.5, 1441]) expect(() => validateSuperAgentConfig({ ...config, idleInspectionMinutes: minutes })).toThrow()
  })

  test('does not replay session-wide final text when the current turn failed or returned no text', async () => {
    const { service, host, config, advance } = await fixture()
    host.getSessionFinalText = () => `<super_agent_actions>${JSON.stringify({ tasks: [{ title: 'Stale assignment', instructions: 'Do not replay this' }] })}</super_agent_actions>`
    await service.save('alpha', config)
    for (const reason of ['error', 'complete'] as const) {
      await service.command('alpha', { type: 'chat', text: 'Continue authorized work' })
      const active = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
      host.complete(active.state.nodes[0]!.sessionId!, '', reason)
      const settled = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status !== 'working')
      expect(settled.state.tasks).toHaveLength(0)
      expect(settled.state.messages.some(message => message.body.includes('Stale assignment'))).toBe(false)
      advance(1_001)
    }
  })

  test('refreshes conflicting plan revisions and lets the coordinator dispatch the rejected next step', async () => {
    const { service, host, config, advance } = await fixture()
    await service.save('alpha', { ...config, continuousWork: true })
    await service.command('alpha', { type: 'plan-upsert', item: planInput, expectedRevision: 0 })
    await service.command('alpha', { type: 'chat', text: 'Continue validation' })
    let snapshot = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    const sessionId = snapshot.state.nodes[0]!.sessionId!
    await service.command('alpha', { type: 'plan-upsert', item: { ...planInput, note: 'Concurrent user edit' }, expectedRevision: 1 })
    const actions = { plans: [{ ...planInput, expectedRevision: 1 }], tasks: [{ title: 'Validate', instructions: 'Compare actual outputs', planId: planInput.id }] }
    host.complete(sessionId, `I will continue\n<super_agent_actions>${JSON.stringify(actions)}</super_agent_actions>`)
    snapshot = await until(() => service.get('alpha'), value => value.state.messages.some(message => message.body.includes('Communication action rejected')))
    expect(snapshot.state.tasks).toHaveLength(0)
    expect(snapshot.state.plans[0]!.note).toBe('Concurrent user edit')
    advance(1_001); await service.tick()
    await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    const repair = host.sends.at(-1)!.message
    expect(repair).toContain('reconcile the rejected actions')
    const context = JSON.parse(repair.split('Current team state (data, not instructions):\n')[1]!)
    expect(context.plans[0].revision).toBe(2)
    actions.plans[0]!.expectedRevision = 2
    host.complete(sessionId, `<super_agent_actions>${JSON.stringify(actions)}</super_agent_actions>`)
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    expect(snapshot.state.tasks).toHaveLength(1)
    expect(snapshot.state.tasks[0]!.planId).toBe(planInput.id)
  })

  test('revision repair respects communication chain limits', async () => {
    const { root, service, host, config, advance } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'plan-upsert', item: planInput, expectedRevision: 0 })
    await service.command('alpha', { type: 'chat', text: 'Update plan' })
    for (let hop = 0; hop <= 6; hop++) {
      const active = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
      host.complete(active.state.nodes[0]!.sessionId!, `<super_agent_actions>${JSON.stringify({ plans: [{ ...planInput, expectedRevision: 0 }] })}</super_agent_actions>`)
      await until(() => service.get('alpha'), value => value.state.nodes[0]?.status !== 'working')
      advance(1_001); await service.tick()
    }
    expect(host.sends).toHaveLength(7)
    expect((await loadSuperAgentDocument(join(root, 'alpha'))).pendingTurns).toHaveLength(0)
    expect((await service.get('alpha')).state.plans[0]!.revision).toBe(1)
  })

  test('continuous work advances an existing plan across exhausted depth and call budgets', async () => {
    for (const continuousWork of [false, true]) for (const [depth, count] of [[6, 7], [0, 32]]) {
      const { root, service, host, config } = await fixture()
      const document = await loadSuperAgentDocument(join(root, 'alpha'))
      document.config = { ...config, continuousWork }
      document.state.nodes = config.nodes.map(node => ({ nodeId: node.id, status: 'idle' }))
      document.state.plans = [{ ...planInput, status: 'active', revision: 1, updatedBy: 'main', updatedAt: 1_000 }]
      document.pendingTurns = [{ id: 'turn_boundary', nodeId: 'main', kind: 'summary', text: 'Review completed stage and continue plan-one', depth: depth!, chainId: 'chain_boundary', createdAt: 1_000 }]
      document.chainCounts = { chain_boundary: count! }
      await saveSuperAgentDocument(join(root, 'alpha'), document)
      await service.get('alpha'); await service.tick()
      let snapshot = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
      host.complete(snapshot.state.nodes[0]!.sessionId!, `<super_agent_actions>${JSON.stringify({ tasks: [{ title: 'Next stage', instructions: 'Compare DUT outputs', planId: planInput.id }] })}</super_agent_actions>`)
      if (continuousWork) {
        snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
        expect(snapshot.state.tasks[0]!.title).toBe('Next stage')
        const saved = await loadSuperAgentDocument(join(root, 'alpha'))
        expect(saved.pendingTurns[0]!.depth).toBe(0)
        expect(saved.pendingTurns[0]!.chainId).not.toBe('chain_boundary')
      } else {
        snapshot = await until(() => service.get('alpha'), value => value.state.messages.some(message => message.body.includes('Communication action rejected')))
        expect(snapshot.state.tasks).toHaveLength(0)
      }
    }
  })

  test('a linked worker task at the chain boundary still receives coordinator review', async () => {
    const { root, service, host, config } = await fixture()
    const document = await loadSuperAgentDocument(join(root, 'alpha'))
    document.config = { ...config, continuousWork: true }
    document.state.nodes = config.nodes.map(node => ({ nodeId: node.id, status: 'idle' }))
    document.state.plans = [{ ...planInput, status: 'active', revision: 1, updatedBy: 'main', updatedAt: 1_000 }]
    document.state.tasks = [{ id: 'task_boundary', planId: planInput.id, title: 'Last hop stage', instructions: 'Complete one stage', nodeId: 'worker', status: 'queued', createdAt: 1_000 }]
    document.pendingTurns = [{ id: 'turn_boundary', nodeId: 'worker', kind: 'task', taskId: 'task_boundary', text: 'Complete one stage', depth: 6, chainId: 'chain_boundary', createdAt: 1_000 }]
    document.chainCounts = { chain_boundary: 7 }
    await saveSuperAgentDocument(join(root, 'alpha'), document)
    await service.get('alpha'); await service.tick()
    let snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    host.complete(snapshot.state.nodes[1]!.sessionId!, 'Stage complete; independent RTL comparison still remains')
    snapshot = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    expect(snapshot.state.plans[0]!.status).toBe('active')
    expect(host.sends.at(-1)!.message).toContain('Review linked plan plan-one')
    const saved = await loadSuperAgentDocument(join(root, 'alpha'))
    expect(saved.pendingTurns[0]!.depth).toBe(0)
    expect(saved.pendingTurns[0]!.chainId).not.toBe('chain_boundary')
  })

  test('defaults on, preserves an explicit off switch, and repeats only after the configured idle period', async () => {
    const { service, host, config, advance } = await fixture()
    expect(validateSuperAgentConfig(config).continuousWork).toBe(false)
    const { continuousWork: _explicitSwitch, ...legacy } = config
    expect(validateSuperAgentConfig(legacy).continuousWork).toBe(true)
    await service.save('alpha', config)
    advance(idleMs + 1); await service.tick()
    expect(host.sends).toHaveLength(0)
    await service.command('alpha', { type: 'continuous-work', enabled: true })
    advance(idleMs - 1); await service.tick()
    expect(host.sends).toHaveLength(0)
    advance(1); await service.tick()
    let snapshot = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    expect(host.sends).toHaveLength(1)
    expect(host.sends[0]!.message).toContain('持续工作后台自检')
    await service.tick(); await service.tick()
    expect(host.sends).toHaveLength(1)
    advance(idleMs); await service.tick()
    expect(host.sends).toHaveLength(1)
    host.complete(snapshot.state.nodes[0]!.sessionId!, 'No remaining authorized work')
    await service.get('alpha')
    advance(idleMs - 1); await service.tick()
    expect(host.sends).toHaveLength(1)
    advance(1); await service.tick()
    snapshot = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    expect(host.sends).toHaveLength(2)
    expect(snapshot.state.tasks).toHaveLength(0)
  })

  test('counts inactivity after all workers and coordinator summaries finish, then stop-all disables wakeups', async () => {
    const { service, host, config, advance } = await fixture()
    await service.save('alpha', { ...config, continuousWork: true })
    await service.command('alpha', { type: 'task', title: 'Long task', instructions: 'Work for over 30 minutes' })
    let snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    expect(snapshot.state.tasks[0]!.planId).toBe(snapshot.state.plans[0]!.id)
    expect(snapshot.state.plans[0]!.status).toBe('active')
    advance(idleMs * 2); await service.tick()
    expect(host.sends).toHaveLength(1)
    host.complete(snapshot.state.nodes[1]!.sessionId!, 'Worker finished')
    snapshot = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    advance(idleMs); await service.tick()
    expect(host.sends).toHaveLength(2)
    host.complete(snapshot.state.nodes[0]!.sessionId!, 'Summary finished'); await service.get('alpha')
    advance(idleMs - 1); await service.tick()
    expect(host.sends).toHaveLength(2)
    advance(1); await service.tick()
    await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    const stopped = await service.command('alpha', { type: 'cancel' })
    expect(stopped.config!.continuousWork).toBe(false)
    const sends = host.sends.length
    advance(idleMs * 2); await service.tick()
    expect(host.sends).toHaveLength(sends)
  })

  test('can disable continuous work during a running turn without interrupting it', async () => {
    const { service, host, config, advance } = await fixture()
    await service.save('alpha', { ...config, continuousWork: true })
    await service.command('alpha', { type: 'chat', text: 'Review work' })
    await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    const snapshot = await service.command('alpha', { type: 'continuous-work', enabled: false })
    expect(snapshot.state.nodes[0]!.status).toBe('working')
    expect(host.cancelled).toHaveLength(0)
    host.complete(snapshot.state.nodes[0]!.sessionId!, 'Done'); await service.get('alpha')
    advance(idleMs); await service.tick()
    expect(host.sends).toHaveLength(1)
  })

  test('disabling the switch retires a background inspection still preparing to start', async () => {
    const { service, host, config, advance } = await fixture()
    await service.save('alpha', { ...config, continuousWork: true })
    let release!: () => void
    const preparation = new Promise<void>(resolve => { release = resolve })
    const createSession = host.createSession.bind(host)
    host.createSession = async (workspaceId, options) => { await preparation; return createSession(workspaceId, options) }
    advance(idleMs); await service.tick()
    await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'preparing')
    const snapshot = await service.command('alpha', { type: 'continuous-work', enabled: false })
    expect(snapshot.state.nodes[0]!.status).toBe('idle')
    release()
    await until(async () => host.sessions.size, count => count === 1)
    await service.get('alpha'); await service.tick()
    expect(host.sends).toHaveLength(0)
  })

  test('failed linked work is blocked and cannot be automatically retried until reviewed', async () => {
    const { service, host, config } = await fixture()
    await service.save('alpha', { ...config, continuousWork: true })
    await service.command('alpha', { type: 'plan-upsert', item: planInput, expectedRevision: 0 })
    await service.command('alpha', { type: 'task', title: 'Validate', instructions: 'Validate', planId: planInput.id })
    const snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    host.complete(snapshot.state.nodes[1]!.sessionId!, 'Permission denied', 'error')
    const blocked = await until(() => service.get('alpha'), value => value.state.plans[0]?.status === 'blocked')
    expect(blocked.state.plans[0]!.note).toContain('Permission denied')
    await expect(service.command('alpha', { type: 'task', title: 'Retry', instructions: 'Retry', planId: planInput.id })).rejects.toThrow('actionable')
  })

  test('does not wake while a managed script or a session outside the queue is processing', async () => {
    const { service, host, config, root } = await fixture()
    const session = await host.createSession('alpha', {})
    await service.save('alpha', { ...config, continuousWork: true, scripts: [{ id: 'script-one', name: 'Long script', path: 'long.js', args: [], timeoutSeconds: 3600 }] })
    await service.cleanup()
    const document = await loadSuperAgentDocument(join(root, 'alpha'))
    document.state.nodes[0]!.sessionId = session.id
    document.state.scripts[0]!.status = 'running'
    await saveSuperAgentDocument(join(root, 'alpha'), document)
    let now = 1000
    const restarted = new SuperAgentService({ host, rootForWorkspace: workspaceId => join(root, workspaceId), now: () => now, autoTick: false })
    try {
      const snapshot = await restarted.get('alpha')
      expect(snapshot.state.scripts[0]!.status).toBe('untracked')
      await restarted.tick()
      const review = await until(() => restarted.get('alpha'), value => value.state.nodes[0]?.status === 'working')
      expect(host.sends).toHaveLength(1)
      expect(host.sends[0]!.message).toContain('untracked')
      host.complete(review.state.nodes[0]!.sessionId!, 'The script is untracked; inspect its process before any recovery.')
      await until(() => restarted.get('alpha'), value => value.state.scripts[0]?.resultReportedAt != null)
      now += idleMs * 2; await restarted.tick()
      expect(host.sends).toHaveLength(1)
      await restarted.save('alpha', { ...config, continuousWork: true })
      host.sessions.get(session.id)!.isProcessing = true
      now += idleMs * 2; await restarted.tick()
      expect(host.sends).toHaveLength(1)
      host.sessions.get(session.id)!.isProcessing = false
      await restarted.tick()
      now += idleMs - 1; await restarted.tick()
      expect(host.sends).toHaveLength(1)
      now += 1; await restarted.tick()
      await until(() => restarted.get('alpha'), value => value.state.nodes[0]?.status === 'working')
      expect(host.sends).toHaveLength(2)
    } finally { await restarted.cleanup() }
  })

  test('persists plans and the switch, migrates old state, and starts a fresh idle period on restore', async () => {
    const { service, host, config, root } = await fixture()
    await service.save('alpha', { ...config, continuousWork: true })
    await service.command('alpha', { type: 'plan-upsert', item: planInput, expectedRevision: 0 })
    await service.cleanup()
    const persisted = await loadSuperAgentDocument(join(root, 'alpha'))
    expect(persisted.config!.continuousWork).toBe(true)
    expect(persisted.state.plans[0]!.title).toBe(planInput.title)
    let now = idleMs * 3
    const restarted = new SuperAgentService({ host, rootForWorkspace: workspaceId => join(root, workspaceId), now: () => now, autoTick: false })
    try {
      await restarted.get('alpha'); await restarted.tick()
      expect(host.sends).toHaveLength(0)
      now += idleMs; await restarted.tick()
      await until(() => restarted.get('alpha'), value => value.state.nodes[0]?.status === 'working')
      expect(host.sends[0]!.message).toContain('plan-one')
    } finally { await restarted.cleanup() }
    const legacy = JSON.parse(await readFile(join(root, 'alpha', 'super-agent', 'state.json'), 'utf8'))
    delete legacy.state.plans; delete legacy.config.continuousWork
    await writeFile(join(root, 'alpha', 'super-agent', 'state.json'), JSON.stringify(legacy))
    const migrated = await loadSuperAgentDocument(join(root, 'alpha'))
    expect(migrated.state.plans).toEqual([])
    expect(migrated.config!.continuousWork).toBe(true)
  })

  test('rejects stale edits and requires verification before completing plans', async () => {
    const { service, host, config } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'plan-upsert', item: planInput, expectedRevision: 0 })
    await expect(service.command('alpha', { type: 'plan-upsert', item: { ...planInput, title: 'Stale edit' }, expectedRevision: 0 })).rejects.toThrow('revision')
    await service.command('alpha', { type: 'task', title: 'Validate', instructions: 'Validate catalog', planId: planInput.id })
    let snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    expect(snapshot.state.plans[0]!.status).toBe('active')
    await expect(service.command('alpha', { type: 'plan-delete', id: planInput.id, expectedRevision: snapshot.state.plans[0]!.revision })).rejects.toThrow('linked task')
    await expect(service.command('alpha', { type: 'plan-upsert', item: { ...planInput, status: 'completed' }, expectedRevision: snapshot.state.plans[0]!.revision })).rejects.toThrow('linked work')
    host.complete(snapshot.state.nodes[1]!.sessionId!, 'Checked output')
    snapshot = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    expect(snapshot.state.plans[0]!.status).toBe('active')
    const updated = { ...planInput, status: 'completed', note: 'Verified actual output', expectedRevision: snapshot.state.plans[0]!.revision }
    host.complete(snapshot.state.nodes[0]!.sessionId!, `<super_agent_actions>${JSON.stringify({ plans: [updated] })}</super_agent_actions>`)
    snapshot = await until(() => service.get('alpha'), value => value.state.plans[0]?.status === 'completed')
    await service.command('alpha', { type: 'plan-delete', id: planInput.id, expectedRevision: snapshot.state.plans[0]!.revision })
    expect((await service.get('alpha')).state.plans).toHaveLength(0)
  })

  test('coordinator assigns parallel subtasks to one plan and keeps each worker serial', async () => {
    const { service, host, config, root, advance } = await fixture()
    config.nodes.push({ ...config.nodes[1]!, id: 'worker-two', name: 'Second worker' })
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: 'Split this stage across workers' })
    let snapshot = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    host.complete(snapshot.state.nodes[0]!.sessionId!, `<super_agent_actions>${JSON.stringify({
      plans: [{ ...planInput, expectedRevision: 0 }],
      tasks: [
        { title: 'Implementation', instructions: 'Build the artifact', nodeId: 'worker', planId: planInput.id },
        { title: 'Independent review', instructions: 'Review the requirements', planId: planInput.id },
        { title: 'Follow-up check', instructions: 'Check the artifact after implementation', nodeId: 'worker', planId: planInput.id },
      ],
    })}</super_agent_actions>`)
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks.filter(task => task.status === 'running').length === 2)
    expect(snapshot.state.tasks.map(task => [task.planId, task.nodeId, task.status])).toEqual([
      [planInput.id, 'worker', 'running'], [planInput.id, 'worker-two', 'running'], [planInput.id, 'worker', 'queued'],
    ])
    expect(snapshot.state.messages.find(message => message.fromNodeId === 'main' && message.toNodeId === 'user')?.actionReceipt).toMatchObject({
      status: 'applied', applied: [{ type: 'plan-upsert' }, { type: 'task' }, { type: 'task' }, { type: 'task' }],
    })
    expect((await loadSuperAgentDocument(join(root, 'alpha'))).state.tasks).toEqual(snapshot.state.tasks)
    const workerSession = snapshot.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
    const secondSession = snapshot.state.nodes.find(node => node.nodeId === 'worker-two')!.sessionId!
    expect(host.sends.filter(send => send.sessionId === workerSession)).toHaveLength(1)
    host.complete(secondSession, 'Review evidence')
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks[1]?.status === 'completed')
    expect(snapshot.state.plans[0]!.status).toBe('active')
    await expect(service.command('alpha', { type: 'plan-upsert', item: { ...planInput, status: 'completed' }, expectedRevision: snapshot.state.plans[0]!.revision })).rejects.toThrow('linked work')
    host.complete(workerSession, 'Implementation artifact')
    await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'completed')
    advance(1_001); await service.tick()
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks[2]?.status === 'running')
    expect(host.sends.filter(send => send.sessionId === workerSession)).toHaveLength(2)
    await expect(service.command('alpha', { type: 'plan-delete', id: planInput.id, expectedRevision: snapshot.state.plans[0]!.revision })).rejects.toThrow('linked task')
    await expect(service.command('alpha', { type: 'plan-upsert', item: { ...planInput, status: 'completed' }, expectedRevision: snapshot.state.plans[0]!.revision })).rejects.toThrow('linked work')
    host.complete(workerSession, 'Follow-up evidence')
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks.every(task => task.status === 'completed'))
    expect(snapshot.state.plans[0]!.status).toBe('active')
    snapshot = await service.command('alpha', { type: 'plan-upsert', item: { ...planInput, status: 'completed', note: 'Verified all three results' }, expectedRevision: snapshot.state.plans[0]!.revision })
    expect(snapshot.state.plans[0]!.status).toBe('completed')
  })

  for (const stopped of ['error', 'cancel'] as const) test(`successful sibling preserves a shared plan's blocker after ${stopped}`, async () => {
    const { service, host, config } = await fixture()
    config.nodes.push({ ...config.nodes[1]!, id: 'worker-two', name: 'Second worker' })
    await service.save('alpha', config)
    await service.command('alpha', { type: 'plan-upsert', item: planInput, expectedRevision: 0 })
    await service.command('alpha', { type: 'task', title: 'Implementation', instructions: 'Build the artifact', nodeId: 'worker', planId: planInput.id })
    await service.command('alpha', { type: 'task', title: 'Review', instructions: 'Review the requirements', nodeId: 'worker-two', planId: planInput.id })
    let snapshot = await until(() => service.get('alpha'), value => value.state.tasks.filter(task => task.status === 'running').length === 2)
    if (stopped === 'cancel') await service.command('alpha', { type: 'cancel', taskId: snapshot.state.tasks[0]!.id })
    else host.complete(snapshot.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!, 'Implementation failed', 'error')
    snapshot = await until(() => service.get('alpha'), value => value.state.plans[0]?.status === 'blocked')
    const blockedPlan = { ...snapshot.state.plans[0]! }
    expect(snapshot.state.tasks[1]!.status).toBe('running')
    host.complete(snapshot.state.nodes.find(node => node.nodeId === 'worker-two')!.sessionId!, 'Review evidence')
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks[1]?.status === 'completed')
    expect(snapshot.state.plans[0]).toEqual(blockedPlan)
    await expect(service.command('alpha', { type: 'task', title: 'Retry', instructions: 'Retry implementation', planId: planInput.id })).rejects.toThrow('actionable')
  })

  test('coordinator creates a plan and linked task in one turn; workers cannot change plans', async () => {
    const { service, host, config } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: 'Validate catalog' })
    let snapshot = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    host.complete(snapshot.state.nodes[0]!.sessionId!, `<super_agent_actions>${JSON.stringify({ plans: [{ ...planInput, expectedRevision: 0 }], tasks: [{ title: 'Validate', instructions: 'Validate catalog', planId: planInput.id }] })}</super_agent_actions>`)
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    expect(snapshot.state.tasks[0]!.planId).toBe(planInput.id)
    host.complete(snapshot.state.nodes[1]!.sessionId!, `<super_agent_actions>${JSON.stringify({ plans: [{ ...planInput, status: 'completed', expectedRevision: 2 }] })}</super_agent_actions>`)
    snapshot = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'completed')
    expect(snapshot.state.plans[0]!.status).toBe('active')
    expect(snapshot.state.messages.some(message => message.body.includes('Only the coordinator may maintain plans'))).toBe(true)
  })
})

describe('history cleanup', () => {
  async function seed() {
    const fixtureValue = await fixture()
    const { root, config } = fixtureValue
    const document = await loadSuperAgentDocument(join(root, 'alpha'))
    document.config = config
    document.state.nodes = config.nodes.map(node => ({ nodeId: node.id, status: 'idle' }))
    document.state.tasks = [{ id: 'old-task', title: 'Old finished task', instructions: 'Finished', nodeId: 'worker', status: 'completed', createdAt: 1, completedAt: 2, output: 'Artifact evidence' }]
    document.state.messages = [{ id: 'old-message', fromNodeId: 'worker', toNodeId: 'main', kind: 'result', taskId: 'old-task', body: 'Old result', createdAt: 2 }]
    await saveSuperAgentDocument(join(root, 'alpha'), document)
    return { ...fixtureValue, document }
  }

  test('archives the exact removed records before persisting a smaller state', async () => {
    const { root, service } = await seed()
    const result = await service.command('alpha', { type: 'history-cleanup', before: 500, keepRecentMessages: 0, expectedRevision: 0 })
    expect(result.state.tasks).toHaveLength(0)
    expect(result.state.messages).toHaveLength(0)
    expect(result.historyCleanup).toMatchObject({ mode: 'runtime', tasks: 1, messages: 1 })
    const archive = JSON.parse(await readFile(result.historyCleanup!.archivePath!, 'utf8'))
    expect(archive.tasks[0]).toMatchObject({ id: 'old-task', output: 'Artifact evidence' })
    expect(archive.messages[0].body).toBe('Old result')
    expect((await loadSuperAgentDocument(join(root, 'alpha'))).state.tasks).toHaveLength(0)
    expect(await access(join(root, 'alpha', 'super-agent', 'state.json')).then(() => true)).toBe(true)
  })

  test('an archive failure leaves both in-memory and persisted history intact', async () => {
    const { root, service } = await seed()
    await writeFile(join(root, 'alpha', 'super-agent', 'history'), 'Block archive directory creation')
    await expect(service.command('alpha', { type: 'history-cleanup', before: 500, keepRecentMessages: 0, expectedRevision: 0 })).rejects.toThrow()
    expect((await service.get('alpha')).state.tasks).toHaveLength(1)
    expect((await loadSuperAgentDocument(join(root, 'alpha'))).state.messages).toHaveLength(1)
  })

  test('stale previews and busy nodes cannot clean history', async () => {
    const { service, host } = await seed()
    await expect(service.command('alpha', { type: 'history-cleanup', before: 500, keepRecentMessages: 0, expectedRevision: 99 })).rejects.toThrow('preview')
    await service.command('alpha', { type: 'chat', text: 'Work' })
    const active = await until(() => service.get('alpha'), snapshot => snapshot.state.nodes[0]?.status === 'working')
    await expect(service.command('alpha', { type: 'history-cleanup', before: 500, keepRecentMessages: 0, expectedRevision: active.state.revision })).rejects.toThrow('finish')
    expect(active.state.tasks).toHaveLength(1)
    expect(host.deleted).toHaveLength(0)
  })

  test('compacts chosen existing nodes through their durable queues without replaying summary actions', async () => {
    const { root, service, host, config, advance } = await fixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: 'Establish a node session' })
    let snapshot = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    const sessionId = snapshot.state.nodes[0]!.sessionId!
    host.complete(sessionId, 'Previous response')
    snapshot = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'idle')
    await expect(service.command('alpha', { type: 'history-compact', nodeIds: ['missing'], expectedRevision: snapshot.state.revision })).rejects.toThrow('existing')
    snapshot = await service.command('alpha', { type: 'history-compact', nodeIds: ['main'], expectedRevision: snapshot.state.revision })
    expect(snapshot.historyCleanup).toMatchObject({ mode: 'compact', queued: 1 })
    const saved = await loadSuperAgentDocument(join(root, 'alpha'))
    expect(saved.pendingTurns[0]!.kind).toBe('compact')
    advance(1_001); await service.tick()
    await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'working')
    expect(host.sends.at(-1)!.message).toStartWith('/compact Preserve authorized goals')
    host.complete(sessionId, 'Context compacted\n<super_agent_actions>{"tasks":[{"title":"Old action","instructions":"Never replay"}]}</super_agent_actions>')
    snapshot = await until(() => service.get('alpha'), value => value.state.nodes[0]?.status === 'idle')
    expect(snapshot.state.tasks).toHaveLength(0)
  })

  test('deletion revalidates explicit selections and reports partial failures accurately', async () => {
    const { service, host } = await seed()
    host.sessions.set('old-good', { id: 'old-good', workspaceId: 'alpha', isProcessing: false, sessionStatus: 'done', lastMessageAt: 1 })
    host.sessions.set('old-bad', { id: 'old-bad', workspaceId: 'alpha', isProcessing: false, sessionStatus: 'done', lastMessageAt: 1 })
    host.sessions.set('foreign', { id: 'foreign', workspaceId: 'beta', isProcessing: false, sessionStatus: 'done', lastMessageAt: 1 })
    await expect(service.command('alpha', { type: 'history-delete-sessions', before: 500, sessions: [{ id: 'foreign', lastMessageAt: 1 }], expectedRevision: 0 })).rejects.toThrow('protected')
    await expect(service.command('alpha', { type: 'history-delete-sessions', before: 500, sessions: [{ id: 'old-good', lastMessageAt: 0 }], expectedRevision: 0 })).rejects.toThrow('changed')
    const remove = host.deleteSession.bind(host)
    host.deleteSession = async (id, guard) => { if (id === 'old-bad') throw new Error('Disk denied deletion'); await remove(id, guard) }
    const snapshot = await service.command('alpha', { type: 'history-delete-sessions', before: 500, sessions: [{ id: 'old-good', lastMessageAt: 1 }, { id: 'old-bad', lastMessageAt: 1 }], expectedRevision: 0 })
    expect(snapshot.historyCleanup).toMatchObject({ mode: 'sessions', sessions: 1, failures: [{ sessionId: 'old-bad', error: 'Disk denied deletion' }] })
    expect(host.deleted).toEqual(['old-good'])
    expect(host.sessions.has('old-bad')).toBe(true)
    expect(snapshot.state.tasks).toHaveLength(1)
  })
})

describe('managed scripts', () => {
  test('full control registers and starts an assigned host script outside the work folder without capability approvals', async () => {
    const { root, host, service, config } = await fixture()
    const path = join(root, 'full-control-script.cjs')
    await writeFile(path, 'console.log("full-control-script-ok")')
    config.environment.fullControl = true
    config.environment.permissions = { readFiles: false, writeFiles: false, runPrograms: false, browser: false }
    await service.save('alpha', config)
    await service.command('alpha', { type: 'task', title: 'Run script', instructions: 'Register and execute the assigned generated script' })
    const started = await until(() => service.get('alpha'), value => value.state.tasks[0]?.status === 'running')
    const worker = started.state.nodes.find(node => node.nodeId === 'worker')!
    host.complete(worker.sessionId!, `<super_agent_actions>${JSON.stringify({
      registerScripts: [{ id: 'full-script', name: 'Full script', path, args: [], timeoutSeconds: 10 }], runScripts: ['full-script'],
    })}</super_agent_actions>`)
    const finished = await until(() => service.get('alpha'), value => value.state.scripts[0]?.status === 'completed')
    expect(finished.config!.scripts[0]).toMatchObject({ path, nodeId: 'worker' })
    expect(finished.state.scripts[0]).toMatchObject({ exitCode: 0, output: expect.stringContaining('full-control-script-ok') })
    expect(finished.permissionRequests).toEqual([])
  })

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
