import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateFilePath } from './utils'

test('canonicalizes allowed workspace aliases without expanding access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-alias-'))
  try {
    const actual = join(root, 'actual'); const alias = join(root, 'alias')
    await mkdir(actual); await writeFile(join(actual, 'note.md'), 'hello')
    await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await validateFilePath(join(alias, 'note.md'), [alias])).toBe(join(actual, 'note.md'))
    await expect(validateFilePath(join(actual, 'credentials.json'), [alias])).rejects.toThrow('sensitive')
    await expect(validateFilePath(process.platform === 'win32' ? 'Z:\\outside\\file.txt' : '/etc/outside/file.txt', [alias])).rejects.toThrow('outside')
  } finally { await rm(root, { recursive: true, force: true }) }
})
