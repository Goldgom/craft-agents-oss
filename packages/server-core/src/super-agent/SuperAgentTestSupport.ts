import { afterEach } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { CreateSessionOptions, PermissionRequest, Session, SessionEvent } from '@craft-agent/shared/protocol'
import type { SessionCompletionEvent } from '../sessions/SessionManager'
import type { SuperAgentConfig, SuperAgentSessionPolicy } from '@craft-agent/shared/super-agent'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import { SuperAgentService, type SuperAgentSessionHost, type SuperAgentServiceDeps } from './SuperAgentService'

/** Shared deterministic host for the scheduler reliability regression suites. */
export class SuperAgentTestHost implements SuperAgentSessionHost {
  sessions = new Map<string, { id: string; workspaceId: string; isProcessing: boolean } & Partial<Session>>()
  options = new Map<string, CreateSessionOptions>()
  policies = new Map<string, SuperAgentSessionPolicy>()
  sends: Array<{ sessionId: string; message: string; context: string; hidden?: boolean }> = []
  sessionQueries: string[] = []
  finalTextReads = 0
  finalText: string | undefined
  cancelled: string[] = []
  listeners = new Set<(event: SessionCompletionEvent) => void>()
  eventListeners = new Set<(event: SessionEvent, workspaceId: string) => void>()
  pendingPermissions = new Map<string, { sessionId: string; resolve: (allowed: boolean) => void }>()
  permissionResponses: Array<{ sessionId: string; requestId: string; allowed: boolean; alwaysAllow: boolean }> = []
  permissionGrantClears: string[] = []

  clearSuperAgentPermissionGrants(workspaceId: string) { this.permissionGrantClears.push(workspaceId) }

  async createSession(workspaceId: string, options: CreateSessionOptions) {
    const id = `session-${this.options.size + 1}`
    this.sessions.set(id, { id, workspaceId, isProcessing: false })
    this.options.set(id, options)
    return { id }
  }

  async getSession(id: string) {
    this.sessionQueries.push(id)
    return this.sessions.get(id) ?? null
  }

  async sendMessage(sessionId: string, message: string, context = '', hidden?: boolean) {
    this.sessions.get(sessionId)!.isProcessing = true
    this.sends.push({ sessionId, message, context, hidden })
  }

  async applySessionPolicy(sessionId: string, policy: SuperAgentSessionPolicy) { this.policies.set(sessionId, policy) }
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel) {
    this.options.set(sessionId, { ...this.options.get(sessionId), thinkingLevel: level })
  }

  async ensureSuperAgentSessionSettings(sessionId: string, settings: { permissionMode: 'allow-all'; agentSystemPrompt: string }) {
    if (!this.sessions.has(sessionId) || this.sessions.get(sessionId)!.isProcessing) throw new Error('Node session must be idle')
    this.options.set(sessionId, { ...this.options.get(sessionId), ...settings })
  }

  onSessionComplete(listener: (event: SessionCompletionEvent) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  onSessionEvent(listener: (event: SessionEvent, workspaceId: string) => void) {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }

  emit(event: SessionEvent, workspaceId = this.sessions.get(event.sessionId)?.workspaceId ?? 'alpha') {
    for (const listener of this.eventListeners) listener(event, workspaceId)
  }

  requestPermission(sessionId: string, request: Omit<PermissionRequest, 'sessionId'>): Promise<boolean> {
    return new Promise(resolve => {
      this.pendingPermissions.set(request.requestId, { sessionId, resolve })
      this.emit({ type: 'permission_request', sessionId, request: { ...request, sessionId } })
    })
  }

  respondToPermission(sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean) {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending || pending.sessionId !== sessionId || !this.sessions.get(sessionId)?.isProcessing) return false
    this.pendingPermissions.delete(requestId)
    this.permissionResponses.push({ sessionId, requestId, allowed, alwaysAllow })
    pending.resolve(allowed)
    this.emit({ type: 'permission_resolved', sessionId, requestId, allowed })
    return true
  }

  getSessionFinalText() { this.finalTextReads++; return this.finalText }

  async cancelProcessing(sessionId: string) {
    this.cancelled.push(sessionId)
    if (this.sessions.has(sessionId)) this.complete(sessionId, '', 'interrupted')
  }

  /** Intentionally drop the completion notification while changing host state. */
  loseCompletion(sessionId: string) { this.sessions.get(sessionId)!.isProcessing = false }

  complete(sessionId: string, finalText: string, reason: SessionCompletionEvent['reason'] = 'complete', failure: Pick<SessionCompletionEvent, 'errorCode' | 'canRetry' | 'tokenUsage'> = {}) {
    const session = this.sessions.get(sessionId)!
    session.isProcessing = false
    if (failure.tokenUsage) session.tokenUsage = failure.tokenUsage
    for (const [requestId, pending] of [...this.pendingPermissions]) {
      if (pending.sessionId !== sessionId) continue
      this.pendingPermissions.delete(requestId)
      pending.resolve(false)
      this.emit({ type: 'permission_resolved', sessionId, requestId, allowed: false, reason: 'session_stopped' })
    }
    this.emit({ type: reason === 'complete' ? 'complete' : 'interrupted', sessionId })
    for (const listener of this.listeners) listener({ sessionId, workspaceId: session.workspaceId, finalText, reason, ...failure })
  }
}

const fixturePrefix = 'super-agent-reliability-'
const fixtures: Array<{ root: string; service: SuperAgentService }> = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.service.cleanup()
    const target = resolve(fixture.root)
    // Recursive teardown is restricted to the exact mkdtemp child we created.
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith(fixturePrefix)) {
      throw new Error(`Unsafe Super Agent fixture cleanup target: ${target}`)
    }
    await rm(target, { recursive: true, force: true })
  }
})

export async function superAgentFixture(options: Partial<Pick<SuperAgentServiceDeps,
  'spawnScript' | 'resolveEnvironment' | 'prepareEnvironment' | 'onConfigChanged' | 'onChanged' | 'workflow' | 'upgradeArchitecture' | 'actionGates' | 'checkReadiness'>> = {}) {
  const root = await mkdtemp(join(tmpdir(), fixturePrefix))
  const workingDirectory = join(root, 'work')
  await mkdir(workingDirectory)
  const host = new SuperAgentTestHost()
  let now = 1_000
  const service = new SuperAgentService({ host, rootForWorkspace: workspaceId => join(root, workspaceId), now: () => now, autoTick: false, ...options })
  fixtures.push({ root, service })
  const node = (id: string, role: 'coordinator' | 'worker') => ({ id, role, name: id, avatar: '🤖', description: 'Test role',
    llmConnection: 'existing-provider', model: 'existing-model', thinkingLevel: 'medium' as const, maxCallsPerMinute: 60,
    intelligenceRating: 3, workPreferences: '', sourceSlugs: [], abilityProfileIds: [] })
  const config: SuperAgentConfig = { version: 1, name: 'Test team', avatar: '✨', nodes: [node('main', 'coordinator'), node('worker', 'worker')], idleInspectionMinutes: 1, continuousWork: false,
    environment: { kind: 'folder', workingDirectory, permissionMode: 'allow-all', fullControl: false,
      permissions: { readFiles: true, writeFiles: true, runPrograms: true, browser: true } }, sourceSlugs: [], abilityProfiles: [], scripts: [] }
  return { root, workingDirectory, host, service, config, now: () => now, advance: (milliseconds: number) => { now += milliseconds } }
}

export async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read()
    if (ready(value)) return value
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for service state')
}
