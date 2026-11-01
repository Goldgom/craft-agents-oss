import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  planSuperAgentBoardCleanup, SUPER_AGENT_BOARD_SCAN_MS, SUPER_AGENT_BOARD_LIMIT, SUPER_AGENT_BOARD_BYTES, superAgentBoardBytes,
  SUPER_AGENT_BOARD_RETRY_MS, SUPER_AGENT_BOARD_RETRY_MAX_MS,
} from '@tokenbird/shared/super-agent/board'
import type { SuperAgentBoardItem, SuperAgentDocument } from '@tokenbird/shared/super-agent'

export type SuperAgentBoardArchiveWriter = (input: {
  workspaceId: string; root: string; revision: number; at: number
  items: SuperAgentBoardItem[]; reasons: Record<string, string>
}) => Promise<string>

/** Archive is synced before the live board can lose a record. Failed writes leave no partial archive. */
export const writeSuperAgentBoardArchive: SuperAgentBoardArchiveWriter = async input => {
  const directory = join(input.root, 'super-agent', 'history', 'board')
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${input.at}-${randomUUID()}.json`)
  const temporary = `${path}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify({ version: 1, workspaceId: input.workspaceId,
      sourceRevision: input.revision, archivedAt: input.at, board: input.items, reasons: input.reasons }), 'utf8'); await file.sync() }
    finally { await file.close() }
    await rename(temporary, path)
  } catch (error) { await unlink(temporary).catch(() => undefined); throw error }
  return path
}

export class SuperAgentBoardError extends Error {
  constructor(readonly code: 'archive_failed' | 'capacity', message: string) {
    super(`[board:${code}] ${message}`)
    this.name = 'SuperAgentBoardError'
  }
}

/** Bounded I/O bursts, with durable backoff between cycles; recovery never needs a model turn. */
export async function maintainSuperAgentBoard(input: {
  workspaceId: string; root: string; document: SuperAgentDocument; now: number
  force?: boolean; pressure?: boolean; preserveIds?: string[]; writeArchive?: SuperAgentBoardArchiveWriter
}): Promise<boolean> {
  const { document, now } = input
  const previous = document.state.boardMaintenance
  if (!input.force) {
    if (!document.state.board.length && !previous?.issue) return false
    // Pressure writes must also honor recovery backoff. Legacy blocked issues without
    // retryAt get a due time from checkedAt, so upgrading never leaves them stuck.
    if (previous?.issue) {
      if (now < (previous.issue.retryAt ?? previous.checkedAt + SUPER_AGENT_BOARD_RETRY_MS)) return false
    } else if (!input.pressure && previous && now - previous.checkedAt < SUPER_AGENT_BOARD_SCAN_MS) return false
  }
  const plan = planSuperAgentBoardCleanup(document.state, now, [...document.pendingTurns, ...(document.failedTurns ?? [])], input.preserveIds)
  const maintenance = { status: 'ready' as const, checkedAt: now, archived: previous?.archived ?? 0,
    lastArchived: 0, ...(previous?.archivePath ? { archivePath: previous.archivePath } : {}) }
  const capacityIssue = () => ({ code: 'capacity' as const, attempts: 0, retryAt: now + SUPER_AGENT_BOARD_RETRY_MS,
    message: 'Protected entries were retained. The host will automatically recheck capacity as references and tasks settle. Reuse existing topic ids for updates; do not blindly retry creating new entries.' })
  const atCapacity = () => document.state.board.length >= SUPER_AGENT_BOARD_LIMIT || superAgentBoardBytes(document.state.board) >= SUPER_AGENT_BOARD_BYTES
  if (!plan.removed.length) {
    document.state.boardMaintenance = atCapacity()
      ? { ...maintenance, status: 'blocked', issue: capacityIssue() } : maintenance
    return true
  }
  const writer = input.writeArchive ?? writeSuperAgentBoardArchive
  let lastError: unknown
  let attempts = 0
  for (; attempts < 3; attempts++) {
    try {
      const archivePath = await writer({ workspaceId: input.workspaceId, root: input.root,
        revision: document.state.revision, at: now, items: plan.removed, reasons: plan.reasons })
      document.state.board = plan.retained
      document.state.boardMaintenance = { ...maintenance, archivePath,
        archived: maintenance.archived + plan.removed.length, lastArchived: plan.removed.length,
        ...(atCapacity() ? { status: 'blocked', issue: capacityIssue() } : {}) }
      return true
    } catch (error) {
      lastError = error
      // Invalid paths cannot recover within this burst, but may be repaired before
      // the next background cycle. They must not disable automatic recovery.
      const code = (error as NodeJS.ErrnoException).code
      if (code && !['EBUSY', 'EPERM', 'EACCES', 'EIO', 'EMFILE', 'ENFILE', 'ENOSPC'].includes(code)) { attempts++; break }
      if (attempts < 2) await new Promise(resolve => setTimeout(resolve, 50 * (attempts + 1)))
    }
  }
  const recoveryAttempt = Math.min((previous?.issue?.code === 'archive_failed' ? previous.issue.recoveryAttempt ?? 0 : 0) + 1, 32)
  const delay = Math.min(SUPER_AGENT_BOARD_RETRY_MAX_MS, SUPER_AGENT_BOARD_RETRY_MS * 2 ** (recoveryAttempt - 1))
  document.state.boardMaintenance = { ...maintenance, status: 'retrying', issue: { code: 'archive_failed', attempts,
    recoveryAttempt, retryAt: now + delay,
    message: `Archive failed; all original entries were retained. The host will retry automatically with backoff and resume cleanup when storage becomes available. ${String(lastError instanceof Error ? lastError.message : lastError).slice(0, 800)}` } }
  return true
}
