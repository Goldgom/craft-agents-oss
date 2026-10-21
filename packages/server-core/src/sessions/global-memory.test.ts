import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GlobalMemory, globalMemoryMode } from './global-memory'

let root: string
let previous: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tokenbird-global-memory-'))
  previous = process.env.TOKENBIRD_MEMORY_MODE
  process.env.TOKENBIRD_MEMORY_MODE = 'tokenbird'
})
afterEach(() => {
  if (previous === undefined) delete process.env.TOKENBIRD_MEMORY_MODE
  else process.env.TOKENBIRD_MEMORY_MODE = previous
  rmSync(root, { recursive: true, force: true })
})
const input = () => ({ workspaceId: 'work', sessionId: 'session', checkpoint: 'event1',
  messages: [{ role: 'user', content: '所有界面使用中文' }] })
const result = JSON.stringify([{ content: '界面使用中文', evidence: '所有界面使用中文' }])

test('compaction persists durable facts with provenance and retrieves them in another instance', async () => {
  await new GlobalMemory(root).capture(input(), async () => result)
  const record = JSON.parse(readFileSync(join(root, readdirSync(root)[0]!), 'utf8'))
  expect(record).toMatchObject({ workspaceId: 'work', sessionId: 'session', facts: [{ content: '界面使用中文' }] })
  expect(new GlobalMemory(root).context('这个界面怎么设计')).toContain('界面使用中文')
  expect(new GlobalMemory(root).context('unrelated')).toBe('')
})

test.each(['native', 'off'])('%s skips extraction and retrieval without deleting persisted memory', async mode => {
  const memory = new GlobalMemory(root)
  await memory.capture(input(), async () => result)
  process.env.TOKENBIRD_MEMORY_MODE = mode
  let called = false
  await memory.capture({ ...input(), checkpoint: 'event2' }, async () => { called = true; return result })
  expect(called).toBe(false)
  expect(memory.context('中文')).toBe('')
  expect(readdirSync(root)).toHaveLength(1)
})

test('concurrent sessions do not overwrite each other; duplicate events are checkpointed', async () => {
  const memory = new GlobalMemory(root)
  await Promise.all(['a', 'b'].map(sessionId => memory.capture({ ...input(), sessionId }, async () => result)))
  expect(readdirSync(root)).toHaveLength(2)
  await memory.capture({ ...input(), sessionId: 'a' }, async () => { throw new Error('duplicate') })
  expect(memory.context('中文').match(/界面使用中文/g)).toHaveLength(2) // content + evidence, one deduplicated fact
})

test('only extracts the new interval and ignores tool content', async () => {
  const memory = new GlobalMemory(root)
  await memory.capture({ ...input(), messages: [
    { role: 'user', content: 'old transcript' }, { role: 'info', statusType: 'compaction_complete' },
    { role: 'tool', content: 'secret tool output' }, ...input().messages,
  ] }, async prompt => {
    expect(prompt).not.toContain('old transcript')
    expect(prompt).not.toContain('secret tool output')
    return result
  })
  expect(readdirSync(root)).toHaveLength(1)
})

test('disabled during extraction prevents late writes', async () => {
  await new GlobalMemory(root).capture(input(), async () => { process.env.TOKENBIRD_MEMORY_MODE = 'off'; return result })
  expect(readdirSync(root)).toHaveLength(0)
})

test('rejects ungrounded evidence and malformed output; corrupt records do not block retrieval', async () => {
  const memory = new GlobalMemory(root)
  await memory.capture(input(), async () => JSON.stringify([{ content: 'invented', evidence: 'never said' }]))
  expect(memory.context('invented')).toBe('')
  await expect(memory.capture({ ...input(), checkpoint: 'bad' }, async () => 'invalid')).rejects.toThrow()
  await memory.capture({ ...input(), checkpoint: 'good' }, async () => result)
  writeFileSync(join(root, `${'a'.repeat(64)}.json`), 'broken')
  expect(memory.context('中文')).toContain('界面使用中文')
})

test('rejects invalid backend mode instead of silently enabling writes', () => {
  process.env.TOKENBIRD_MEMORY_MODE = 'typo'
  expect(globalMemoryMode).toThrow('Invalid TokenBird memory mode')
})
