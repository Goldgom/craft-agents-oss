import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSession, getSessionFilePath, loadSession, sessionPersistenceQueue } from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'session-lifecycle-durable-'))
  const stored = await createSession(root, { name: 'Owned lifecycle fixture' })
  const manager: any = new SessionManager()
  const managed = createManagedSession(stored, { id: 'owned-workspace', name: 'Owned', rootPath: root, createdAt: Date.now() } as any, { messagesLoaded: true })
  manager.sessions.set(managed.id, managed)
  const path = getSessionFilePath(root, stored.id)
  cleanups.push(async () => { sessionPersistenceQueue.cancel(stored.id); await sessionPersistenceQueue.cancelAndWait(stored.id); await chmod(dirname(path), 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }) })
  const completion = () => {
    managed.messages.push({ id: 'owned-final-completion', role: 'assistant', content: 'Dummy completion during teardown', timestamp: 1 })
    manager.persistSession(managed)
  }
  return { root, stored, manager: manager as SessionManager, managed, path, completion }
}

test('cleanup flushes a runtime completion after the caller pre-flush and before success', async () => {
  const f = await fixture()
  f.managed.agent = { disposeForRestart: async () => { f.completion() } } as any
  await f.manager.flushAllSessions()
  await f.manager.cleanup()
  expect(loadSession(f.root, f.stored.id)!.messages.map(message => message.id)).toEqual(['owned-final-completion'])
  expect(sessionPersistenceQueue.hasPending(f.stored.id)).toBe(false)
  expect((f.manager as any).sessions.size).toBe(0)
})

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('failed final shutdown flush rejects, retains dirty data, and still releases resources', async () => {
  const f = await fixture(), original = await readFile(f.path, 'utf8')
  f.managed.agent = { disposeForRestart: async () => { f.completion(); await chmod(dirname(f.path), 0o500) } } as any
  await f.manager.flushAllSessions()
  await expect(f.manager.cleanup()).rejects.toThrow()
  expect(await readFile(f.path, 'utf8')).toBe(original)
  expect(sessionPersistenceQueue.hasPending(f.stored.id)).toBe(true)
  expect((f.manager as any).sessions.size).toBe(0)
  expect(f.managed.agent).toBeNull()
  await chmod(dirname(f.path), 0o700)
  await f.manager.flushAllSessions()
  expect(loadSession(f.root, f.stored.id)!.messages.map(message => message.id)).toEqual(['owned-final-completion'])
})

test('physical session deletion waits for an in-flight rename and rejects late persistence callbacks', async () => {
  const f = await fixture(), entered = deferred(), release = deferred()
  const queue: any = sessionPersistenceQueue, originalOperations = queue.fileOperations
  queue.fileOperations = { ...originalOperations, rename: async (from: string, to: string) => { if (to === f.path) { entered.resolve(); await release.promise }; await originalOperations.rename(from, to) } }
  let writing: Promise<void> | undefined, deleting: Promise<void> | undefined
  try {
    f.completion()
    writing = f.manager.flushSession(f.stored.id); void writing.catch(() => {})
    await entered.promise
    f.managed.agent = { disposeForRestart: async () => { f.completion() } } as any
    let deleted = false
    deleting = f.manager.deleteSession(f.stored.id).then(() => { deleted = true })
    await Bun.sleep(10)
    expect(deleted).toBe(false)
    expect(await readFile(f.path, 'utf8')).toBeTruthy()
    release.resolve()
    await expect(writing).rejects.toThrow('cancelled')
    await deleting
    expect(loadSession(f.root, f.stored.id)).toBeNull()
    expect(sessionPersistenceQueue.hasPending(f.stored.id)).toBe(false)
    expect(() => (f.manager as any).persistSession(f.managed, true)).toThrow('retired for deletion')
    f.completion()
    await Bun.sleep(10)
    expect(sessionPersistenceQueue.hasPending(f.stored.id)).toBe(false)
    expect(loadSession(f.root, f.stored.id)).toBeNull()
  } finally {
    release.resolve(); await writing?.catch(() => {}); await deleting?.catch(() => {})
    queue.fileOperations = originalOperations
  }
})
