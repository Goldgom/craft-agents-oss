import { legacyDynamicConfig as rebuildSuperAgentConfig } from './SuperAgentTestSupport'
import { expect, test } from 'bun:test'
import { readContextPage } from './SuperAgentContext'
import { effectiveSuperAgentReports, readSuperAgentArea } from './SuperAgentDynamic'
import { emptySuperAgentState, type SuperAgentReport } from '@tokenbird/shared/super-agent'
import { superAgentFixture, until } from './SuperAgentTestSupport'

test('bounded summaries provide lossless Unicode JSON details and reject changed page versions', () => {
  const record = { id: 'contract', path: 'C:/精确路径/report.json', content: '需要保留🙂'.repeat(10000), steps: Array(100).fill('exact') }
  const preview = readContextPage([record], { maxChars: 2000 })
  expect(JSON.stringify(preview).length).toBeLessThan(2400)
  expect(preview.items[0]).toMatchObject({ complete: false, detailRef: { id: 'contract', view: 'detail' } })
  let offset = 0, hash: string | undefined, content = ''
  do {
    const page = readContextPage([record], { id: 'contract', view: 'detail', contentOffset: offset, maxChars: 2000, expectedHash: hash })
    expect(page.detail).toBeDefined()
    hash ??= page.detail!.hash
    content += page.detail!.content
    offset = page.detail!.nextContentOffset ?? -1
  } while (offset >= 0)
  expect(JSON.parse(content)).toEqual(record)
  expect(() => readContextPage([{ ...record, content: 'changed' }], { id: 'contract', view: 'detail', expectedHash: hash })).toThrow('changed while paging')
})

test('a page character budget never skips records and wide records have a retrievable id', () => {
  const records = Array.from({ length: 30 }, (_, index) => ({ id: String(index), content: 'x'.repeat(1000) }))
  let offset = 0
  const ids: string[] = []
  do {
    const page = readContextPage(records, { offset, limit: 30, maxChars: 2000 })
    expect(JSON.stringify(page).length).toBeLessThan(2400)
    ids.push(...page.items.map(item => item.id))
    offset = page.nextOffset ?? -1
  } while (offset >= 0)
  expect(ids).toEqual(records.map(item => item.id))
  const wide = readContextPage([{ id: 'wide', fields: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [i, 'x'.repeat(200)])) }], { maxChars: 1000 })
  expect(JSON.stringify(wide).length).toBeLessThan(1400)
  expect(wide.items[0]).toMatchObject({ detailRef: { id: 'wide' } })
})

test('report replacements are scoped by author, task, goal version and kind; original evidence stays readable', () => {
  const report = (id: string, sequence: number, extra: Partial<SuperAgentReport> = {}): SuperAgentReport => ({ id, sequence, nodeId: 'worker',
    turnId: 'turn', taskId: 'task', goalRevision: 1, kind: 'progress', content: id, verification: 'unverified', artifactIds: [], createdAt: 1, ...extra })
  const reports = [report('old', 1), report('new', 2, { supersedes: 'old' }), report('question', 3, { kind: 'question' }),
    report('not-resolution', 4, { supersedes: 'question' }), report('other-version', 5, { supersedes: 'new', goalRevision: 2 })]
  expect(effectiveSuperAgentReports(reports).map(item => item.id)).toEqual(['new', 'question', 'not-resolution', 'other-version'])
  const document = { version: 1 as const, config: null, state: { ...emptySuperAgentState(), reports }, pendingTurns: [], chainCounts: {} }
  const node = { id: 'main', role: 'coordinator' } as Parameters<typeof readSuperAgentArea>[1]
  const result = readSuperAgentArea(document, node, 'reports', { id: 'old', view: 'detail' })
  expect('items' in result && result.items).toEqual([reports[0]])
  const batch = readSuperAgentArea(document, node, 'reports', { throughSequence: 1 })
  expect('items' in batch && Array.isArray(batch.items) && batch.items.map((item: { id: string }) => item.id)).toEqual(['old'])
})

test('the actual dynamic worker send stays small with a large catalog, and checkpoint details stay available', async () => {
  const f = await superAgentFixture({ describeResources: () => ({ skills: Array.from({ length: 30 }, (_, i) => ({ slug: `skill-${i}`, name: `Skill ${i}`, description: 'unrelated catalog content'.repeat(100) })), sources: [] }) })
  const config = rebuildSuperAgentConfig(f.config)
  config.continuousWork = true
  await f.service.save('alpha', config)
  await f.service.command('alpha', { type: 'board-upsert', item: { id: 'unrelated', title: 'Other work', content: 'DO_NOT_AUTO_INJECT' }, expectedRevision: 0 })
  await f.service.command('alpha', { type: 'task', id: 'bounded-task', title: 'Inspect', instructions: 'Inspect the assigned file', modelEntryId: config.modelPool![0]!.id, thinkingLevel: 'low' })
  const active = await until(() => f.service.get('alpha'), state => state.state.tasks[0]?.status === 'running' && f.host.sends.some(send => send.sessionId === state.state.tasks[0]?.sessionId))
  const sessionId = active.state.tasks[0]!.sessionId!
  const send = f.host.sends.find(send => send.sessionId === sessionId)!
  expect(send.context.length).toBeLessThan(3000)
  expect(send.context).not.toContain('unrelated catalog content')
  expect(send.context).not.toContain('DO_NOT_AUTO_INJECT')
  const steps = Array.from({ length: 100 }, (_, i) => `Step ${i}: ${'x'.repeat(480)}`)
  await f.service.updateNodeTask('alpha', sessionId, { action: 'checkpoint', taskId: 'bounded-task', expectedRevision: 0,
    completedSteps: steps, nextStep: 'Verify C:/project/精确路径.json', note: 'Keep exact input revision' })
  await f.service.updateNodeTask('alpha', sessionId, { action: 'wait', taskId: 'bounded-task', reason: 'Wait for assigned next stage', condition: { kind: 'time', notBefore: f.now() + 3000 } })
  f.host.complete(sessionId, 'Stage saved; waiting for the next stage')
  await until(() => f.service.get('alpha'), state => state.state.tasks[0]?.phase === 'waiting')
  f.advance(4000); await f.service.tick()
  await until(() => f.service.get('alpha'), () => f.host.sends.filter(send => send.sessionId === sessionId).length === 2)
  const resumed = f.host.sends.filter(send => send.sessionId === sessionId).at(-1)!
  expect(resumed.context.length).toBeLessThan(4000)
  expect(resumed.context).toContain('精确路径.json')
  console.info('[context-size]', JSON.stringify({ catalogSkills: 30, checkpointSteps: 100,
    workerContextCharacters: send.context.length, resumedContextCharacters: resumed.context.length }))
  const detail = await f.service.updateNodeTask('alpha', sessionId, { action: 'get', taskId: 'bounded-task' })
  expect(JSON.stringify(detail)).toContain(steps[0]!)
  expect(JSON.stringify(detail)).toContain(steps[99]!)
})
