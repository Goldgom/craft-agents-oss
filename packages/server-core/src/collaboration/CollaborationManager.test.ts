import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CollaborationConflictError, CollaborationManager } from './CollaborationManager'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'craft-collaboration-'))
  roots.push(root)
  const manager = new CollaborationManager(id => id === 'main' ? root : `${root}-${id}`)
  const group = await manager.create(
    { sessionId: 'main-session', workspaceId: 'main' },
    [{ sessionId: 'worker-a', workspaceId: 'main' }, { sessionId: 'worker-b', workspaceId: 'other', serverUrl: 'wss://worker.example' }],
  )
  return { manager, group }
}

describe('CollaborationManager', () => {
  it('enforces directional primary/secondary messaging', async () => {
    const { manager, group } = await fixture()
    const requested = await manager.request(group.id, 'primary', 'secondary_1', 'inspect the API', 'request-1', 0)
    expect(requested.group.revision).toBe(1)
    expect(requested.group.events.at(-1)).toMatchObject({ type: 'request', toMemberId: 'secondary_1' })
    const reported = await manager.report(group.id, 'secondary_1', 'API is ready', 'report-1', 1)
    expect(reported.group.events.at(-1)).toMatchObject({ type: 'report', toMemberId: 'primary' })
    await expect(manager.request(group.id, 'secondary_1', 'secondary_2', 'not allowed', 'bad-1', 2)).rejects.toThrow('Only the primary')
    await expect(manager.report(group.id, 'primary', 'not allowed', 'bad-2', 2)).rejects.toThrow('Only a secondary')
  })

  it('serializes races, rejects stale writes, and makes retries idempotent', async () => {
    const { manager, group } = await fixture()
    const first = manager.updateBoard(group.id, 'primary', 'plan', { state: 'started' }, 'board-1', 0)
    const stale = manager.updateBoard(group.id, 'secondary_1', 'plan', { state: 'overwritten' }, 'board-2', 0)
    await expect(first).resolves.toMatchObject({ applied: true })
    await expect(stale).rejects.toBeInstanceOf(CollaborationConflictError)
    const retry = await manager.updateBoard(group.id, 'primary', 'plan', { state: 'started' }, 'board-1', 0)
    expect(retry.applied).toBe(false)
    expect(retry.group.revision).toBe(1)
  })

  it('persists shared files atomically with digest verification', async () => {
    const { manager, group } = await fixture()
    const result = await manager.putFile(group.id, 'secondary_1', 'notes.txt', Buffer.from('hello').toString('base64'), 'text/plain', 'file-1', 0)
    const file = Object.values(result.group.files)[0]!
    const received = await manager.getFile(group.id, file.id)
    expect(Buffer.from(received.dataBase64, 'base64').toString()).toBe('hello')
    expect(received.file.sha256).toHaveLength(64)
  })
})
