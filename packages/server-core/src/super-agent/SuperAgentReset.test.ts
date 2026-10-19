import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session } from '@tokenbird/shared/protocol'
import { loadSuperAgentDocument, validateSuperAgentCommand } from '@tokenbird/shared/super-agent'
import { SuperAgentService } from './SuperAgentService'
import { superAgentFixture, until, type SuperAgentTestHost } from './SuperAgentTestSupport'

function resetHost(host: SuperAgentTestHost) {
  const deleted: string[] = []
  return Object.assign(host, {
    deleted,
    getSessions(workspaceId?: string): Session[] {
      return [...host.sessions.values()].filter(session => !workspaceId || session.workspaceId === workspaceId)
        .map(session => ({ workspaceName: 'Test', messages: [], lastMessageAt: 0, ...session }))
    },
    getSuperAgentSessionIds(workspaceId: string): string[] {
      return [...host.policies.keys()].filter(id => host.sessions.get(id)?.workspaceId === workspaceId)
    },
    async deleteSession(id: string, guard?: { workspaceId: string; lastMessageAt: number; onlyIdle: true; superAgentReset?: true }) {
      const session = host.sessions.get(id)
      if (!session || !guard?.superAgentReset || session.workspaceId !== guard.workspaceId || session.isProcessing) throw new Error('Unsafe session deletion')
      deleted.push(id); host.sessions.delete(id); host.policies.delete(id)
    },
  })
}

describe('Super Agent complete reset', () => {
  test('requires explicit confirmation', () => {
    expect(() => validateSuperAgentCommand({ type: 'reset' })).toThrow()
    expect(() => validateSuperAgentCommand({ type: 'reset', confirmed: false })).toThrow()
    expect(validateSuperAgentCommand({ type: 'reset', confirmed: true })).toEqual({ type: 'reset', confirmed: true })
    expect(validateSuperAgentCommand({ type: 'reset', confirmed: true, preserveConfig: true })).toEqual({ type: 'reset', confirmed: true, preserveConfig: true })
    expect(() => validateSuperAgentCommand({ type: 'reset', confirmed: true, preserveConfig: 'yes' })).toThrow()
  })

  test('clears all team data while keeping exact settings and fresh usable node and script runtimes', async () => {
    const f = await superAgentFixture()
    const host = resetHost(f.host)
    const config = { ...f.config, continuousWork: true,
      environment: { ...f.config.environment, fullControl: true },
      scripts: [{ id: 'registered', name: 'Keep registration', path: 'worker.js', args: ['--check'], timeoutSeconds: 60 }] }
    await f.service.save('alpha', config)
    const savedConfig = structuredClone((await f.service.get('alpha')).config)
    await f.service.command('alpha', { type: 'board-upsert', item: { title: 'Old board', content: 'Old data' } })
    await f.service.command('alpha', { type: 'memory-upsert', item: { title: 'Old memory', content: 'Old data', category: 'fact', tags: [], evidence: '' }, expectedRevision: 0 })
    await writeFile(join(f.workingDirectory, 'report.md'), 'Keep project file')
    await f.service.command('alpha', { type: 'archive-create', item: { title: 'Old archive', sourcePath: 'report.md', description: '', versionLabel: '', tags: [] } })
    await f.service.command('alpha', { type: 'task', title: 'Old task', instructions: 'Old instructions' })
    await until(() => f.service.get('alpha'), () => host.sends.length === 1)
    const oldSession = host.sends[0]!.sessionId
    host.sessions.set('retired', { ...host.sessions.get(oldSession)!, id: 'retired', isProcessing: false })
    host.policies.set('retired', host.policies.get(oldSession)!)
    host.sessions.set('ordinary', { id: 'ordinary', workspaceId: 'alpha', isProcessing: false })
    const directory = join(f.root, 'alpha', 'super-agent')
    await mkdir(join(directory, 'history'), { recursive: true })
    await writeFile(join(directory, 'history', 'old.json'), 'Old history')
    const oldRevision = (await f.service.get('alpha')).state.revision

    const result = await f.service.command('alpha', { type: 'reset', confirmed: true, preserveConfig: true })
    expect(result.config).toEqual(savedConfig)
    expect(result.state.revision).toBeGreaterThan(oldRevision)
    expect(result.state.nodes).toEqual(config.nodes.map(node => ({ nodeId: node.id, status: 'idle' })))
    expect(result.state.scripts).toEqual([{ scriptId: 'registered', status: 'idle' }])
    for (const key of ['tasks', 'messages', 'plans', 'board', 'memories', 'archives', 'artifacts', 'operations', 'permissionGrants'] as const) {
      expect(result.state[key] ?? []).toEqual([])
    }
    expect(result.state.statistics).toBeUndefined()
    expect(result.activity).toEqual([])
    expect(result.permissionRequests).toEqual([])
    expect(host.deleted.sort()).toEqual([oldSession, 'retired'].sort())
    expect(host.sessions.has('ordinary')).toBe(true)
    expect(host.fullControlChanges.some(change => change.workspaceId === 'alpha' && !change.enabled)).toBe(false)
    expect(host.permissionGrantClears).toContain('alpha')
    expect(await readFile(join(f.workingDirectory, 'report.md'), 'utf8')).toBe('Keep project file')
    await expect(access(join(directory, 'history'))).rejects.toThrow()
    await expect(access(join(directory, 'archive'))).rejects.toThrow()
    for (const name of ['commit.json', 'state.json']) {
      const document = JSON.parse(await readFile(join(directory, name), 'utf8'))
      expect(document.config).toEqual(savedConfig)
      expect(document.pendingTurns).toEqual([])
      expect(document.failedTurns).toEqual([])
      expect(JSON.stringify(document)).not.toContain('Old instructions')
    }
    for (const listener of host.listeners) listener({ workspaceId: 'alpha', sessionId: oldSession, reason: 'complete', finalText: 'Late old answer' })
    await f.service.tick()
    expect((await f.service.get('alpha')).state.messages).toEqual([])
    const restarted = new SuperAgentService({ host, rootForWorkspace: id => join(f.root, id), autoTick: false })
    try {
      expect((await restarted.get('alpha')).config).toEqual(savedConfig)
      await restarted.command('alpha', { type: 'task', title: 'New task', instructions: 'New work' })
      const next = await until(() => restarted.get('alpha'), s => s.state.tasks[0]?.status === 'running' && host.sends.length === 2)
      expect(next.state.tasks[0]!.sessionId).not.toBe(oldSession)
      expect(next.state.tasks).toHaveLength(1)
    } finally { await restarted.cleanup() }
  })

  test('stops active nodes and deletes current and retired content, while preserving other work', async () => {
    const fixture = await superAgentFixture()
    const { service, config, root, workingDirectory } = fixture
    const host = resetHost(fixture.host)
    await service.save('alpha', { ...config, continuousWork: true })
    await service.command('alpha', { type: 'board-upsert', item: { title: 'Memory', content: 'Private history' } })
    await service.command('alpha', { type: 'memory-upsert', item: { title: 'Memory entry', content: 'Private memory', category: 'fact', tags: [], evidence: '' }, expectedRevision: 0 })
    await writeFile(join(workingDirectory, 'snapshot.txt'), 'Private archive')
    await service.command('alpha', { type: 'archive-create', item: { title: 'Archive entry', sourcePath: 'snapshot.txt', description: '', versionLabel: '', tags: [] } })
    await service.command('alpha', { type: 'chat', text: 'Old goal' })
    await until(() => service.get('alpha'), snapshot => snapshot.state.nodes.some(node => node.status === 'working'))
    const sessionId = host.sends[0]!.sessionId
    host.sessions.set('retired', { ...host.sessions.get(sessionId)!, id: 'retired', isProcessing: false })
    host.policies.set('retired', host.policies.get(sessionId)!)
    host.sessions.set('ordinary', { id: 'ordinary', workspaceId: 'alpha', isProcessing: false })
    host.sessions.set('other-team', { id: 'other-team', workspaceId: 'beta', isProcessing: false })
    host.policies.set('other-team', host.policies.get(sessionId)!)
    await service.save('beta', config)
    const directory = join(root, 'alpha', 'super-agent')
    await mkdir(join(directory, 'history'), { recursive: true })
    await writeFile(join(directory, 'history', 'old.json'), 'Private history')
    await writeFile(join(workingDirectory, 'project.txt'), 'Keep project')
    await mkdir(join(root, 'alpha', 'sources'), { recursive: true })
    await writeFile(join(root, 'alpha', 'sources', 'source.json'), 'Keep source')

    const snapshot = await service.command('alpha', { type: 'reset', confirmed: true })
    expect(snapshot.config).toBeNull()
    for (const key of ['nodes', 'tasks', 'messages', 'plans', 'board', 'scripts'] as const) expect(snapshot.state[key]).toEqual([])
    expect(snapshot.state.memories ?? []).toEqual([])
    expect(snapshot.state.archives ?? []).toEqual([])
    expect(snapshot.state.statistics).toBeUndefined()
    expect(snapshot.activity).toEqual([])
    expect(snapshot.permissionRequests).toEqual([])
    expect(host.cancelled).toContain(sessionId)
    expect(host.deleted.sort()).toEqual([sessionId, 'retired'].sort())
    expect(host.permissionGrantClears).toContain('alpha')
    expect(host.sessions.has('ordinary')).toBe(true)
    expect(host.sessions.has('other-team')).toBe(true)
    expect((await service.get('beta')).config).toEqual(config)
    expect(await readFile(join(workingDirectory, 'project.txt'), 'utf8')).toBe('Keep project')
    expect(await readFile(join(root, 'alpha', 'sources', 'source.json'), 'utf8')).toBe('Keep source')
    await expect(access(join(directory, 'history'))).rejects.toThrow()
    await expect(access(join(directory, 'archive'))).rejects.toThrow()
    for (const name of ['commit.json', 'state.json']) {
      const persisted = JSON.parse(await readFile(join(directory, name), 'utf8'))
      expect(persisted.config).toBeNull(); expect(persisted.pendingTurns).toEqual([]); expect(persisted.failedTurns).toEqual([])
      expect(JSON.stringify(persisted)).not.toContain('Old goal')
    }
    expect((await loadSuperAgentDocument(join(root, 'alpha'))).config).toBeNull()
    // A late model result from the deleted session cannot restore the old team.
    for (const listener of host.listeners) listener({ workspaceId: 'alpha', sessionId, reason: 'complete', finalText: 'Late old content' })
    await service.tick()
    expect((await service.get('alpha')).state.messages).toEqual([])
    const restarted = new SuperAgentService({ host, rootForWorkspace: id => join(root, id), autoTick: false })
    try { expect((await restarted.get('alpha')).config).toBeNull() } finally { await restarted.cleanup() }
    await service.save('alpha', config)
    expect((await service.get('alpha')).state.board).toEqual([])
  })

  test('waits for session creation and removes the new orphan without dispatching its prompt', async () => {
    const fixture = await superAgentFixture()
    const { service, config } = fixture
    const host = resetHost(fixture.host)
    const createSession = host.createSession.bind(host)
    const deleteSession = host.deleteSession.bind(host)
    let release!: () => void
    let began = false
    const gate = new Promise<void>(resolve => { release = resolve })
    host.createSession = async (...args) => { began = true; await gate; return createSession(...args) }
    host.deleteSession = async () => { throw new Error('Orphan deletion failed') }
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: 'Cancelled during creation' })
    await until(async () => began, value => value)
    const reset = service.command('alpha', { type: 'reset', confirmed: true })
    try {
      await until(() => loadSuperAgentDocument(join(fixture.root, 'alpha')), document => !document.pendingTurns.length)
      await expect(service.command('alpha', { type: 'chat', text: 'Concurrent request' })).rejects.toThrow('reset is in progress')
    } finally { release() }
    await expect(reset).rejects.toThrow('Orphan deletion failed')
    host.deleteSession = deleteSession
    expect((await service.command('alpha', { type: 'reset', confirmed: true })).config).toBeNull()
    expect(host.sessions.size).toBe(0)
    expect(host.sends).toEqual([])
  })

  test('stops managed scripts and ignores delayed process callbacks; failed stops remain retryable', async () => {
    const child = new EventEmitter() as ChildProcess
    let failStop = true
    let stops = 0
    const fixture = await superAgentFixture({
      resolveEnvironment: async (_workspaceId, environment) => ({ workingDirectory: environment.workingDirectory, status: { available: true, isolation: 'container', detail: 'Test sandbox' } }),
      spawnScript: async () => ({ child, stop: async () => { stops++; if (failStop) throw new Error('Stop failed') } }),
    })
    const host = resetHost(fixture.host)
    const config = { ...fixture.config, environment: { ...fixture.config.environment, kind: 'sandbox' as const, sandbox: { runtime: 'docker' as const, image: 'test-image' } },
      scripts: [{ id: 'script', name: 'Script', path: 'script.js', args: [], timeoutSeconds: 60 }] }
    await writeFile(join(fixture.workingDirectory, 'script.js'), 'console.log("script")')
    await fixture.service.save('alpha', config)
    await fixture.service.command('alpha', { type: 'script-run', scriptId: 'script' })
    await expect(fixture.service.command('alpha', { type: 'reset', confirmed: true })).rejects.toThrow('Stop failed')
    expect((await fixture.service.get('alpha')).config).not.toBeNull()
    await fixture.service.tick()
    expect((await loadSuperAgentDocument(join(fixture.root, 'alpha'))).pendingTurns).toEqual([])
    expect(host.sends).toEqual([])
    failStop = false
    expect((await fixture.service.command('alpha', { type: 'reset', confirmed: true })).config).toBeNull()
    child.emit('close', 0, null)
    await fixture.service.tick()
    expect((await fixture.service.get('alpha')).state.scripts).toEqual([])
    expect((await loadSuperAgentDocument(join(fixture.root, 'alpha'))).config).toBeNull()
    expect(stops).toBe(2)
    expect(host.sessions.size).toBe(0)
  })

  test('retains configuration after session deletion fails and allows retry', async () => {
    const fixture = await superAgentFixture()
    const host = resetHost(fixture.host)
    await fixture.service.save('alpha', fixture.config)
    await fixture.service.command('alpha', { type: 'chat', text: 'Goal' })
    await until(() => fixture.service.get('alpha'), snapshot => snapshot.state.nodes.some(node => node.status === 'working'))
    const deleteSession = host.deleteSession.bind(host)
    host.deleteSession = async () => { throw new Error('Delete failed') }
    await expect(fixture.service.command('alpha', { type: 'reset', confirmed: true })).rejects.toThrow('Delete failed')
    expect((await fixture.service.get('alpha')).config).not.toBeNull()
    host.deleteSession = deleteSession
    expect((await fixture.service.command('alpha', { type: 'reset', confirmed: true })).config).toBeNull()
  })

  test('a failed data-only clear can be retried without changing saved settings', async () => {
    const f = await superAgentFixture()
    const host = resetHost(f.host)
    await f.service.save('alpha', { ...f.config, continuousWork: true, environment: { ...f.config.environment, fullControl: true } })
    const config = structuredClone((await f.service.get('alpha')).config)
    await f.service.command('alpha', { type: 'chat', text: 'Old goal' })
    await until(() => f.service.get('alpha'), () => host.sends.length === 1)
    const deleteSession = host.deleteSession.bind(host)
    host.deleteSession = async () => { throw new Error('Delete failed') }
    await expect(f.service.command('alpha', { type: 'reset', confirmed: true, preserveConfig: true })).rejects.toThrow('Delete failed')
    expect((await f.service.get('alpha')).config).toEqual(config)
    host.deleteSession = deleteSession
    expect((await f.service.command('alpha', { type: 'reset', confirmed: true, preserveConfig: true })).config).toEqual(config)
    expect((await loadSuperAgentDocument(join(f.root, 'alpha'))).config).toEqual(config)
  })
})
