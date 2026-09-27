import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deleteMindMapSession, mindMapWorkspaceContext, readMindMapSession, writeMindMapSession } from './studio-mindmap-files'

const directory = await mkdtemp(join(tmpdir(), 'tokenbird-mindmap-'))
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

test('stores mind map content inside the selected directory', async () => {
  const id = crypto.randomUUID()
  await writeMindMapSession(directory, id, '{"xml":"test"}')
  expect(await readFile(join(directory, '.tokenbird', 'mindmaps', `${id}.json`), 'utf8')).toBe('{"xml":"test"}')
  expect(await readMindMapSession(directory, id)).toBe('{"xml":"test"}')
  await deleteMindMapSession(directory, id)
  expect(await readMindMapSession(directory, id)).toBe('')
})

test('summarizes project text without saved diagrams or dependencies', async () => {
  await writeFile(join(directory, 'README.md'), 'visible project description')
  await mkdir(join(directory, 'node_modules'))
  await writeFile(join(directory, 'node_modules', 'secret.ts'), 'hidden dependency')
  await mkdir(join(directory, '.tokenbird', 'mindmaps'), { recursive: true })
  await writeFile(join(directory, '.tokenbird', 'mindmaps', 'private.json'), 'hidden diagram')
  const context = await mindMapWorkspaceContext(directory)
  expect(context).toContain('visible project description')
  expect(context).not.toContain('hidden dependency')
  expect(context).not.toContain('hidden diagram')
})
