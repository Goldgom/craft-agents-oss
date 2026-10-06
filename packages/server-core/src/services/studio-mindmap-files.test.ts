import { test, expect } from 'bun:test'
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeMindMapSession, readMindMapSession, mindMapWorkspaceContext } from './studio-mindmap-files'

test('rejects traversal IDs and project-controlled symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mindmap-boundary-'))
  try {
    const project = join(root, 'project'); const outside = join(root, 'outside')
    await mkdir(project); await mkdir(outside)
    await expect(writeMindMapSession(project, '../../outside', 'data')).rejects.toThrow('ID')
    await symlink(outside, join(project, '.tokenbird'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(writeMindMapSession(project, crypto.randomUUID(), 'data')).rejects.toThrow('符号链接')
    await expect(readMindMapSession(project, crypto.randomUUID())).rejects.toThrow('符号链接')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('workspace summaries omit credential and secret files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mindmap-context-'))
  try {
    await writeFile(join(root, 'README.md'), 'project description')
    await writeFile(join(root, 'credentials.json'), 'private token')
    await writeFile(join(root, 'secrets.yaml'), 'private password')
    const context = await mindMapWorkspaceContext(root)
    expect(context).toContain('project description')
    expect(context).not.toContain('private')
  } finally { await rm(root, { recursive: true, force: true }) }
})
