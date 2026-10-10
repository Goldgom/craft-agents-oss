import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

test('real session storage preserves history, copies attachments, replays edits, and restores branch limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokenbird-branch-test-'))
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'message-branching.fixture.ts')], {
      env: { ...process.env, TOKENBIRD_CONFIG_DIR: root }, stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ status, stderr }).toEqual({ status: 0, stderr: '' })
    expect(stdout).toContain('BRANCH_SMOKE_OK')
  } finally {
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}tokenbird-branch-test-`)) throw new Error('Invalid test cleanup path')
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
