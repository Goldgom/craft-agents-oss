import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CollaborationConflictError, CollaborationManager } from './CollaborationManager'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'craft-collaboration-'))
  const otherRoot = `${root}-other`
  roots.push(root, otherRoot)
  const manager = new CollaborationManager(id => id === 'main' ? root : otherRoot)
  const group = await manager.create(
    { sessionId: 'main-session', workspaceId: 'main' },
    [{ sessionId: 'worker-a', workspaceId: 'main' }, { sessionId: 'worker-b', workspaceId: 'other' }],
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

  it('indexes a coordinator-owned group in every local member workspace', async () => {
    const { manager, group } = await fixture()
    const fromPrimary = await manager.list('main')
    const fromSecondary = await manager.list('other')
    expect(fromPrimary.map(item => item.id)).toEqual([group.id])
    expect(fromSecondary.map(item => item.id)).toEqual([group.id])
  })

  it('tracks failed delivery attempts and permits a durable retry', async () => {
    const { manager, group } = await fixture()
    await manager.request(group.id, 'primary', 'secondary_1', 'inspect the API', 'delivery-1', 0)
    const firstClaim = await manager.claimDelivery(group.id, 'delivery-1')
    expect(firstClaim).toMatchObject({ claimed: true, status: 'delivering' })
    const failed = await manager.completeDelivery(group.id, 'delivery-1', firstClaim.attempt!, 'failed', 'temporary failure')
    expect(failed.events.at(-1)?.delivery).toMatchObject({ status: 'failed', attempts: 1 })

    const retryClaim = await manager.claimDelivery(group.id, 'delivery-1')
    expect(retryClaim).toMatchObject({ claimed: true, status: 'delivering' })
    const stale = await manager.completeDelivery(group.id, 'delivery-1', firstClaim.attempt!, 'delivered')
    expect(stale.events.at(-1)?.delivery).toMatchObject({ status: 'delivering', attempts: 2 })
    const delivered = await manager.completeDelivery(group.id, 'delivery-1', retryClaim.attempt!, 'delivered')
    expect(delivered.events.at(-1)?.delivery).toMatchObject({ status: 'delivered', attempts: 2 })
    await expect(manager.claimDelivery(group.id, 'delivery-1')).resolves.toMatchObject({ claimed: false, status: 'delivered' })
  })

  it('ends a collaboration and rejects later board mutations', async () => {
    const { manager, group } = await fixture()
    const ended = await manager.end(group.id, 'primary', 'end-1', 0)
    expect(ended.group).toMatchObject({ status: 'ended', endedBy: 'primary' })
    await expect(
      manager.updateBoard(group.id, 'primary', 'late', true, 'late-1', ended.group.revision),
    ).rejects.toThrow('Collaboration has ended')
    await expect(manager.claimDelivery(group.id, 'missing-delivery')).rejects.toThrow('Collaboration has ended')
  })

  it('keeps operation idempotency after the bounded event history is trimmed', async () => {
    const { manager, group } = await fixture()
    let revision = group.revision
    for (let index = 0; index <= 500; index += 1) {
      const result = await manager.updateBoard(group.id, 'primary', 'counter', index, `operation-${index}`, revision)
      revision = result.group.revision
    }
    const retry = await manager.updateBoard(group.id, 'primary', 'counter', 0, 'operation-0', 0)
    expect(retry.applied).toBe(false)
    expect(retry.group.board.counter?.value).toBe(500)
    expect(retry.group.events).toHaveLength(500)
  })

  it('rejects unsafe identifiers and malformed durable payloads', async () => {
    const { manager, group } = await fixture()
    await expect(manager.open('../outside', 'main')).rejects.toThrow('Invalid collaboration group id')
    await expect(manager.updateBoard(group.id, 'primary', '__proto__', true, 'board-unsafe', 0))
      .rejects.toThrow('Reserved board item id')
    await expect(manager.putFile(group.id, 'primary', 'test.txt', 'not base64!', 'text/plain', 'file-invalid', 0))
      .rejects.toThrow('valid base64')
  })
})
