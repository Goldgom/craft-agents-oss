import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  authorizeSessionPolicyTool, checkSessionExecutionPolicy, clearSessionExecutionPolicy,
  getSessionPolicyGrantTarget, hasSessionPolicyToolGrant, setSessionExecutionPolicy, setSessionProgramExecutor,
  type SessionExecutionPolicy, type SessionPolicyPermissionRequest,
} from '@craft-agent/shared/agent'
import type { SessionEvent } from '@craft-agent/shared/protocol'
import type { ShellExecArgs } from '@craft-agent/session-tools-core'
import { CLIENT_RUN_SHELL, type ClientShellResult } from '../transport'
import { TurnClientContexts } from './turn-client-context'
import { SessionManager } from './SessionManager'

type ManagedTestSession = {
  id: string
  workspace: { id: string; rootPath: string }
  workingDirectory: string
  executionPolicy?: SessionExecutionPolicy
  isProcessing: boolean
  stopRequested: boolean
  persistenceRetired?: boolean
  runtimeTeardown?: Promise<void>
  agent?: { forceAbort(reason: unknown): void; respondToPermission?(requestId: string, allowed: boolean, alwaysAllow: boolean): void }
}
type PermissionEvent = Extract<SessionEvent, { type: 'permission_request' }>
type NodePermissionHarness = {
  turnClients: TurnClientContexts
  sessions: Map<string, ManagedTestSession>
  pendingPermissionRequests: Map<string, { sessionId: string }>
  pendingNodePermissions: Map<string, {
    sessionId: string; request: SessionPolicyPermissionRequest; expiresAt: number; timer: ReturnType<typeof setTimeout>; resolve: (allowed: boolean) => void
  }>
  sessionEventListeners: Set<(event: SessionEvent, workspaceId: string) => void>
  rpcServer: {
    findClientsWithCapability(capability: string, scope: { workspaceId: string }): string[]
    invokeClientWithTimeout(clientId: string, capability: string, timeoutMs: number, args: ShellExecArgs): Promise<ClientShellResult>
  } | null
  setEventSink(sink: (...args: any[]) => void): void
  onSessionEvent(listener: (event: SessionEvent, workspaceId: string) => void): () => void
  attachNodePermissionHandler(managed: ManagedTestSession): void
  requestNodePermission(managed: ManagedTestSession, request: SessionPolicyPermissionRequest): Promise<boolean>
  autoRespondToNodeRuntimePermission(managed: ManagedTestSession, request: { requestId: string; toolName: string; command?: string; description: string; type?: 'admin_approval' | 'file_write' }): boolean
  clearPendingPermissionRequestsForSession(sessionId: string): void
  respondToPermission(sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean): boolean
  clearSuperAgentPermissionGrants(workspaceId: string): void
  runSessionLocalShell(managed: ManagedTestSession, args: ShellExecArgs): Promise<ClientShellResult>
  deleteSession(sessionId: string): Promise<void>
}

const sessionId = 'node-policy-manager-test'
const otherSessionId = 'node-policy-other-test'
const localTool = 'mcp__session__localbash'
let temp: string
let root: string
let outside: string
let managed: ManagedTestSession
let manager: NodePermissionHarness
let events: SessionEvent[]
let clients: string[]
let invocations: Array<{ clientId: string; capability: string; args: ShellExecArgs }>
let usingFakeTimers: boolean

beforeEach(() => {
  usingFakeTimers = false
  temp = mkdtempSync(join(tmpdir(), 'node-policy-manager-'))
  root = join(temp, 'environment')
  outside = join(temp, 'outside')
  mkdirSync(root); mkdirSync(outside)
  writeFileSync(join(outside, 'requested.txt'), 'requested')
  writeFileSync(join(outside, 'other.txt'), 'other')
  const policy = setSessionExecutionPolicy(sessionId, {
    nodeId: 'worker', role: 'worker', rootPath: root, readFiles: true, writeFiles: true,
    runPrograms: true, browser: false, allowSources: [], allowSubagents: false,
  })
  managed = { id: sessionId, workspace: { id: 'workspace', rootPath: root }, workingDirectory: root,
    executionPolicy: policy, isProcessing: true, stopRequested: false }
  manager = Object.create(SessionManager.prototype) as NodePermissionHarness
  manager.turnClients = new TurnClientContexts()
  manager.sessions = new Map([
    [sessionId, managed], [otherSessionId, { ...managed, id: otherSessionId }],
  ])
  manager.pendingPermissionRequests = new Map()
  manager.pendingNodePermissions = new Map()
  manager.sessionEventListeners = new Set()
  manager.setEventSink(() => {})
  events = []
  manager.onSessionEvent(event => { events.push(event) })
  clients = ['client-a']
  invocations = []
  manager.rpcServer = {
    findClientsWithCapability: (capability, scope) =>
      capability === CLIENT_RUN_SHELL && scope.workspaceId === managed.workspace.id ? [...clients] : [],
    invokeClientWithTimeout: async (clientId, capability, _timeoutMs, args) => {
      invocations.push({ clientId, capability, args })
      return { command: args.command, cwd: args.cwd ?? root, stdout: clientId, stderr: '',
        exitCode: 0, timedOut: false, truncated: false }
    },
  }
  manager.attachNodePermissionHandler(managed)
})

afterEach(() => {
  manager.clearPendingPermissionRequestsForSession(sessionId)
  clearSessionExecutionPolicy(sessionId)
  clearSessionExecutionPolicy(otherSessionId)
  if (usingFakeTimers) { jest.clearAllTimers(); jest.useRealTimers() }
  rmSync(temp, { recursive: true, force: true })
})

function beginPermission(toolName: string, input: Record<string, unknown>) {
  const result = authorizeSessionPolicyTool(sessionId, toolName, input, root)
  const event = events.findLast((item): item is PermissionEvent => item.type === 'permission_request')
  if (!event) throw new Error('Expected a permission request from the real session manager')
  return { result, request: event.request }
}

async function approveLocalShell(args: ShellExecArgs) {
  const pending = beginPermission(localTool, { ...args })
  expect(manager.respondToPermission(sessionId, pending.request.requestId, true, true)).toBe(true)
  expect((await pending.result).allowed).toBe(true)
  return pending.request
}

describe('node permission lifecycle in SessionManager', () => {
  test('shared permission revocation clears real operation grants only for the matching workspace', async () => {
    const input = { file_path: join(outside, 'requested.txt') }
    const first = beginPermission('Read', input)
    expect(manager.respondToPermission(sessionId, first.request.requestId, true, false)).toBe(true)
    expect((await first.result).allowed).toBe(true)
    const other = manager.sessions.get(otherSessionId)!
    other.executionPolicy = setSessionExecutionPolicy(otherSessionId, { ...managed.executionPolicy! })
    other.workspace = { ...other.workspace, id: 'different-workspace' }
    manager.attachNodePermissionHandler(other)
    const result = authorizeSessionPolicyTool(otherSessionId, 'Read', input, root)
    const event = events.findLast((item): item is PermissionEvent => item.type === 'permission_request' && item.sessionId === otherSessionId)!
    expect(manager.respondToPermission(otherSessionId, event.request.requestId, true, false)).toBe(true)
    expect((await result).allowed).toBe(true)
    expect(hasSessionPolicyToolGrant(sessionId, 'Read', input, root)).toBe(true)
    expect(hasSessionPolicyToolGrant(otherSessionId, 'Read', input, root)).toBe(true)
    manager.clearSuperAgentPermissionGrants('workspace')
    expect(hasSessionPolicyToolGrant(sessionId, 'Read', input, root)).toBe(false)
    expect(hasSessionPolicyToolGrant(otherSessionId, 'Read', input, root)).toBe(true)
  })

  test('full control runs localbash on the connected client without an approval record', async () => {
    managed.executionPolicy = setSessionExecutionPolicy(sessionId, { ...managed.executionPolicy!, fullControl: true });
    const args = { command: 'echo test', cwd: outside, timeoutMs: 1_000 };
    expect((await authorizeSessionPolicyTool(sessionId, localTool, args, root)).allowed).toBe(true);
    expect((await manager.runSessionLocalShell(managed, args)).stdout).toBe('client-a');
    expect(invocations).toEqual([{ clientId: 'client-a', capability: CLIENT_RUN_SHELL, args }]);
    expect(events.some(event => event.type === 'permission_request')).toBe(false);
    expect(manager.pendingNodePermissions.size).toBe(0);
  })

  test('full control does not emit approvals for outside reads, browser operations or unassigned sources', async () => {
    managed.executionPolicy = setSessionExecutionPolicy(sessionId, { ...managed.executionPolicy!, fullControl: true })
    const operations = [
      ['Read', { file_path: join(outside, 'requested.txt') }],
      ['mcp__session__browser_tool', { command: ['upload', '@e1', join(outside, 'requested.txt')] }],
      ['mcp__unassigned__execute_code', { code: 'actual source tool' }],
    ] as const
    for (const [toolName, input] of operations) expect((await authorizeSessionPolicyTool(sessionId, toolName, input, root)).allowed).toBe(true)
    expect((await authorizeSessionPolicyTool(sessionId, 'mcp__session__spawn_agent', {}, root)).allowed).toBe(false)
    expect((await authorizeSessionPolicyTool(sessionId, 'mcp__session__call_llm', {}, root)).allowed).toBe(false)
    expect((await authorizeSessionPolicyTool(sessionId, 'WebFetch', { url: 'https://example.test' }, root)).allowed).toBe(false)
    expect(events).toHaveLength(0)
    expect(manager.pendingNodePermissions.size).toBe(0)
    expect(manager.pendingPermissionRequests.size).toBe(0)
  })

  test('full control answers native file and admin callbacks directly and keeps structural calls blocked', () => {
    managed.executionPolicy = setSessionExecutionPolicy(sessionId, { ...managed.executionPolicy!, fullControl: true })
    const responses: unknown[] = []
    managed.agent = { forceAbort: () => {}, respondToPermission: (...args) => { responses.push(args) } }
    expect(manager.autoRespondToNodeRuntimePermission(managed, { requestId: 'native-write', toolName: 'Write', description: 'Write outside', type: 'file_write' })).toBe(true)
    expect(manager.autoRespondToNodeRuntimePermission(managed, { requestId: 'native-admin', toolName: 'Bash', command: 'sudo arbitrary-command', description: 'Run a program', type: 'admin_approval' })).toBe(true)
    expect(manager.autoRespondToNodeRuntimePermission(managed, { requestId: 'native-delegate', toolName: 'spawn_agent', description: 'Spawn another model' })).toBe(true)
    expect(responses).toEqual([
      ['native-write', true, false], ['native-admin', true, false], ['native-delegate', false, false],
    ])
    expect(events).toHaveLength(0)
    expect(manager.pendingNodePermissions.size).toBe(0)
    expect(manager.pendingPermissionRequests.size).toBe(0)
    managed.stopRequested = true
    manager.autoRespondToNodeRuntimePermission(managed, { requestId: 'stopped-native', toolName: 'Write', description: 'Late callback' })
    expect(responses.at(-1)).toEqual(['stopped-native', false, false])
    managed.stopRequested = false
    managed.executionPolicy = setSessionExecutionPolicy(sessionId, { ...managed.executionPolicy!, fullControl: false })
    expect(manager.autoRespondToNodeRuntimePermission(managed, { requestId: 'limited-native', toolName: 'Write', description: 'Needs normal approval' })).toBe(false)
    expect(responses).toHaveLength(4)
  })

  test('a response from another session leaves the original request pending', async () => {
    const input = { file_path: join(outside, 'requested.txt') }
    const { result, request } = beginPermission('Read', input)
    expect(manager.respondToPermission(otherSessionId, request.requestId, true, true)).toBe(false)
    expect(manager.pendingNodePermissions.has(request.requestId)).toBe(true)
    expect(manager.pendingPermissionRequests.has(request.requestId)).toBe(true)
    expect(hasSessionPolicyToolGrant(sessionId, 'Read', input, root)).toBe(false)
    expect(manager.respondToPermission(sessionId, request.requestId, true, false)).toBe(true)
    expect((await result).allowed).toBe(true)
    expect(manager.pendingNodePermissions.size).toBe(0)
    expect(manager.pendingPermissionRequests.size).toBe(0)
  })

  test('alwaysAllow grants only the requested operation in the current turn', async () => {
    const input = { file_path: join(outside, 'requested.txt') }
    const { result, request } = beginPermission('Read', input)
    expect(manager.respondToPermission(sessionId, request.requestId, true, true)).toBe(true)
    expect((await result).allowed).toBe(true)
    expect(checkSessionExecutionPolicy(sessionId, 'Read', input, root).allowed).toBe(true)
    expect(checkSessionExecutionPolicy(sessionId, 'Read', { file_path: join(outside, 'other.txt') }, root).allowed).toBe(false)
    manager.clearPendingPermissionRequestsForSession(sessionId)
    expect(checkSessionExecutionPolicy(sessionId, 'Read', input, root).allowed).toBe(false)
    expect(manager.respondToPermission(sessionId, request.requestId, true, true)).toBe(false)
  })

  test('an expired reply denies and resolves the suspended tool', async () => {
    const input = { file_path: join(outside, 'requested.txt') }
    const { result, request } = beginPermission('Read', input)
    manager.pendingNodePermissions.get(request.requestId)!.expiresAt = Date.now() - 1
    expect(manager.respondToPermission(sessionId, request.requestId, true, true)).toBe(false)
    expect((await result).allowed).toBe(false)
    expect(hasSessionPolicyToolGrant(sessionId, 'Read', input, root)).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'permission_resolved', requestId: request.requestId, allowed: false, reason: 'expired' })
    expect(manager.pendingNodePermissions.size).toBe(0)
    expect(manager.pendingPermissionRequests.size).toBe(0)
  })

  test('the approval deadline resolves without a renderer response', async () => {
    jest.useFakeTimers()
    usingFakeTimers = true
    const { result, request } = beginPermission('Read', { file_path: join(outside, 'requested.txt') })
    jest.advanceTimersByTime(10 * 60_000 + 1)
    expect((await result).allowed).toBe(false)
    expect(manager.pendingNodePermissions.size).toBe(0)
    expect(manager.pendingPermissionRequests.size).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'permission_resolved', requestId: request.requestId, allowed: false, reason: 'expired' })
  })

  test('cancellation resolves the waiting call and invalidates approvals already given', async () => {
    const args = { command: 'echo granted', cwd: root }
    await approveLocalShell(args)
    const { result, request } = beginPermission('Read', { file_path: join(outside, 'requested.txt') })
    manager.clearPendingPermissionRequestsForSession(sessionId)
    expect((await result).allowed).toBe(false)
    expect(hasSessionPolicyToolGrant(sessionId, localTool, args, root)).toBe(false)
    expect(manager.pendingNodePermissions.size).toBe(0)
    expect(manager.pendingPermissionRequests.size).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'permission_resolved', requestId: request.requestId, allowed: false, reason: 'cancelled' })
    expect(manager.respondToPermission(sessionId, request.requestId, true, true)).toBe(false)
  })

  test('stopped or replaced managed sessions cannot create new approvals', async () => {
    const input = { file_path: join(outside, 'requested.txt') }
    managed.stopRequested = true
    expect((await authorizeSessionPolicyTool(sessionId, 'Read', input, root)).allowed).toBe(false)
    managed.stopRequested = false
    manager.sessions.set(sessionId, { ...managed })
    expect((await authorizeSessionPolicyTool(sessionId, 'Read', input, root)).allowed).toBe(false)
    expect(events).toHaveLength(0)
    expect(manager.pendingNodePermissions.size).toBe(0)
  })

  test('retired sessions reject pending replies and new requests', async () => {
    const input = { file_path: join(outside, 'requested.txt') }
    const { result, request } = beginPermission('Read', input)
    managed.persistenceRetired = true
    expect(manager.respondToPermission(sessionId, request.requestId, true, true)).toBe(false)
    expect((await result).allowed).toBe(false)
    expect((await authorizeSessionPolicyTool(sessionId, 'Read', input, root)).allowed).toBe(false)
    expect(events.filter(event => event.type === 'permission_request')).toHaveLength(1)
    expect(hasSessionPolicyToolGrant(sessionId, 'Read', input, root)).toBe(false)
    expect(manager.pendingNodePermissions.size).toBe(0)
  })

  test('a runtime being torn down cannot approve or create an operation', async () => {
    const input = { file_path: join(outside, 'requested.txt') }
    const { result, request } = beginPermission('Read', input)
    managed.runtimeTeardown = Promise.resolve()
    expect(manager.respondToPermission(sessionId, request.requestId, true, true)).toBe(false)
    expect((await result).allowed).toBe(false)
    expect((await authorizeSessionPolicyTool(sessionId, 'Read', input, root)).allowed).toBe(false)
    expect(events.filter(event => event.type === 'permission_request')).toHaveLength(1)
    expect(hasSessionPolicyToolGrant(sessionId, 'Read', input, root)).toBe(false)
  })

  test('deletion cancels permissions before attempting to abort a failing backend', async () => {
    const args = { command: 'echo previously-approved', cwd: root }
    await approveLocalShell(args)
    const { result, request } = beginPermission('Read', { file_path: join(outside, 'requested.txt') })
    managed.agent = { forceAbort: () => { throw new Error('Backend abort failure') } }
    await expect(manager.deleteSession(sessionId)).rejects.toThrow('Backend abort failure')
    expect((await result).allowed).toBe(false)
    expect(managed.persistenceRetired).toBe(true)
    expect(manager.pendingNodePermissions.size).toBe(0)
    expect(manager.pendingPermissionRequests.size).toBe(0)
    expect(hasSessionPolicyToolGrant(sessionId, localTool, args, root)).toBe(false)
    expect(manager.respondToPermission(sessionId, request.requestId, true, true)).toBe(false)
  })
})

describe('localbash approval binds the real execution destination', () => {
  test('verified system metadata inspections use the actual connected client without an exact grant', async () => {
    const args = { command: 'uname -a && df -h', cwd: root }
    expect((await authorizeSessionPolicyTool(sessionId, localTool, args, root)).allowed).toBe(true)
    expect((await manager.runSessionLocalShell(managed, args)).stdout).toBe('client-a')
    expect(invocations).toHaveLength(1)
    expect(hasSessionPolicyToolGrant(sessionId, localTool, args, root)).toBe(false)
    expect(events).toHaveLength(0)
  })

  test('full control selects the current actual client and can fall back to host without stale grants', async () => {
    managed.executionPolicy = setSessionExecutionPolicy(sessionId, { ...managed.executionPolicy!, fullControl: true })
    const args = { command: 'echo full-control-host', cwd: outside, timeoutMs: 1000 }
    clients = ['client-b', 'client-a']
    expect((await manager.runSessionLocalShell(managed, args)).stdout).toBe('client-b')
    clients = []
    const hostResult = await manager.runSessionLocalShell(managed, args)
    expect(hostResult.exitCode).toBe(0)
    expect(hostResult.cwd).toBe(outside)
    expect(hostResult.stdout.trim()).toBe('full-control-host')
    expect(invocations).toHaveLength(1)
    expect(hasSessionPolicyToolGrant(sessionId, localTool, args, root)).toBe(false)
    expect(events).toHaveLength(0)
    managed.executionPolicy = setSessionExecutionPolicy(sessionId, { ...managed.executionPolicy!, fullControl: false })
    await expect(manager.runSessionLocalShell(managed, args)).rejects.toThrow('request permission again')
  })
  test('client reordering cannot redirect an approved operation', async () => {
    const args = { command: 'echo requested', cwd: root, timeoutMs: 1000 }
    const request = await approveLocalShell(args)
    expect(request.policyScope).toMatchObject({ target: 'client:client-a', boundary: 'client' })
    expect(JSON.parse(request.policyScope!.operation)).toEqual(args)
    clients = ['client-b', 'client-a']
    expect((await manager.runSessionLocalShell(managed, args)).stdout).toBe('client-a')
    expect(invocations).toEqual([{ clientId: 'client-a', capability: CLIENT_RUN_SHELL, args }])
  })

  test('a disappearing approved client cannot fall back to the host or another client', async () => {
    const args = { command: 'echo requested', cwd: root }
    await approveLocalShell(args)
    clients = ['client-b']
    await expect(manager.runSessionLocalShell(managed, args)).rejects.toThrow('approved localbash execution target is no longer available')
    clients = []
    await expect(manager.runSessionLocalShell(managed, args)).rejects.toThrow('approved localbash execution target is no longer available')
    expect(invocations).toHaveLength(0)
  })

  test('changed commands cannot reuse a client approval', async () => {
    const args = { command: 'echo requested', cwd: root }
    await approveLocalShell(args)
    await expect(manager.runSessionLocalShell(managed, { ...args, command: 'echo different' })).rejects.toThrow('request permission again')
    expect(invocations).toHaveLength(0)
  })

  test('host approval remains on the host when a new client connects', async () => {
    clients = []
    const args = { command: 'echo host-policy-dispatch', cwd: root, timeoutMs: 1000 }
    const request = await approveLocalShell(args)
    expect(request.policyScope).toMatchObject({ target: 'host:workspace', boundary: 'host' })
    expect(getSessionPolicyGrantTarget(sessionId, localTool, args, root)).toBe('host:workspace')
    clients = ['client-b']
    const result = await manager.runSessionLocalShell(managed, args)
    expect(result.stdout.trim()).toBe('host-policy-dispatch')
    expect(result.exitCode).toBe(0)
    expect(invocations).toHaveLength(0)
  })

  test('ordinary sessions retain client dispatch without a node grant', async () => {
    const ordinary = { ...managed, executionPolicy: undefined }
    const args = { command: 'echo ordinary', cwd: root }
    expect((await manager.runSessionLocalShell(ordinary, args)).stdout).toBe('client-a')
    expect(invocations).toHaveLength(1)
    expect(events).toHaveLength(0)
  })

  test('full control bypasses gates and backend approval; disabling it restores one-time gates', async () => {
    managed.executionPolicy = setSessionExecutionPolicy(sessionId, { ...managed.executionPolicy!, actionGates: true, fullControl: true })
    manager.attachNodePermissionHandler(managed)
    const input = { file_path: join(root, 'approved.txt'), content: 'approved' }
    expect((await authorizeSessionPolicyTool(sessionId, 'Write', input, root)).allowed).toBe(true)
    expect(events).toHaveLength(0)
    const responses: boolean[] = []
    managed.agent = { forceAbort: () => {}, respondToPermission: (_id, allowed) => { responses.push(allowed) } }
    const runtime = join(temp, 'docker.exe'); writeFileSync(runtime, 'test runtime')
    setSessionProgramExecutor(sessionId, { runtimePath: runtime, containerId: 'test-container', workingDirectory: '/workspace' })
    expect(manager.autoRespondToNodeRuntimePermission(managed, { requestId: 'backend', toolName: 'Bash', command: 'echo direct', description: 'program' })).toBe(true)
    expect(responses).toEqual([true])
    managed.executionPolicy = setSessionExecutionPolicy(sessionId, { ...managed.executionPolicy!, fullControl: false })
    manager.attachNodePermissionHandler(managed)
    const pending = authorizeSessionPolicyTool(sessionId, 'Write', input, root, undefined, 'write-once')
    const event = events.find((event): event is PermissionEvent => event.type === 'permission_request')!
    expect(event).toBeDefined()
    expect(event.request.policyScope?.actionGate?.invocationId).toBe('write-once')
    expect(manager.respondToPermission(sessionId, event.request.requestId, true, true)).toBe(true)
    expect((await pending).allowed).toBe(true)
    expect(manager.pendingNodePermissions.size).toBe(0)
    expect(manager.autoRespondToNodeRuntimePermission(managed, { requestId: 'backend', toolName: 'Write', description: 'write' })).toBe(false)
    const second = authorizeSessionPolicyTool(sessionId, 'Write', input, root, undefined, 'write-again')
    const secondEvent = events.filter((event): event is PermissionEvent => event.type === 'permission_request').at(-1)!
    expect(secondEvent.request.requestId).not.toBe(event.request.requestId)
    manager.respondToPermission(sessionId, secondEvent.request.requestId, false, false)
    expect((await second).allowed).toBe(false)
  })
})
