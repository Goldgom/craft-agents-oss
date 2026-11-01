import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  emptySuperAgentState, loadSuperAgentDocument, saveSuperAgentDocument, planSuperAgentBoardCleanup,
  SUPER_AGENT_BOARD_LIMIT, SUPER_AGENT_BOARD_RETENTION_MS, SUPER_AGENT_BOARD_BYTES, superAgentBoardBytes,
  SUPER_AGENT_BOARD_RETRY_MS, SUPER_AGENT_BOARD_RETRY_MAX_MS, SUPER_AGENT_BOARD_SCAN_MS,
  type SuperAgentDocument, type SuperAgentState,
} from '@tokenbird/shared/super-agent'
import { maintainSuperAgentBoard, writeSuperAgentBoardArchive } from './SuperAgentBoard'
import { SuperAgentService } from './SuperAgentService'
import { superAgentFixture, until } from './SuperAgentTestSupport'

const now = 10 * SUPER_AGENT_BOARD_RETENTION_MS
function state(count = 48): SuperAgentState {
  return { ...emptySuperAgentState(0), board: Array.from({ length: count }, (_, index) => ({
    id: `entry-${index}`, title: `Topic ${index}`, content: `Verified record ${index}`, revision: 1, updatedBy: 'old-worker', updatedAt: index + 1,
  })) }
}
function document(s = state()): SuperAgentDocument {
  return { version: 1, config: null, state: s, pendingTurns: [], chainCounts: {} }
}
async function seed(f: Awaited<ReturnType<typeof superAgentFixture>>, d: SuperAgentDocument) {
  await saveSuperAgentDocument(join(f.root, 'alpha'), { ...d, config: f.config,
    state: { ...d.state, nodes: f.config.nodes.map(node => ({ nodeId: node.id, status: 'idle' as const })) } })
}

test('cleanup preserves pins, live assignments, board waits, unread reports and transitive board references', () => {
  const s = state()
  s.board[0]!.pinned = true
  s.board[1]!.taskId = 'live'
  s.board[2]!.pinned = true; s.board[2]!.content = 'Keep entry-3'
  s.board[3]!.content = 'Keep entry-4'
  s.tasks.push({ id: 'live', title: 'Assignment', instructions: 'Continue entry-5', nodeId: 'worker', status: 'queued', createdAt: 1,
    phase: 'waiting', waiting: { reason: 'input', since: 1, resumeAttempts: 0, condition: { kind: 'board', itemId: 'entry-6', afterRevision: 1 } } })
  s.reports = [{ id: 'report', sequence: 1, nodeId: 'worker', recipientNodeId: 'planner', turnId: 'turn', kind: 'stage',
    content: 'Use entry-7', verification: 'unverified', artifactIds: [], createdAt: 1 }]
  s.consumedReportSequence = 99; s.reportCursors = { planner: 0 }
  const plan = planSuperAgentBoardCleanup(s, now, [{ nodeId: 'another-worker', text: 'Refer to entry-8' }])
  expect(plan.retained.map(item => item.id)).toEqual(expect.arrayContaining(Array.from({ length: 9 }, (_, i) => `entry-${i}`)))
  expect(plan.removed.map(item => item.id)).toContain('entry-9')
  expect(plan.removed).toHaveLength(7)
  expect(s.board).toHaveLength(48)
})

test('cleanup retains unresolved operation evidence and dependencies even for completed producers', () => {
  const s = state()
  s.tasks = [
    { id: 'running', title: 'Current', instructions: 'Continue', nodeId: 'worker', status: 'running', createdAt: 1, dependsOn: ['producer'] },
    { id: 'producer', title: 'Input', instructions: 'Contract entry-0', nodeId: 'previous', status: 'completed', createdAt: 1 },
  ]
  s.operations = [{ id: 'unknown-op', key: 'fingerprint', nodeId: 'worker', taskId: 'running', sessionId: 'session',
    invocationId: 'call', toolName: 'Edit', status: 'unknown', createdAt: 1, updatedAt: 1, turnId: 'turn' }]
  s.board[1]!.content = 'Evidence for unknown-op'
  const plan = planSuperAgentBoardCleanup(s, now)
  expect(plan.retained.map(item => item.id)).toEqual(expect.arrayContaining(['entry-0', 'entry-1']))
})

test('cleanup archives exact duplicates and expired entries but keeps recent unexpired records and unusual IDs', () => {
  const s = state(6)
  s.board[1] = { ...s.board[0]!, id: 'duplicate', updatedAt: 2 }
  s.board[2]!.expiresAt = now - 1
  s.board[3]!.id = 'contract.v1'; s.board[3]!.expiresAt = now - 1
  s.board[4]!.pinned = true; s.board[4]!.content = 'See contract.v1'
  const plan = planSuperAgentBoardCleanup(s, now)
  expect(plan.removed.map(item => item.id)).toEqual(['entry-0', 'entry-2'])
  expect(plan.reasons).toEqual({ 'entry-0': 'duplicate', 'entry-2': 'expired' })
  expect(plan.retained.map(item => item.id)).toContain('contract.v1')
})

test('archive retries are bounded, pressure cannot bypass backoff, and recovery is automatic when due', async () => {
  const d = document()
  const before = structuredClone(d.state.board)
  let calls = 0
  const writeArchive = async () => { calls++; throw Object.assign(new Error('Disk unavailable'), { code: 'EIO' }) }
  const input = { workspaceId: 'alpha', root: '', document: d, now, writeArchive }
  await maintainSuperAgentBoard(input)
  expect(calls).toBe(3)
  expect(d.state.board).toEqual(before)
  expect(d.state.boardMaintenance).toMatchObject({ status: 'retrying', issue: {
    code: 'archive_failed', attempts: 3, recoveryAttempt: 1, retryAt: now + SUPER_AGENT_BOARD_RETRY_MS,
  } })
  await maintainSuperAgentBoard({ ...input, now: now + SUPER_AGENT_BOARD_RETRY_MS - 1, pressure: true })
  expect(calls).toBe(3)
  await maintainSuperAgentBoard({ ...input, now: now + SUPER_AGENT_BOARD_RETRY_MS, writeArchive: async () => 'verified-archive' })
  expect(d.state.board).toHaveLength(32)
  expect(d.state.boardMaintenance).toMatchObject({ status: 'ready', archived: 16, archivePath: 'verified-archive' })
  expect(d.state.boardMaintenance!.issue).toBeUndefined()
})

test('persistent archive failures keep retrying at a capped interval and legacy blocked state self-recovers', async () => {
  const d = document()
  let time = now
  let calls = 0
  const input = { workspaceId: 'alpha', root: '', document: d,
    writeArchive: async () => { calls++; throw Object.assign(new Error('History path unavailable'), { code: 'ENOTDIR' }) } }
  for (let attempt = 1; attempt <= 9; attempt++) {
    await maintainSuperAgentBoard({ ...input, now: time })
    const issue = d.state.boardMaintenance!.issue!
    expect(issue.recoveryAttempt).toBe(attempt)
    const delay = Math.min(SUPER_AGENT_BOARD_RETRY_MS * 2 ** (attempt - 1), SUPER_AGENT_BOARD_RETRY_MAX_MS)
    expect(issue.retryAt).toBe(time + delay)
    expect(d.state.board).toHaveLength(48)
    expect(calls).toBe(attempt)
    time = issue.retryAt!
  }
  // Upgrade an old manual-only error without a next retry time.
  d.state.boardMaintenance = { status: 'blocked', checkedAt: time - SUPER_AGENT_BOARD_RETRY_MS,
    archived: 0, lastArchived: 0, issue: { code: 'archive_failed', attempts: 3, message: 'Old blocked state' } }
  await maintainSuperAgentBoard({ ...input, now: time, writeArchive: async () => 'recovered-archive' })
  expect(d.state.board).toHaveLength(32)
  expect(d.state.boardMaintenance!.issue).toBeUndefined()
})

test('idle heartbeat cleans periodically with continuous work disabled and no user command or model invocation', async () => {
  const f = await superAgentFixture()
  await seed(f, document())
  await f.service.get('alpha') // Startup registration loads each configured workspace.
  f.advance(now)
  await f.service.tick()
  const first = await f.service.get('alpha')
  expect(first.state.board).toHaveLength(32)
  expect(first.state.boardMaintenance!.lastArchived).toBe(16)
  expect(f.host.sends).toHaveLength(0)
  // A subsequent ordinary scan still runs without visiting the board UI.
  f.advance(SUPER_AGENT_BOARD_SCAN_MS)
  await f.service.tick()
  const next = await loadSuperAgentDocument(join(f.root, 'alpha'))
  expect(next.state.boardMaintenance!.checkedAt).toBe(f.now())
  expect(f.host.sends).toHaveLength(0)
})

test('heartbeat resumes a persisted archive retry after restart without a manual cleanup or model call', async () => {
  let failing = true
  let calls = 0
  const archiveBoard = async (input: Parameters<typeof writeSuperAgentBoardArchive>[0]) => {
    calls++
    if (failing) throw Object.assign(new Error('Disk offline'), { code: 'ENOTDIR' })
    return writeSuperAgentBoardArchive(input)
  }
  const f = await superAgentFixture({ archiveBoard })
  await seed(f, document())
  await f.service.get('alpha')
  f.advance(now)
  await f.service.tick()
  const failed = await loadSuperAgentDocument(join(f.root, 'alpha'))
  expect(failed.state.boardMaintenance!.issue!.retryAt).toBe(f.now() + SUPER_AGENT_BOARD_RETRY_MS)
  expect(calls).toBe(1)
  await f.service.cleanup()
  const restarted = new SuperAgentService({ host: f.host, rootForWorkspace: id => join(f.root, id), now: f.now, autoTick: false, archiveBoard })
  try {
    await restarted.get('alpha')
    await restarted.tick()
    expect(calls).toBe(1)
    failing = false
    f.advance(SUPER_AGENT_BOARD_RETRY_MS)
    await restarted.tick()
    const recovered = await loadSuperAgentDocument(join(f.root, 'alpha'))
    expect(recovered.state.board).toHaveLength(32)
    expect(recovered.state.boardMaintenance).toMatchObject({ status: 'ready', archived: 16 })
    expect(recovered.state.boardMaintenance!.issue).toBeUndefined()
    expect(calls).toBe(2)
    expect(f.host.sends).toHaveLength(0)
  } finally { await restarted.cleanup() }
})

test('capacity is rechecked automatically after the protecting task completes', async () => {
  const f = await superAgentFixture()
  const d = document(state(SUPER_AGENT_BOARD_LIMIT))
  d.state.board.forEach(item => { item.taskId = 'producer' })
  await seed(f, d)
  f.advance(now)
  await f.service.command('alpha', { type: 'task', id: 'producer', nodeId: 'worker', title: 'Produce output', instructions: 'Complete the current work' })
  await until(() => f.service.get('alpha'), () => f.host.sends.length === 1)
  await f.service.tick()
  const full = await f.service.get('alpha')
  expect(full.state.board).toHaveLength(SUPER_AGENT_BOARD_LIMIT)
  expect(full.state.boardMaintenance!.issue).toMatchObject({ code: 'capacity', retryAt: f.now() + SUPER_AGENT_BOARD_RETRY_MS })
  f.host.complete(f.host.sends[0]!.sessionId, 'Produced the current output')
  await until(() => f.service.get('alpha'), value => value.state.tasks[0]?.status === 'completed')
  f.advance(SUPER_AGENT_BOARD_RETRY_MS)
  await f.service.tick()
  const recovered = await loadSuperAgentDocument(join(f.root, 'alpha'))
  expect(recovered.state.board).toHaveLength(32)
  expect(recovered.state.boardMaintenance!.issue).toBeUndefined()
})

test('archive contains lossless original entries and reasons before live removal and survives reload', async () => {
  const f = await superAgentFixture()
  const d = document()
  d.state.board[0]!.content = '原始证据🙂\n'.repeat(300)
  const originals = structuredClone(d.state.board)
  await seed(f, d)
  f.advance(now)
  const result = await f.service.command('alpha', { type: 'board-cleanup' })
  expect(result.state.board).toHaveLength(32)
  const archive = JSON.parse(await readFile(result.state.boardMaintenance!.archivePath!, 'utf8'))
  expect(archive.board).toEqual(originals.slice(0, 16))
  expect(archive.reasons['entry-0']).toBe('unused')
  const reloaded = await loadSuperAgentDocument(join(f.root, 'alpha'))
  expect(reloaded.state.board).toEqual(result.state.board)
  expect(reloaded.state.boardMaintenance).toEqual(result.state.boardMaintenance)
})

test('boards above the old limit remain readable; protected capacity blocks new entries but permits updates', async () => {
  const f = await superAgentFixture()
  const d = document(state(SUPER_AGENT_BOARD_LIMIT))
  d.state.board.forEach(item => { item.pinned = true })
  await seed(f, d)
  expect((await loadSuperAgentDocument(join(f.root, 'alpha'))).state.board).toHaveLength(1024)
  await expect(f.service.command('alpha', { type: 'board-upsert', expectedRevision: 0,
    item: { id: 'new', title: 'New topic', content: 'Draft must not replace another entry' } })).rejects.toThrow('[board:capacity]')
  expect((await f.service.get('alpha')).state.board).toHaveLength(1024)
  const updated = await f.service.command('alpha', { type: 'board-upsert', expectedRevision: 1,
    item: { id: 'entry-0', title: 'Updated existing topic', content: 'Same topic remains usable' } })
  expect(updated.state.board[0]).toMatchObject({ revision: 2, title: 'Updated existing topic' })
  await expect(f.service.command('alpha', { type: 'board-upsert', expectedRevision: 1,
    item: { id: 'entry-0', title: 'Stale writer', content: 'Must not overwrite revision 2' } })).rejects.toThrow('revision 2')
  expect((await f.service.get('alpha')).state.board[0]!.title).toBe('Updated existing topic')
})

test('automatic pressure cleanup resumes the original insertion and preserves its new references', async () => {
  const f = await superAgentFixture()
  const d = document(state(SUPER_AGENT_BOARD_LIMIT))
  await seed(f, d)
  f.advance(now)
  const result = await f.service.command('alpha', { type: 'board-upsert', expectedRevision: 0,
    item: { id: 'new', title: 'Current', content: 'Keep source entry-0' } })
  expect(result.state.board.map(item => item.id)).toContain('entry-0')
  expect(result.state.board.map(item => item.id)).toContain('new')
  expect(result.state.board.length).toBeLessThan(100)
  expect(result.state.boardMaintenance!.archived).toBeGreaterThan(900)
})

test('archive failure is visible and durable, keeps the board intact, and does not stop unrelated worker work', async () => {
  let failing = true
  const f = await superAgentFixture({ archiveBoard: async input => {
    if (failing) throw Object.assign(new Error('Blocked history directory'), { code: 'ENOTDIR' })
    return writeSuperAgentBoardArchive(input)
  } })
  const d = document()
  await seed(f, d)
  f.advance(now)
  const blocked = await f.service.command('alpha', { type: 'board-cleanup' })
  expect(blocked.state.board).toEqual(d.state.board)
  expect(blocked.state.boardMaintenance).toMatchObject({ status: 'retrying', issue: { attempts: 1, code: 'archive_failed' } })
  const reloaded = await loadSuperAgentDocument(join(f.root, 'alpha'))
  expect(reloaded.state.boardMaintenance!.status).toBe('retrying')
  await f.service.command('alpha', { type: 'task', nodeId: 'worker', title: 'Other work', instructions: 'Continue unrelated authorized work' })
  await until(() => f.service.get('alpha'), () => f.host.sends.length === 1)
  const sessionId = f.host.sends[0]!.sessionId
  const read = await f.service.getNodeSharedData('alpha', sessionId)
  expect(read.boardMaintenance!.issue!.code).toBe('archive_failed')
  // Maintenance during a live turn must preserve its identity and eventual completion.
  failing = false
  f.advance(SUPER_AGENT_BOARD_RETRY_MS)
  await f.service.tick()
  f.host.complete(sessionId, 'Unrelated work completed')
  const complete = await until(() => f.service.get('alpha'), value => value.state.tasks[0]?.status === 'completed')
  expect(complete.state.boardMaintenance!.status).toBe('ready')
})

test('the byte budget rejects oversized growth without altering existing records', async () => {
  const f = await superAgentFixture()
  const d = document(state(142))
  d.state.board.forEach(item => { item.pinned = true; item.content = '文'.repeat(20000) })
  // Legacy boards can load even if already over the new operational byte budget.
  expect(superAgentBoardBytes(d.state.board)).toBeGreaterThan(SUPER_AGENT_BOARD_BYTES)
  await seed(f, d)
  await expect(f.service.command('alpha', { type: 'board-upsert', item: { id: 'large', title: 'Extra', content: 'x' } })).rejects.toThrow('8 MiB')
  expect((await f.service.get('alpha')).state.board).toEqual(d.state.board)
  const shrinking = await f.service.command('alpha', { type: 'board-upsert', expectedRevision: 1,
    item: { id: 'entry-0', title: d.state.board[0]!.title, content: 'Smaller existing record' } })
  expect(shrinking.state.board[0]!.revision).toBe(2)
  expect(superAgentBoardBytes(shrinking.state.board)).toBeLessThan(superAgentBoardBytes(d.state.board))
  expect(superAgentBoardBytes(shrinking.state.board)).toBeGreaterThan(SUPER_AGENT_BOARD_BYTES)
})

test('native board writes retain host task ownership, pin/expiry metadata and retry idempotence', async () => {
  const f = await superAgentFixture()
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'task', id: 'writer', nodeId: 'worker', title: 'Publish contract', instructions: 'Publish one shared contract' })
  const active = await until(() => f.service.get('alpha'), () => f.host.sends.length === 1)
  const sessionId = active.state.tasks[0]!.sessionId!
  const input = { requestId: 'publish', id: 'contract', title: 'Contract', content: 'Long-lived contract', expectedRevision: 0,
    pinned: true, expiresAt: f.now() + 5000 }
  const first = await f.service.callNodeActionTool('alpha', sessionId, 'super_agent_board', input)
  const retry = await f.service.callNodeActionTool('alpha', sessionId, 'super_agent_board', input)
  expect(retry).toEqual(first)
  const saved = (await loadSuperAgentDocument(join(f.root, 'alpha'))).state.board
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ id: 'contract', taskId: 'writer', pinned: true, expiresAt: input.expiresAt, revision: 1 })
})
