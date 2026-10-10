import type { SessionMeta } from '../atoms/sessions'

/** One history entry per conversation, with the selected variant as its target. */
export function collapseSessionBranchHistory(
  items: SessionMeta[],
  selectedSessionId?: string | null,
  ancestry: SessionMeta[] = items,
): SessionMeta[] {
  const byId = new Map(ancestry.map(item => [item.id, item]))
  const roots = new Map<string, string>()
  const rootOf = (item: SessionMeta): string => {
    const path: string[] = []
    let current = item
    let root: string
    while (true) {
      const cached = roots.get(current.id)
      if (cached) { root = cached; break }
      const cycleStart = path.indexOf(current.id)
      if (cycleStart >= 0) { root = path.slice(cycleStart).sort()[0]!; break }
      path.push(current.id)
      if (!current.branchFromSessionId) { root = current.id; break }
      const parent = byId.get(current.branchFromSessionId)
      // Surviving siblings still share one entry after deleting their source.
      if (!parent) { root = current.branchFromSessionId; break }
      if (parent.workspaceId !== item.workspaceId) { root = current.id; break }
      current = parent
    }
    for (const id of path) roots.set(id, root)
    return root
  }

  const groups = new Map<string, SessionMeta[]>()
  for (const item of items) {
    const key = `${item.workspaceId}:${rootOf(item)}`
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  return [...groups.values()].map(group => {
    if (group.length === 1 && !group[0]!.branchFromSessionId) return group[0]!
    const latest = group.reduce((a, b) => (b.lastMessageAt ?? b.createdAt ?? 0) > (a.lastMessageAt ?? a.createdAt ?? 0) ? b : a)
    const target = group.find(item => item.id === selectedSessionId) ?? latest
    const original = byId.get(rootOf(target))
    return {
      ...target,
      name: original?.name ?? target.name,
      preview: original?.preview ?? target.preview,
      createdAt: original?.createdAt ?? target.createdAt,
      lastMessageAt: latest.lastMessageAt ?? latest.createdAt,
      isProcessing: group.some(item => item.isProcessing),
      hasUnread: group.some(item => item.hasUnread),
    }
  })
}
