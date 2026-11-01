import type { SuperAgentBoardItem, SuperAgentState } from './types'

export const SUPER_AGENT_BOARD_LIMIT = 1024
export const SUPER_AGENT_BOARD_SOFT_LIMIT = 768
export const SUPER_AGENT_BOARD_BYTES = 8 * 1024 * 1024
export const SUPER_AGENT_BOARD_RETENTION_MS = 48 * 60 * 60 * 1000
export const SUPER_AGENT_BOARD_KEEP_RECENT = 32
export const SUPER_AGENT_BOARD_SCAN_MS = 30 * 60 * 1000
export const SUPER_AGENT_BOARD_RETRY_MS = 60 * 1000
export const SUPER_AGENT_BOARD_RETRY_MAX_MS = 30 * 60 * 1000

export interface SuperAgentBoardMaintenance {
  status: 'ready' | 'retrying' | 'blocked'
  checkedAt: number
  archived: number
  lastArchived: number
  archivePath?: string
  issue?: { code: 'archive_failed' | 'capacity'; message: string; attempts: number; recoveryAttempt?: number; retryAt?: number }
}

export function superAgentBoardBytes(items: SuperAgentBoardItem[]): number {
  return new TextEncoder().encode(JSON.stringify(items)).byteLength
}

/** A conservative, pure plan: archive old unused records, never infer usefulness from prose. */
export function planSuperAgentBoardCleanup(
  state: SuperAgentState,
  now: number,
  turns: Array<{ nodeId: string; taskId?: string; text: string }> = [],
  preserveIds: string[] = [],
) {
  const protectedIds = new Set(preserveIds)
  const taskIds = new Set(state.tasks.filter(task => ['queued', 'running', 'failed'].includes(task.status)
    || task.acceptance?.status === 'stale' || task.acceptance?.status === 'rejected').map(task => task.id))
  const busyAuthors = new Set(state.nodes.filter(node => ['working', 'preparing', 'recovering'].includes(node.status)).map(node => node.nodeId))
  for (const turn of turns) { if (turn.taskId) taskIds.add(turn.taskId); busyAuthors.add(turn.nodeId) }
  const unknownIds: string[] = []
  for (const operation of state.operations ?? []) if (['prepared', 'running', 'unknown'].includes(operation.status)) {
    unknownIds.push(operation.id)
    if (operation.taskId) taskIds.add(operation.taskId)
    else busyAuthors.add(operation.nodeId)
  }
  // Dependencies and input evidence can still be needed after their producer finishes.
  for (const taskId of taskIds) {
    const task = state.tasks.find(task => task.id === taskId)
    for (const id of [...(task?.dependsOn ?? []), ...(task?.reviewOf ? [task.reviewOf] : []),
      ...(task?.acceptance ? [task.acceptance.evidenceTaskId] : []),
      ...(state.artifacts ?? []).filter(artifact => task?.inputArtifacts?.some(input => input.id === artifact.id)).map(artifact => artifact.taskId)]) taskIds.add(id)
  }
  const ids = new Set(state.board.map(item => item.id))
  const unusualIds = [...ids].filter(id => !/^[\p{L}\p{N}_-]+$/u.test(id))
  const retainReferences = (value: unknown) => {
    const text = JSON.stringify(value) ?? ''
    for (const token of text.match(/[\p{L}\p{N}_-]+/gu) ?? []) if (ids.has(token)) protectedIds.add(token)
    for (const id of unusualIds) if (text.includes(id)) protectedIds.add(id)
  }
  retainReferences([
    state.tasks.filter(task => taskIds.has(task.id)),
    state.plans.filter(plan => !['completed', 'cancelled'].includes(plan.status)),
    state.intents?.filter(goal => !['delivered', 'cancelled'].includes(goal.status ?? 'active')),
    state.reports?.filter(report => report.sequence > (state.reportCursors?.[report.recipientNodeId ?? ''] ?? state.consumedReportSequence ?? 0)),
    turns,
  ])
  for (const item of state.board) if (item.pinned || busyAuthors.has(item.updatedBy)
    || item.taskId && taskIds.has(item.taskId) || unknownIds.some(id => item.content.includes(id))) protectedIds.add(item.id)
  // Keep references from every record that will survive, including chains across board items.
  const newest = [...state.board].sort((a, b) => b.updatedAt - a.updatedAt || b.revision - a.revision)
  const recent = new Set(newest.slice(0, SUPER_AGENT_BOARD_KEEP_RECENT).map(item => item.id))
  const seen = new Set<string>()
  const candidates = new Map<string, 'duplicate' | 'expired' | 'unused'>()
  for (const item of newest) {
    const key = JSON.stringify([item.title, item.content, item.taskId])
    const duplicate = seen.has(key); seen.add(key)
    if (duplicate) candidates.set(item.id, 'duplicate')
    else if (item.expiresAt != null && item.expiresAt <= now) candidates.set(item.id, 'expired')
    else if (!recent.has(item.id) && item.updatedAt < now - SUPER_AGENT_BOARD_RETENTION_MS) candidates.set(item.id, 'unused')
  }
  for (const item of state.board) if (!candidates.has(item.id)) protectedIds.add(item.id)
  const byId = new Map(state.board.map(item => [item.id, item]))
  for (const id of protectedIds) { const item = byId.get(id); if (item) retainReferences(item.content) }
  const removed = state.board.filter(item => candidates.has(item.id) && !protectedIds.has(item.id))
  const removedIds = new Set(removed.map(item => item.id))
  return { removed, retained: state.board.filter(item => !removedIds.has(item.id)), protectedCount: protectedIds.size,
    reasons: Object.fromEntries(removed.map(item => [item.id, candidates.get(item.id)!])) }
}
