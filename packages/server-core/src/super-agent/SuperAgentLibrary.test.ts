import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadSuperAgentDocument, searchSuperAgentLibrary, validateSuperAgentCommand, type SuperAgentMemory } from '@craft-agent/shared/super-agent'
import { handleSuperAgentLibrary } from '../../../session-tools-core/src/handlers/super-agent-library'
import type { SessionToolContext } from '../../../session-tools-core/src/context'
import { SuperAgentService } from './SuperAgentService'
import { superAgentFixture, until } from './SuperAgentTestSupport'

const memory = { id: 'project-build', title: '构建约定', content: '项目使用 Bun 构建。', category: 'decision' as const, tags: ['工程'], evidence: '用户要求及 package.json' }
const archive = (sourcePath: string) => ({ title: '工程中间版本', sourcePath, versionLabel: 'v1', description: '已验证的阶段产物', tags: ['工程'] })

describe('Super Agent durable libraries', () => {
  test('memory revisions, deletion and disk reload preserve complete knowledge', async () => {
    const { service, config, root, host } = await superAgentFixture()
    await service.save('alpha', config)
    const created = await service.command('alpha', { type: 'memory-upsert', item: memory, expectedRevision: 0 })
    expect(created.state.memories?.[0]).toMatchObject({ ...memory, revision: 1, updatedBy: 'user' })
    await expect(service.command('alpha', { type: 'memory-upsert', item: { ...memory, content: 'Stale overwrite' }, expectedRevision: 0 })).rejects.toThrow('Memory changed')
    expect((await service.get('alpha')).state.memories?.[0]?.content).toBe(memory.content)
    await service.command('alpha', { type: 'memory-upsert', item: { ...memory, content: '项目使用 Bun 构建并测试。' }, expectedRevision: 1 })
    const restarted = new SuperAgentService({ host, rootForWorkspace: id => join(root, id), autoTick: false })
    try {
      expect((await restarted.get('alpha')).state.memories?.[0]).toMatchObject({ revision: 2, content: '项目使用 Bun 构建并测试。' })
    } finally { await restarted.cleanup() }
    await expect(service.command('alpha', { type: 'memory-delete', id: memory.id, expectedRevision: 1 })).rejects.toThrow('Memory changed')
    await service.command('alpha', { type: 'memory-delete', id: memory.id, expectedRevision: 2 })
    expect((await loadSuperAgentDocument(join(root, 'alpha'))).state.memories).toEqual([])
  })

  test('archive preserves binary/text files and empty directories independently of the source', async () => {
    const { service, config, workingDirectory, root } = await superAgentFixture()
    await service.save('alpha', config)
    await mkdir(join(workingDirectory, 'project', 'empty'), { recursive: true })
    const original = Buffer.from([0, 1, 127, 128, 255])
    await writeFile(join(workingDirectory, 'project', 'binary.dat'), original)
    await writeFile(join(workingDirectory, 'project', 'report.md'), '阶段一报告')
    const snapshot = await service.command('alpha', { type: 'archive-create', item: archive('project') })
    const entry = snapshot.state.archives![0]!
    expect(entry.files).toHaveLength(2)
    expect(entry.directories).toEqual(['empty'])
    expect(entry.files.find(file => file.path === 'binary.dat')!.sha256).toBe(createHash('sha256').update(original).digest('hex'))
    await writeFile(join(workingDirectory, 'project', 'report.md'), '阶段二报告')
    await service.command('alpha', { type: 'archive-restore', id: entry.id, destination: 'restored-v1' })
    expect(await readFile(join(workingDirectory, 'restored-v1', 'report.md'), 'utf8')).toBe('阶段一报告')
    expect(await readFile(join(workingDirectory, 'restored-v1', 'binary.dat'))).toEqual(original)
    expect(await readdir(join(workingDirectory, 'restored-v1', 'empty'))).toEqual([])
    expect(await readFile(join(workingDirectory, 'project', 'report.md'), 'utf8')).toBe('阶段二报告')
    await expect(service.command('alpha', { type: 'archive-restore', id: entry.id, destination: 'restored-v1' })).rejects.toThrow('already exists')
    expect((await loadSuperAgentDocument(join(root, 'alpha'))).state.archives?.[0]).toEqual(entry)
  })

  test('single-file and empty directory snapshots restore correctly', async () => {
    const { service, config, workingDirectory } = await superAgentFixture()
    await service.save('alpha', config)
    await writeFile(join(workingDirectory, 'code.ts'), 'export const version = 1')
    const first = await service.command('alpha', { type: 'archive-create', item: archive('code.ts') })
    expect(first.state.archives![0]!.sourceKind).toBe('file')
    await service.command('alpha', { type: 'archive-restore', id: first.state.archives![0]!.id, destination: 'single' })
    expect(await readFile(join(workingDirectory, 'single', 'code.ts'), 'utf8')).toBe('export const version = 1')
    await mkdir(join(workingDirectory, 'empty'))
    const second = await service.command('alpha', { type: 'archive-create', item: archive('empty') })
    await service.command('alpha', { type: 'archive-restore', id: second.state.archives![1]!.id, destination: 'empty-copy' })
    expect(await readdir(join(workingDirectory, 'empty-copy'))).toEqual([])
  })

  test('corrupted archive refuses restoration and leaves no partial output', async () => {
    const { service, config, workingDirectory, root } = await superAgentFixture()
    await service.save('alpha', config)
    await writeFile(join(workingDirectory, 'code.txt'), 'original')
    const snapshot = await service.command('alpha', { type: 'archive-create', item: archive('code.txt') })
    const id = snapshot.state.archives![0]!.id
    await writeFile(join(root, 'alpha', 'super-agent', 'archive', id, 'code.txt'), 'tampered')
    await expect(service.command('alpha', { type: 'archive-restore', id, destination: 'bad-copy' })).rejects.toThrow('integrity')
    await expect(access(join(workingDirectory, 'bad-copy'))).rejects.toThrow()
    expect((await readdir(workingDirectory)).some(name => name.startsWith('.tokenbird-restore-'))).toBe(false)
  })

  test('source and restore confinement reject traversal and external junctions', async () => {
    const { service, config, workingDirectory, root } = await superAgentFixture()
    await service.save('alpha', config)
    await writeFile(join(root, 'outside.txt'), 'private')
    await expect(service.command('alpha', { type: 'archive-create', item: archive('../outside.txt') })).rejects.toThrow('inside the execution folder')
    const outside = join(root, 'outside')
    await mkdir(outside); await writeFile(join(outside, 'private.txt'), 'private')
    await symlink(outside, join(workingDirectory, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(service.command('alpha', { type: 'archive-create', item: archive('link') })).rejects.toThrow('outside')
    await expect(service.command('alpha', { type: 'archive-create', item: archive('.') })).rejects.toThrow('links')
    await writeFile(join(workingDirectory, 'local.txt'), 'safe')
    const saved = await service.command('alpha', { type: 'archive-create', item: archive('local.txt') })
    const id = saved.state.archives![0]!.id
    await expect(service.command('alpha', { type: 'archive-restore', id, destination: '../escape' })).rejects.toThrow('inside')
    await expect(service.command('alpha', { type: 'archive-restore', id, destination: 'link/escape' })).rejects.toThrow('outside')
    expect(await readFile(join(outside, 'private.txt'), 'utf8')).toBe('private')
  })

  test('history cleanup and node config edits retain both libraries', async () => {
    const { service, config, workingDirectory, root } = await superAgentFixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'memory-upsert', item: memory, expectedRevision: 0 })
    await writeFile(join(workingDirectory, 'version.txt'), 'v1')
    const saved = await service.command('alpha', { type: 'archive-create', item: archive('version.txt') })
    await service.command('alpha', { type: 'history-cleanup', before: 999999, keepRecentMessages: 0, expectedRevision: saved.state.revision })
    await service.save('alpha', { ...config, name: 'Updated team' })
    const disk = await loadSuperAgentDocument(join(root, 'alpha'))
    expect(disk.state.memories?.[0]?.id).toBe(memory.id)
    expect(disk.state.archives?.[0]?.id).toBe(saved.state.archives![0]!.id)
  })

  test('active worker tool retrieves full entries, writes memory and isolates foreign sessions', async () => {
    const { service, config, host } = await superAgentFixture()
    await service.save('alpha', config)
    const content = '完整长期记忆_'.repeat(600)
    await service.command('alpha', { type: 'memory-upsert', item: { ...memory, content }, expectedRevision: 0 })
    await service.command('alpha', { type: 'task', nodeId: 'worker', title: '构建约定', instructions: 'Read project-build and 构建约定' })
    const snapshot = await until(() => service.get('alpha'), () => host.sends.length === 1)
    const sessionId = snapshot.state.tasks[0]!.sessionId!
    expect(host.sends[0]!.context).toContain('memoryCount')
    expect(host.sends[0]!.context).toContain('project-build')
    const ctx = { superAgentLibrary: (args: Record<string, unknown>) => service.accessNodeLibrary('alpha', sessionId, args) } as SessionToolContext
    const response = await handleSuperAgentLibrary(ctx, { type: 'library-get', library: 'memory', id: memory.id })
    expect(response.isError).not.toBe(true)
    expect(response.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(content) })
    await service.accessNodeLibrary('alpha', sessionId, { type: 'memory-upsert', item: { ...memory, content: 'Verified correction' }, expectedRevision: 1 })
    expect((await service.get('alpha')).state.memories?.[0]).toMatchObject({ updatedBy: 'worker', revision: 2 })
    await expect(service.accessNodeLibrary('beta', sessionId, { type: 'library-list', library: 'memory' })).rejects.toThrow()
    await expect(service.accessNodeLibrary('alpha', 'foreign', { type: 'library-list', library: 'memory' })).rejects.toThrow('active node')
    host.complete(sessionId, 'Verified')
    await until(() => service.get('alpha'), snapshot => snapshot.state.tasks[0]?.status === 'completed')
    await expect(service.accessNodeLibrary('alpha', sessionId, { type: 'library-list', library: 'memory' })).rejects.toThrow('active node')
  })

  test('coordinators can retrieve memory but cannot modify libraries', async () => {
    const { service, config, host } = await superAgentFixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'memory-upsert', item: memory, expectedRevision: 0 })
    await service.command('alpha', { type: 'chat', text: 'Recall project-build' })
    await until(() => service.get('alpha'), () => host.sends.length === 1)
    const sessionId = host.sends[0]!.sessionId
    const full = await service.accessNodeLibrary('alpha', sessionId, { type: 'library-get', library: 'memory', id: memory.id })
    expect(full).toMatchObject({ content: memory.content })
    await expect(service.accessNodeLibrary('alpha', sessionId, { type: 'memory-upsert', item: memory, expectedRevision: 1 })).rejects.toThrow('Only workers')
  })

  test('keyword retrieval ranks headings and tags and supports Chinese queries', () => {
    const records = [
      { ...memory, title: '其他', tags: [], content: '构建约定', revision: 1, createdAt: 1, updatedAt: 1, updatedBy: 'user' },
      { ...memory, id: 'preferred', revision: 1, createdAt: 1, updatedAt: 1, updatedBy: 'user' },
    ] satisfies SuperAgentMemory[]
    expect(searchSuperAgentLibrary(records, '构建约定').map(item => item.id)).toEqual(['preferred', memory.id])
    expect(searchSuperAgentLibrary(records, '工程')).toHaveLength(1)
    expect(searchSuperAgentLibrary(records, 'nonexistent')).toEqual([])
  })

  test('library commands reject invalid revisions, unknown fields and unsafe identities', () => {
    expect(() => validateSuperAgentCommand({ type: 'memory-upsert', item: memory })).toThrow()
    expect(() => validateSuperAgentCommand({ type: 'memory-delete', id: '../secret', expectedRevision: 1 })).toThrow()
    expect(() => validateSuperAgentCommand({ type: 'archive-create', item: { ...archive('file'), overwrite: true } })).toThrow()
  })
})
