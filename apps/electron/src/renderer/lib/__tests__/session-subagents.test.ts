import { describe, expect, it } from 'bun:test'
import type { SessionMeta } from '../../atoms/sessions'
import { conversationListSessions, conversationSearchResults, sessionConversationId, subagentState } from '../session-subagents'

const session = (id: string, fields: Partial<SessionMeta> = {}): SessionMeta => ({ id, workspaceId: 'ws', ...fields })

describe('subagent conversation presentation', () => {
  it('keeps one parent row with live child activity and unread state without changing canonical metadata', () => {
    const parent = session('main', { name: 'Main', lastMessageAt: 1 })
    const child = session('child', { parentSessionId: 'main', isProcessing: true, lastMessageAt: 5, hasUnread: true })
    const other = session('other')
    const rows = conversationListSessions([child, parent, other])
    expect(rows.map(row => row.id)).toEqual(['main', 'other'])
    expect(rows[0]).toMatchObject({ name: 'Main', lastMessageAt: 5, isProcessing: true, hasUnread: true })
    expect(parent).toEqual(session('main', { name: 'Main', lastMessageAt: 1 }))
    expect(child.parentSessionId).toBe('main')
  })

  it('groups nested and archived children while keeping unrelated branch histories intact', () => {
    const rows = conversationListSessions([
      session('root'), session('child', { parentSessionId: 'root' }),
      session('nested', { parentSessionId: 'child', isArchived: true, hasUnread: true }),
      session('branch', { branchFromSessionId: 'root', branchFromMessageId: 'message' }),
      session('mini', { parentSessionId: 'root', hidden: true, lastMessageAt: 100 }),
    ])
    expect(rows.map(row => row.id)).toEqual(['root', 'branch'])
    expect(rows[0]?.hasUnread).toBe(true)
    expect(rows[0]?.lastMessageAt).toBe(0)
  })

  it('leaves children accessible if their parent is absent, hidden, or in a different workspace', () => {
    const rows = conversationListSessions([
      session('orphan', { parentSessionId: 'deleted' }),
      session('mini', { hidden: true }), session('hidden-parent', { parentSessionId: 'mini' }),
      session('elsewhere', { workspaceId: 'ws-2' }), session('cross', { parentSessionId: 'elsewhere' }),
    ])
    expect(rows.map(row => row.id)).toEqual(['orphan', 'hidden-parent', 'elsewhere', 'cross'])
  })

  it('retains a stable accessible row for corrupt cycles and self-parent references', () => {
    const items = [session('b', { parentSessionId: 'a' }), session('a', { parentSessionId: 'b' }), session('self', { parentSessionId: 'self' })]
    expect(conversationListSessions(items).map(row => row.id)).toEqual(['a', 'self'])
    expect(conversationListSessions(items.toReversed()).map(row => row.id).sort()).toEqual(['a', 'self'])
  })

  it('maps a child deep link and nested search hits back to the parent without separate result rows', () => {
    const items = [session('root'), session('child', { parentSessionId: 'root' }), session('nested', { parentSessionId: 'child' }), session('hidden', { hidden: true })]
    expect(sessionConversationId(items[2]!, new Map(items.map(item => [item.id, item])))).toBe('root')
    const results = conversationSearchResults(items, new Map([
      ['root', { matchCount: 1, snippet: 'Parent' }], ['child', { matchCount: 2, snippet: 'Child' }],
      ['nested', { matchCount: 3, snippet: 'Nested' }], ['hidden', { matchCount: 9, snippet: 'Hidden' }],
    ]))
    expect([...results.keys()]).toEqual(['root'])
    expect(results.get('root')?.matchCount).toBe(6)
    expect(results.get('root')?.subagentMatchCount).toBe(5)
  })

  it('does not claim that a stopped or waiting child is completed', () => {
    expect(subagentState(session('child', { isProcessing: false }))).toBe('idle')
    expect(subagentState(session('child', { isProcessing: true, sessionStatus: 'done' }))).toBe('running')
    expect(subagentState(session('child', { lastMessageRole: 'error' }))).toBe('error')
    expect(subagentState(session('child', { sessionStatus: 'done' }))).toBe('done')
    expect(subagentState(session('child', { sessionStatus: 'cancelled' }))).toBe('cancelled')
  })
})
