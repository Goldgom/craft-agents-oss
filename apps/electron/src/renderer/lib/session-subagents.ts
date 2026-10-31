import type { SessionMeta } from '../atoms/sessions'

/** Resolve only accessible, same-workspace parents. Orphans stay discoverable. */
export function sessionConversationId(session: SessionMeta, byId: ReadonlyMap<string, SessionMeta>): string {
  const path: string[] = []
  let current = session
  while (true) {
    const cycle = path.indexOf(current.id)
    if (cycle >= 0) return path.slice(cycle).sort()[0]!
    path.push(current.id)
    const parent = current.parentSessionId ? byId.get(current.parentSessionId) : undefined
    if (!parent || parent.hidden || parent.workspaceId !== session.workspaceId) return current.id
    current = parent
  }
}

/** Presentation only: retain the original child metadata and transcripts in the store. */
export function conversationListSessions(items: SessionMeta[]): SessionMeta[] {
  const visible = items.filter(item => !item.hidden)
  const byId = new Map(visible.map(item => [item.id, item]))
  const groups = new Map<string, SessionMeta[]>()
  for (const item of visible) {
    const root = sessionConversationId(item, byId)
    const group = groups.get(root) ?? []
    group.push(item)
    groups.set(root, group)
  }
  return [...groups.entries()].map(([id, group]) => {
    const root = byId.get(id)!
    if (group.length === 1) return root
    return {
      ...root,
      hasUnread: group.some(item => item.hasUnread),
      isProcessing: group.some(item => item.isProcessing),
      lastMessageAt: Math.max(...group.map(item => item.lastMessageAt ?? item.createdAt ?? 0)),
    }
  })
}

/** Child transcript search hits lead to their owning conversation, never a separate row. */
export function conversationSearchResults<T extends { matchCount: number; snippet: string }>(
  items: SessionMeta[], results: ReadonlyMap<string, T>,
): Map<string, T & { subagentMatchCount: number }> {
  const byId = new Map(items.filter(item => !item.hidden).map(item => [item.id, item]))
  const grouped = new Map<string, T & { subagentMatchCount: number }>()
  for (const [id, result] of results) {
    const item = byId.get(id)
    if (!item) continue
    const root = sessionConversationId(item, byId)
    const previous = grouped.get(root)
    grouped.set(root, {
      ...result,
      matchCount: result.matchCount + (previous?.matchCount ?? 0),
      subagentMatchCount: (id !== root ? result.matchCount : 0) + (previous?.subagentMatchCount ?? 0),
    })
  }
  return grouped
}

export function subagentState(session: SessionMeta): 'running' | 'error' | 'done' | 'cancelled' | 'idle' {
  if (session.isProcessing) return 'running'
  if (session.lastMessageRole === 'error') return 'error'
  if (session.sessionStatus === 'done' || session.sessionStatus === 'cancelled') return session.sessionStatus
  return 'idle'
}
