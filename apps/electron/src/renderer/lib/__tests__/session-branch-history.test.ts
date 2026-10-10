import { expect, test } from 'bun:test'
import type { SessionMeta } from '../../atoms/sessions'
import { collapseSessionBranchHistory } from '../session-branch-history'

function meta(id: string, parent?: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return { id, workspaceId: 'workspace', name: id, branchFromSessionId: parent, lastMessageAt: 1, ...extra }
}

test('nested and sibling branches share one entry with the original title and latest activity', () => {
  const items = [meta('root'), meta('a', 'root', { lastMessageAt: 3 }), meta('b', 'root'), meta('nested', 'a', { lastMessageAt: 5 }), meta('other')]
  const before = JSON.stringify(items)
  const result = collapseSessionBranchHistory(items)
  expect(result.map(item => item.id)).toEqual(['nested', 'other'])
  expect(result[0]).toMatchObject({ name: 'root', lastMessageAt: 5 })
  expect(JSON.stringify(items)).toBe(before)
})

test('viewing an older variant keeps its entry selected without losing newer activity or unread state', () => {
  const items = [meta('root'), meta('a', 'root', { lastMessageAt: 5, isProcessing: true, hasUnread: true }), meta('b', 'root')]
  expect(collapseSessionBranchHistory(items, 'b')[0]).toMatchObject({
    id: 'b', name: 'root', lastMessageAt: 5, isProcessing: true, hasUnread: true,
  })
  expect(collapseSessionBranchHistory(items, 'root')[0]?.id).toBe('root')
})

test('surviving branches stay accessible and grouped when their source has been deleted', () => {
  expect(collapseSessionBranchHistory([meta('a', 'deleted'), meta('b', 'deleted', { lastMessageAt: 4 }), meta('nested', 'a')]).map(item => item.id)).toEqual(['b'])
})

test('search matches in a nested branch resolve to one matching entry using the full ancestry', () => {
  const root = meta('root')
  const a = meta('a', 'root')
  const nested = meta('nested', 'a', { lastMessageAt: 3 })
  expect(collapseSessionBranchHistory([a, nested], undefined, [root, a, nested])[0]).toMatchObject({ id: 'nested', name: 'root' })
  expect(collapseSessionBranchHistory([nested], undefined, [root, a, nested])).toHaveLength(1)
})

test('malformed cycles terminate and cross-workspace references never merge entries', () => {
  expect(collapseSessionBranchHistory([meta('a', 'b'), meta('b', 'a')])).toHaveLength(1)
  expect(collapseSessionBranchHistory([meta('root'), meta('a', 'root', { workspaceId: 'other' })])).toHaveLength(2)
})

test('entry actions keep the selected variant metadata for archive, flags, and status', () => {
  const root = meta('root', undefined, { isArchived: true, isFlagged: true, sessionStatus: 'done' })
  const branch = meta('a', 'root', { isArchived: false, isFlagged: false, sessionStatus: 'todo', lastMessageAt: 2 })
  expect(collapseSessionBranchHistory([root, branch], 'a')[0]).toMatchObject({
    id: 'a', isArchived: false, isFlagged: false, sessionStatus: 'todo',
  })
  expect(collapseSessionBranchHistory([root, branch], 'root')[0]).toMatchObject({
    id: 'root', isArchived: true, isFlagged: true, sessionStatus: 'done',
  })
})
