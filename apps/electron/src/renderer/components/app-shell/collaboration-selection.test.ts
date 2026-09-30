import { describe, expect, it } from 'bun:test'
import type { SessionMeta } from '@/atoms/sessions'
import { availableCollaborationSessions, collaborationSelections, collaborationSessionKey } from './collaboration-selection'

const session = (id: string, workspaceId = 'main', extra = {}) => ({ id, workspaceId, name: id, ...extra }) as SessionMeta

describe('collaboration selection', () => {
  it('keys sessions by workspace as well as id and excludes unavailable sessions', () => {
    const primary = session('same')
    const other = session('same', 'other')
    expect(collaborationSessionKey(primary)).not.toBe(collaborationSessionKey(other))
    expect(availableCollaborationSessions([
      primary, other, session('archived', 'main', { isArchived: true }),
      session('hidden', 'main', { hidden: true }), session('member', 'main', { collaboration: {} }),
    ], primary)).toEqual([other])
  })

  it('sends only still-eligible selections and explicit new session requests', () => {
    const candidate = session('selected')
    expect(collaborationSelections([candidate], new Set([collaborationSessionKey(candidate), 'stale']), [
      { workspaceId: 'other', name: '  Fresh  ' },
    ])).toEqual([
      { sessionId: 'selected', workspaceId: 'main', name: 'selected' },
      { createNew: true, workspaceId: 'other', name: 'Fresh' },
    ])
    expect(collaborationSelections([], new Set(['stale']), [])).toEqual([])
  })
})
