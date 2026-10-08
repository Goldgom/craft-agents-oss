import { describe, expect, test } from 'bun:test'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionPolicyPermissionScope } from '@craft-agent/core/types'
import { canShareSuperAgentPermission, loadSuperAgentDocument, matchesSuperAgentPermissionGrant, superAgentPermissionEnvironmentKey,
  validateSuperAgentCommand, type SuperAgentPermissionGrant } from '@craft-agent/shared/super-agent'
import { SuperAgentService, type SuperAgentServiceDeps } from './SuperAgentService'
import type { ISessionManager } from '../handlers/session-manager-interface'
import { cleanupSuperAgents, getSuperAgentService } from './registry'
import { superAgentFixture, SuperAgentTestHost, until } from './SuperAgentTestSupport'

async function permissionTeam() {
  const fixture = await superAgentFixture()
  fixture.config.nodes.push({ ...fixture.config.nodes[1]!, id: 'second', name: 'Second worker' })
  await fixture.service.save('alpha', fixture.config)
  for (const nodeId of ['worker', 'second']) await fixture.service.command('alpha', { type: 'task', nodeId, title: 'Protected operation', instructions: 'Execute the authorized task' })
  const snapshot = await until(() => fixture.service.get('alpha'), value => value.state.tasks.filter(task => task.status === 'running').length === 2)
  const sessions = Object.fromEntries(snapshot.state.nodes.flatMap(node => node.sessionId ? [[node.nodeId, node.sessionId]] : []))
  const scope: SessionPolicyPermissionScope = { kind: 'program', target: 'client:desktop-a', toolName: 'mcp__session__localbash',
    operation: JSON.stringify({ command: 'echo approved', cwd: fixture.workingDirectory, timeoutMs: 1_000 }), boundary: 'client', expiresAt: fixture.now() + 600_000 }
  return { ...fixture, sessions, scope }
}

async function requestOperation(team: Awaited<ReturnType<typeof permissionTeam>>, id: string, nodeId = 'worker', scope = team.scope) {
  const result = team.host.requestPermission(team.sessions[nodeId]!, { requestId: id, toolName: scope.toolName, description: 'Exact protected operation', policyScope: scope })
  await until(() => team.service.get('alpha'), snapshot => snapshot.permissionRequests?.some(request => request.id === id) === true)
  return { result }
}

async function shareOperation(team: Awaited<ReturnType<typeof permissionTeam>>) {
  const { result } = await requestOperation(team, 'original')
  const snapshot = await team.service.command('alpha', { type: 'permission-response', requestId: 'original', allowed: true, remember: true })
  expect(await result).toBe(true)
  return snapshot.state.permissionGrants![0]!
}

describe('Super Agent shared permission management', () => {
  test('the production registry forwards permission invalidation to the session manager', async () => {
    const host = new SuperAgentTestHost()
    const manager = host as unknown as ISessionManager
    const service = getSuperAgentService(manager)
    try {
      const executionHost = (service as unknown as { deps: SuperAgentServiceDeps }).deps.host
      expect(executionHost.clearSuperAgentPermissionGrants).toBeTypeOf('function')
      executionHost.clearSuperAgentPermissionGrants!('alpha')
      expect(host.permissionGrantClears).toEqual(['alpha'])
    } finally { await cleanupSuperAgents(manager) }
  })

  test('ordinary approval remains temporary and does not approve another node', async () => {
    const team = await permissionTeam()
    const first = await requestOperation(team, 'once')
    const snapshot = await team.service.command('alpha', { type: 'permission-response', requestId: 'once', allowed: true })
    expect(await first.result).toBe(true)
    expect(snapshot.state.permissionGrants ?? []).toEqual([])
    const second = await requestOperation(team, 'other', 'second')
    expect((await team.service.get('alpha')).permissionRequests!.find(request => request.id === 'other')!.status).toBe('pending')
    await team.service.command('alpha', { type: 'permission-response', requestId: 'other', allowed: false })
    expect(await second.result).toBe(false)
  })

  test('explicitly remembered operations are shared by nodes and survive a service restart', async () => {
    const team = await permissionTeam()
    const grant = await shareOperation(team)
    expect(grant.scope).not.toHaveProperty('expiresAt')
    const shared = await requestOperation(team, 'shared', 'second', { ...team.scope, expiresAt: team.now() + 300_000 })
    expect(await shared.result).toBe(true)
    const snapshot = await until(() => team.service.get('alpha'), value => value.permissionRequests!.find(request => request.id === 'shared')?.status === 'approved')
    expect(snapshot.state.permissionGrants).toHaveLength(1)
    expect(team.host.permissionResponses.at(-1)).toMatchObject({ requestId: 'shared', allowed: true, alwaysAllow: false })
    expect((await loadSuperAgentDocument(join(team.root, 'alpha'))).state.permissionGrants).toEqual([grant])
    await team.service.cleanup()
    const restarted = new SuperAgentService({ host: new SuperAgentTestHost(), rootForWorkspace: workspaceId => join(team.root, workspaceId), now: team.now, autoTick: false })
    try { expect((await restarted.get('alpha')).state.permissionGrants).toEqual([grant]) } finally { await restarted.cleanup() }
  })

  test('changed tools, inputs, clients or boundaries require a fresh user decision', async () => {
    const team = await permissionTeam()
    await shareOperation(team)
    const changed = [
      { ...team.scope, toolName: 'mcp__session__runshell' },
      { ...team.scope, operation: JSON.stringify({ command: 'echo different', cwd: team.workingDirectory, timeoutMs: 1_000 }) },
      { ...team.scope, target: 'client:desktop-b' },
      { ...team.scope, boundary: 'host' as const },
    ]
    for (const [index, scope] of changed.entries()) {
      const id = `changed-${index}`
      const request = await requestOperation(team, id, 'second', scope)
      expect((await team.service.get('alpha')).permissionRequests!.find(item => item.id === id)!.status).toBe('pending')
      await team.service.command('alpha', { type: 'permission-response', requestId: id, allowed: false })
      expect(await request.result).toBe(false)
    }
  })

  test('an identical operation in another workspace does not inherit team approvals', async () => {
    const team = await permissionTeam()
    await shareOperation(team)
    await team.service.save('beta', team.config)
    await team.service.command('beta', { type: 'task', nodeId: 'worker', title: 'Other workspace', instructions: 'Execute the bounded task' })
    const other = await until(() => team.service.get('beta'), value => value.state.tasks[0]?.status === 'running')
    const sessionId = other.state.nodes.find(node => node.nodeId === 'worker')!.sessionId!
    const result = team.host.requestPermission(sessionId, { requestId: 'beta-request', toolName: team.scope.toolName, description: 'Same operation', policyScope: team.scope })
    const pending = await until(() => team.service.get('beta'), value => value.permissionRequests!.some(request => request.id === 'beta-request'))
    expect(pending.state.permissionGrants ?? []).toEqual([])
    expect(pending.permissionRequests!.find(request => request.id === 'beta-request')!.status).toBe('pending')
    await team.service.command('beta', { type: 'permission-response', requestId: 'beta-request', allowed: false })
    expect(await result).toBe(false)
  })

  test('model action blocks cannot create or revoke user-owned shared permissions', async () => {
    const team = await permissionTeam()
    const grant = await shareOperation(team)
    team.host.complete(team.sessions.second!, `<super_agent_actions>${JSON.stringify({ permissionGrants: [], permissionResponse: { requestId: 'original', allowed: true, remember: true } })}</super_agent_actions>`)
    const snapshot = await until(() => team.service.get('alpha'), value => value.state.tasks.some(task => task.nodeId === 'second' && !!task.actionReceipt))
    expect(snapshot.state.tasks.find(task => task.nodeId === 'second')!.actionReceipt!.status).toBe('rejected')
    expect(snapshot.state.permissionGrants).toEqual([grant])
  })

  test('revocation clears all node grant caches and future matching requests await approval', async () => {
    const team = await permissionTeam()
    const grant = await shareOperation(team)
    const snapshot = await team.service.command('alpha', { type: 'permission-revoke', grantId: grant.id })
    expect(snapshot.state.permissionGrants).toEqual([])
    expect(team.host.permissionGrantClears).toEqual(['alpha'])
    expect((await loadSuperAgentDocument(join(team.root, 'alpha'))).state.permissionGrants).toEqual([])
    const next = await requestOperation(team, 'after-revoke', 'second')
    expect((await team.service.get('alpha')).permissionRequests!.find(item => item.id === 'after-revoke')!.status).toBe('pending')
    await team.service.command('alpha', { type: 'permission-response', requestId: 'after-revoke', allowed: false })
    expect(await next.result).toBe(false)
  })

  test('unsupported browser and unscoped approvals cannot become durable permissions', async () => {
    const team = await permissionTeam()
    const browser = await requestOperation(team, 'browser', 'worker', { ...team.scope, kind: 'browser', target: 'browser_tool', operation: '"click 1"' })
    await expect(team.service.command('alpha', { type: 'permission-response', requestId: 'browser', allowed: true, remember: true })).rejects.toThrow('exact file or program')
    await team.service.command('alpha', { type: 'permission-response', requestId: 'browser', allowed: false })
    expect(await browser.result).toBe(false)
    const result = team.host.requestPermission(team.sessions.worker!, { requestId: 'unscoped', toolName: 'Bash', description: 'Generic approval' })
    await until(() => team.service.get('alpha'), value => value.permissionRequests!.some(request => request.id === 'unscoped'))
    await expect(team.service.command('alpha', { type: 'permission-response', requestId: 'unscoped', allowed: true, remember: true })).rejects.toThrow('exact file or program')
    await team.service.command('alpha', { type: 'permission-response', requestId: 'unscoped', allowed: true })
    expect(await result).toBe(true)
    expect((await team.service.get('alpha')).state.permissionGrants ?? []).toEqual([])
  })

  test('expired requests cannot create or reuse a shared permission', async () => {
    const team = await permissionTeam()
    await shareOperation(team)
    const expired = await requestOperation(team, 'expired', 'second', { ...team.scope, expiresAt: team.now() - 1 })
    expect(await expired.result).toBe(false)
    await expect(team.service.command('alpha', { type: 'permission-response', requestId: 'expired', allowed: true, remember: true })).rejects.toThrow('no longer pending')
    expect((await team.service.get('alpha')).state.permissionGrants).toHaveLength(1)
  })

  test('a storage failure does not approve the request or leave a reusable in-memory permission', async () => {
    const team = await permissionTeam()
    const request = await requestOperation(team, 'save-failure')
    const statePath = join(team.root, 'alpha', 'super-agent', 'state.json')
    const backup = `${statePath}.backup`
    await rename(statePath, backup)
    await mkdir(statePath)
    try {
      await expect(team.service.command('alpha', { type: 'permission-response', requestId: 'save-failure', allowed: true, remember: true })).rejects.toThrow()
      expect((await team.service.get('alpha')).state.permissionGrants ?? []).toEqual([])
      expect(team.host.permissionResponses).toEqual([])
    } finally {
      await rm(statePath, { recursive: true, force: true })
      await rename(backup, statePath)
    }
    await team.service.command('alpha', { type: 'permission-response', requestId: 'save-failure', allowed: false })
    expect(await request.result).toBe(false)
  })

  test('grants match an environment and never match a different scope or unrelated workspace state', async () => {
    const { config } = await superAgentFixture()
    const scope: SessionPolicyPermissionScope = { kind: 'file_read', toolName: 'Read', target: 'C:/data/report.txt', operation: '{"file_path":"C:/data/report.txt"}', boundary: 'outside-environment', expiresAt: 10_000 }
    const { expiresAt, ...savedScope } = scope
    const grant: SuperAgentPermissionGrant = { id: 'grant', nodeId: 'worker', description: 'Read file', scope: savedScope,
      environmentKey: superAgentPermissionEnvironmentKey(config.environment), createdAt: 1 }
    expect(matchesSuperAgentPermissionGrant(grant, scope, config.environment)).toBe(true)
    for (const environment of [
      { ...config.environment, workingDirectory: `${config.environment.workingDirectory}-different` },
      { ...config.environment, kind: 'vm' as const, vm: { workspaceId: 'remote' } },
    ]) expect(matchesSuperAgentPermissionGrant(grant, scope, environment)).toBe(false)
    expect(canShareSuperAgentPermission()).toBe(false)
    expect(canShareSuperAgentPermission({ ...scope, kind: 'browser' })).toBe(false)
    expect(canShareSuperAgentPermission({ ...scope, kind: 'source' })).toBe(false)
    expect(validateSuperAgentCommand({ type: 'permission-response', requestId: 'request', allowed: true, remember: true })).toMatchObject({ remember: true })
    expect(() => validateSuperAgentCommand({ type: 'permission-revoke', grantId: '__proto__' })).toThrow()
  })
})
