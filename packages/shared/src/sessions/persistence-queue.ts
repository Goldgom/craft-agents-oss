import { open, rename, unlink } from 'fs/promises'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { dirname } from 'path'
import type { StoredSession, SessionHeader } from './types.js'
import { getSessionFilePath, ensureSessionsDir, ensureSessionDir } from './storage.js'
import { toPortablePath } from '../utils/paths.js'
import { createSessionHeader, makeSessionPathPortable, readSessionHeader } from './jsonl.js'
import { debug } from '../utils/debug.js'

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800]

/** Narrow filesystem seam for failure-boundary tests; production uses Node fs. */
export interface SessionPersistenceFileOperations {
  open(path: string, flags: string, mode?: number): Promise<{ writeFile(data: string, encoding: 'utf8'): Promise<void>; sync(): Promise<void>; close(): Promise<void> }>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

interface PendingWrite {
  data: StoredSession
  timer?: ReturnType<typeof setTimeout>
  version: number
  cancelled?: boolean
}

interface HeaderMetadataSignature {
  name?: string
  labels?: string[]
  isFlagged?: boolean
  sessionStatus?: string
  permissionMode?: string
  hasUnread?: boolean
  lastReadMessageId?: string
}

function getHeaderMetadataSignature(header: SessionHeader): string {
  const signature: HeaderMetadataSignature = {
    name: header.name,
    labels: header.labels,
    isFlagged: header.isFlagged,
    sessionStatus: header.sessionStatus,
    permissionMode: header.permissionMode,
    hasUnread: header.hasUnread,
    lastReadMessageId: header.lastReadMessageId,
  }
  return JSON.stringify(signature)
}

function mergeHeaderWithExternalMetadata(localHeader: SessionHeader, diskHeader: SessionHeader): SessionHeader {
  return {
    ...localHeader,
    name: diskHeader.name,
    labels: diskHeader.labels,
    isFlagged: diskHeader.isFlagged,
    sessionStatus: diskHeader.sessionStatus,
    permissionMode: diskHeader.permissionMode,
    hasUnread: diskHeader.hasUnread,
    lastReadMessageId: diskHeader.lastReadMessageId,
  }
}

/**
 * Debounced async session persistence queue.
 * Prevents main thread blocking by using async writes and coalescing
 * rapid successive persist calls into a single write.
 *
 * IMPORTANT: Writes are serialized per-session to prevent race conditions
 * when rapid successive flushes (e.g., clearSessionForRecovery + onSdkSessionIdUpdate)
 * would otherwise write to the same .tmp file concurrently.
 */
class SessionPersistenceQueue {
  private pending = new Map<string, PendingWrite>()
  private writeInProgress = new Map<string, { promise: Promise<void>; entry: PendingWrite }>()
  private writtenVersions = new Map<string, number>()
  private nextVersion = 1
  private lastWrittenHeaderSignature = new Map<string, string>()
  private debounceMs: number

  constructor(debounceMs = 500, private readonly fileOperations: SessionPersistenceFileOperations = { open, rename, unlink }) {
    this.debounceMs = debounceMs
  }

  /**
   * Queue a session for persistence. If a write is already pending for this
   * session, it will be replaced with the new data and the timer reset.
   */
  enqueue(session: StoredSession): void {
    const existing = this.pending.get(session.id)
    if (existing?.timer) clearTimeout(existing.timer)
    const entry: PendingWrite = { data: session, version: this.nextVersion++ }
    entry.timer = setTimeout(() => {
      // Debounced callers remain best-effort; strict flush callers observe the
      // same rejection. Failed snapshots stay dirty for a later explicit retry.
      void this.flush(session.id).catch(error => {
        if (!entry.cancelled) console.error(`[PersistenceQueue] Failed to write session ${session.id}:`, error)
      })
    }, this.debounceMs)
    this.pending.set(session.id, entry)
  }

  private async renameWithRetry(tmpFile: string, filePath: string, entry: PendingWrite): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      if (entry.cancelled) throw new Error('Session persistence was cancelled')
      try {
        await this.fileOperations.rename(tmpFile, filePath)
        return
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        const retryDelay = RENAME_RETRY_DELAYS_MS[attempt]
        if (typeof code !== 'string' || !RENAME_RETRY_CODES.has(code) || retryDelay === undefined) throw error
        await delay(retryDelay)
      }
    }
  }

  /**
   * Write a session to disk immediately in JSONL format.
   * Uses atomic write (write-to-temp-then-rename) to prevent corruption on crash.
   */
  private async write(sessionId: string, entry: PendingWrite): Promise<void> {
    let tmpFile: string | undefined
    const previousSignature = this.lastWrittenHeaderSignature.get(sessionId)
    let signaturePublished = false
    try {
      const { data } = entry
      ensureSessionsDir(data.workspaceRootPath)
      ensureSessionDir(data.workspaceRootPath, sessionId)

      const filePath = getSessionFilePath(data.workspaceRootPath, sessionId)

      // Prepare session with portable paths for cross-machine compatibility
      const storageSession: StoredSession = {
        ...data,
        workspaceRootPath: toPortablePath(data.workspaceRootPath),
        workingDirectory: data.workingDirectory ? toPortablePath(data.workingDirectory) : undefined,
        sdkCwd: data.sdkCwd ? toPortablePath(data.sdkCwd) : undefined,
        lastUsedAt: Date.now(),
      }

      // Create JSONL content: header + messages (one per line)
      // Filter out intermediate messages - they're transient streaming status updates
      const localHeader = createSessionHeader(storageSession)
      const localSig = getHeaderMetadataSignature(localHeader)
      const diskHeader = readSessionHeader(filePath)
      const previousSig = this.lastWrittenHeaderSignature.get(sessionId)
      const diskSig = diskHeader ? getHeaderMetadataSignature(diskHeader) : undefined

      // Queue writes should never clobber session metadata changed externally
      // (watcher edits, direct header edits, other instances), but they must
      // still persist local metadata updates (e.g. generated title).
      //
      // Preserve disk metadata only when disk diverged from our last written
      // signature, which indicates an external mutation.
      const hasMetadataMismatch = !!diskHeader && !!diskSig && diskSig !== localSig
      const hasExternalMetadataChange = !!diskHeader && !!diskSig && !!previousSig && diskSig !== previousSig
      const header = hasExternalMetadataChange && diskHeader
        ? mergeHeaderWithExternalMetadata(localHeader, diskHeader)
        : localHeader

      if (hasMetadataMismatch) {
        const baseline = previousSig ? `, previousSig=${previousSig.slice(0, 12)}` : ', previousSig=<none>'
        const mode = hasExternalMetadataChange ? 'disk preserved' : 'local preserved'
        debug(`[PersistenceQueue] Session ${sessionId} metadata mismatch detected (${mode}${baseline})`)
      }

      const persistableMessages = storageSession.messages
      // Use original absolute sessionDir (before toPortablePath) for path replacement
      const sessionDir = dirname(filePath)
      const lines = [
        makeSessionPathPortable(JSON.stringify(header), sessionDir),
        ...persistableMessages.map(m => makeSessionPathPortable(JSON.stringify(m), sessionDir)),
      ]

      // Each writer owns its temp name. Never unlink the destination: rename
      // atomically replaces it, and failure must leave the old session intact.
      tmpFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`
      const handle = await this.fileOperations.open(tmpFile, 'wx', 0o600)
      try {
        await handle.writeFile(lines.join('\n') + '\n', 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (entry.cancelled) throw new Error('Session persistence was cancelled')
      // Set immediately before publication so fs.watch sees the new signature.
      this.lastWrittenHeaderSignature.set(sessionId, getHeaderMetadataSignature(header))
      signaturePublished = true
      await this.renameWithRetry(tmpFile, filePath, entry)
      tmpFile = undefined
      if (entry.cancelled) throw new Error('Session persistence was cancelled')
      debug(`[PersistenceQueue] Wrote session ${sessionId}`)
    } catch (error) {
      if (signaturePublished && !entry.cancelled) {
        if (previousSignature === undefined) this.lastWrittenHeaderSignature.delete(sessionId)
        else this.lastWrittenHeaderSignature.set(sessionId, previousSignature)
      }
      throw error
    } finally {
      if (tmpFile) await this.fileOperations.unlink(tmpFile).catch(() => {})
    }
  }

  /**
   * Strict completion boundary for the snapshot visible when flush is called.
   * Timer-triggered writes use this same serialized path. A pending or failed
   * write cannot disappear into a successful no-op flush.
   */
  async flush(sessionId: string): Promise<void> {
    const target = this.pending.get(sessionId)?.version ?? this.writeInProgress.get(sessionId)?.entry.version
    if (target === undefined) return
    while ((this.writtenVersions.get(sessionId) ?? 0) < target) {
      const active = this.writeInProgress.get(sessionId)
      if (active) {
        await active.promise
        continue
      }
      const entry = this.pending.get(sessionId)
      if (!entry) throw new Error('Session persistence was cancelled before completion')
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = undefined
      this.pending.delete(sessionId)
      const promise = this.write(sessionId, entry).then(() => {
        if (entry.cancelled) throw new Error('Session persistence was cancelled')
        this.writtenVersions.set(sessionId, entry.version)
      }).catch(error => {
        // A newer snapshot supersedes the failed one. Otherwise retain this
        // dirty snapshot without a retry timer, avoiding a background loop.
        if (!entry.cancelled && !this.pending.has(sessionId)) this.pending.set(sessionId, entry)
        throw error
      })
      this.writeInProgress.set(sessionId, { promise, entry })
      try { await promise }
      finally {
        if (this.writeInProgress.get(sessionId)?.promise === promise) this.writeInProgress.delete(sessionId)
      }
    }
  }

  /**
   * Cancel a pending write for a session (e.g., when deleting the session).
   */
  cancel(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.cancelled = true
      this.pending.delete(sessionId)
      debug(`[PersistenceQueue] Cancelled pending write for session ${sessionId}`)
    }
    const active = this.writeInProgress.get(sessionId)
    if (active) active.entry.cancelled = true
    this.lastWrittenHeaderSignature.delete(sessionId)
    this.writtenVersions.delete(sessionId)
  }

  /**
   * Stop admission at the caller, then await every already-started filesystem
   * write before deleting the session directory. cancel() alone cannot retract
   * a rename submitted to the OS. Cancellation failures are expected here.
   */
  async cancelAndWait(sessionId: string): Promise<void> {
    this.cancel(sessionId)
    let active = this.writeInProgress.get(sessionId)
    while (active) {
      await active.promise.catch(() => {})
      this.cancel(sessionId)
      active = this.writeInProgress.get(sessionId)
    }
  }

  /**
   * Flush all pending sessions. Call this on app quit.
   */
  async flushAll(): Promise<void> {
    const sessionIds = [...new Set([...this.pending.keys(), ...this.writeInProgress.keys()])]
    const results = await Promise.allSettled(sessionIds.map(id => this.flush(id)))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }

  /**
   * Check if a session has a pending write.
   */
  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /**
   * Get the metadata signature of the last header we wrote for a session.
   * Used by ConfigWatcher to suppress self-triggered metadata change events.
   */
  getLastWrittenSignature(sessionId: string): string | undefined {
    return this.lastWrittenHeaderSignature.get(sessionId)
  }

  /**
   * Get count of pending writes.
   */
  get pendingCount(): number {
    return this.pending.size
  }
}

// Singleton instance
export const sessionPersistenceQueue = new SessionPersistenceQueue()

// Named exports for testing/customization
export { SessionPersistenceQueue, getHeaderMetadataSignature, mergeHeaderWithExternalMetadata }
