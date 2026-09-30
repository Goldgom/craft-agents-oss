import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionPersistenceQueue, type SessionPersistenceFileOperations } from '../persistence-queue'
import { createSession, getSessionFilePath, loadSession, sessionPersistenceQueue } from '../storage'
import type { StoredSession } from '../types'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const action of cleanups.splice(0).reverse()) await action() })
const real = { open, rename, unlink }
const posix = process.platform !== 'win32' && process.getuid?.() !== 0 ? test : test.skip
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function fixture(io?: SessionPersistenceFileOperations, debounce = 60_000) {
  const root = await mkdtemp(join(tmpdir(), 'session-durable-'))
  const stored = await createSession(root, { name: 'Original owned session' })
  const path = getSessionFilePath(root, stored.id), original = await readFile(path, 'utf8')
  const queue = new SessionPersistenceQueue(debounce, io ?? real)
  cleanups.push(async () => { queue.cancel(stored.id); sessionPersistenceQueue.cancel(stored.id); await chmod(dirname(path), 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }) })
  const snapshot = (message = 'Dummy persisted message'): StoredSession => ({ ...stored, name: 'Updated owned session', messages: [{ id: 'dummy-message', type: 'user', content: message }], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } })
  return { root, stored, path, original, queue, snapshot }
}

test('ordinary save atomically replaces a session and reloads its complete header/messages', async () => {
  const f = await fixture()
  f.queue.enqueue(f.snapshot()); await f.queue.flush(f.stored.id)
  const loaded = loadSession(f.root, f.stored.id)!
  expect(loaded.name).toBe('Updated owned session'); expect(loaded.messages[0]!.content).toBe('Dummy persisted message')
  expect(f.queue.hasPending(f.stored.id)).toBe(false)
  expect((await readdir(dirname(f.path))).filter(file => file.endsWith('.tmp'))).toEqual([])
})

posix('real permission-denied write preserves the old session, rejects flush, and stays dirty for retry', async () => {
  const f = await fixture(); await chmod(dirname(f.path), 0o500)
  f.queue.enqueue(f.snapshot())
  await expect(f.queue.flush(f.stored.id)).rejects.toThrow()
  expect(await readFile(f.path, 'utf8')).toBe(f.original); expect(f.queue.hasPending(f.stored.id)).toBe(true)
  await chmod(dirname(f.path), 0o700); await f.queue.flush(f.stored.id)
  expect(loadSession(f.root, f.stored.id)!.messages).toHaveLength(1); expect(f.queue.hasPending(f.stored.id)).toBe(false)
})

test('fsync rejection after real bytes are written cannot replace the original or acknowledge success', async () => {
  let fail = true, wroteBytes = false
  const f = await fixture({ ...real, open: async (path, flags, mode) => {
    const handle = await open(path, flags, mode)
    return { writeFile: async (data, encoding) => { await handle.writeFile(data, encoding); wroteBytes = (await readFile(path, 'utf8')).includes('Dummy persisted message') }, sync: async () => { if (fail) throw Object.assign(new Error('Owned fsync failure'), { code: 'EIO' }); await handle.sync() }, close: () => handle.close() }
  } })
  f.queue.enqueue(f.snapshot()); await expect(f.queue.flush(f.stored.id)).rejects.toThrow('Owned fsync failure')
  expect(wroteBytes).toBe(true); expect(await readFile(f.path, 'utf8')).toBe(f.original); expect(f.queue.hasPending(f.stored.id)).toBe(true)
  expect((await readdir(dirname(f.path))).filter(file => file.endsWith('.tmp'))).toEqual([])
  fail = false; await f.queue.flush(f.stored.id); expect(loadSession(f.root, f.stored.id)!.messages).toHaveLength(1)
})

posix('real rename permission failure leaves the existing destination intact', async () => {
  let fail = true
  const f = await fixture({ ...real, rename: async (from, to) => { if (fail) await chmod(dirname(to), 0o500); await rename(from, to) } })
  f.queue.enqueue(f.snapshot()); await expect(f.queue.flush(f.stored.id)).rejects.toThrow()
  expect(await readFile(f.path, 'utf8')).toBe(f.original); expect(f.queue.hasPending(f.stored.id)).toBe(true)
  await chmod(dirname(f.path), 0o700); fail = false; await f.queue.flush(f.stored.id)
  expect(loadSession(f.root, f.stored.id)!.messages).toHaveLength(1)
})

test('strict flush waits for a timer-started writer and serializes a newer snapshot', async () => {
  const started = deferred(), release = deferred(); let first = true, active = 0, maxActive = 0
  const f = await fixture({ ...real, open: async (path, flags, mode) => {
    const handle = await open(path, flags, mode); active++; maxActive = Math.max(maxActive, active)
    return { writeFile: (data, encoding) => handle.writeFile(data, encoding), sync: async () => { if (first) { first = false; started.resolve(); await release.promise }; await handle.sync() }, close: async () => { try { await handle.close() } finally { active-- } } }
  } }, 1)
  f.queue.enqueue(f.snapshot('first')); await started.promise
  let completed = false; const flush = f.queue.flush(f.stored.id).then(() => { completed = true })
  await Bun.sleep(10); expect(completed).toBe(false); expect(await readFile(f.path, 'utf8')).toBe(f.original)
  f.queue.enqueue(f.snapshot('newer')); const newer = f.queue.flush(f.stored.id)
  release.resolve(); await Promise.all([flush, newer]); await f.queue.flushAll()
  expect(maxActive).toBe(1); expect(loadSession(f.root, f.stored.id)!.messages[0]!.content).toBe('newer')
})

test('cancellation before rename prevents a deleted session from being resurrected', async () => {
  const started = deferred(), release = deferred()
  const f = await fixture({ ...real, open: async (path, flags, mode) => { const handle = await open(path, flags, mode); return { writeFile: (data, encoding) => handle.writeFile(data, encoding), sync: async () => { started.resolve(); await release.promise; await handle.sync() }, close: () => handle.close() } } })
  f.queue.enqueue(f.snapshot()); const pending = f.queue.flush(f.stored.id); void pending.catch(() => {})
  await started.promise; f.queue.cancel(f.stored.id); await unlink(f.path); release.resolve()
  await expect(pending).rejects.toThrow('cancelled'); await expect(readFile(f.path, 'utf8')).rejects.toThrow()
  expect(f.queue.hasPending(f.stored.id)).toBe(false)
})

test('cancelAndWait is a barrier before deletion even when rename already started', async () => {
  const started = deferred(), release = deferred()
  const f = await fixture({ ...real, rename: async (from, to) => { started.resolve(); await release.promise; await rename(from, to) } })
  f.queue.enqueue(f.snapshot()); const writing = f.queue.flush(f.stored.id); void writing.catch(() => {})
  await started.promise
  let barrierCompleted = false
  const barrier = f.queue.cancelAndWait(f.stored.id).then(() => { barrierCompleted = true })
  await Bun.sleep(10); expect(barrierCompleted).toBe(false)
  release.resolve(); await barrier
  await expect(writing).rejects.toThrow('cancelled')
  await unlink(f.path)
  await Bun.sleep(10)
  await expect(readFile(f.path, 'utf8')).rejects.toThrow()
  expect(f.queue.hasPending(f.stored.id)).toBe(false)
})

posix('debounced failures are caught/reported once and remain dirty without a retry loop', async () => {
  const { spyOn } = await import('bun:test')
  const reported = spyOn(console, 'error').mockImplementation(() => {})
  const f = await fixture(undefined, 1)
  try {
    await chmod(dirname(f.path), 0o500); f.queue.enqueue(f.snapshot())
    const deadline = Date.now() + 2000
    while (!reported.mock.calls.length && Date.now() < deadline) await Bun.sleep(5)
    expect(reported.mock.calls).toHaveLength(1); expect(f.queue.hasPending(f.stored.id)).toBe(true)
    await Bun.sleep(20); expect(reported.mock.calls).toHaveLength(1)
    expect(await readFile(f.path, 'utf8')).toBe(f.original)
    await chmod(dirname(f.path), 0o700); await f.queue.flush(f.stored.id)
    expect(loadSession(f.root, f.stored.id)!.messages).toHaveLength(1)
  } finally { reported.mockRestore(); await chmod(dirname(f.path), 0o700) }
})

posix('flushAll waits for independent healthy sessions even when another write fails', async () => {
  const bad = await fixture(), good = await fixture()
  await chmod(dirname(bad.path), 0o500)
  bad.queue.enqueue(bad.snapshot('blocked')); bad.queue.enqueue(good.snapshot('healthy sibling'))
  await expect(bad.queue.flushAll()).rejects.toThrow()
  expect(await readFile(bad.path, 'utf8')).toBe(bad.original)
  expect(loadSession(good.root, good.stored.id)!.messages[0]!.content).toBe('healthy sibling')
  expect(bad.queue.hasPending(bad.stored.id)).toBe(true)
  expect(bad.queue.hasPending(good.stored.id)).toBe(false)
})
