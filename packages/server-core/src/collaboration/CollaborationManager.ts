/**
 * Durable coordinator for a main session and its collaborating sessions.
 *
 * A group has exactly one primary member. All writes are serialized per group,
 * use a caller supplied operation id for retry safety, and require an expected
 * revision. This gives callers a clear conflict instead of silently losing a
 * concurrent board/file update. The primary owns requests; secondaries can
 * only report back to it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  CollaborationBoardItem,
  CollaborationChangeResult,
  CollaborationEvent,
  CollaborationFile,
  CollaborationGroup,
  CollaborationMember,
} from '@craft-agent/shared/protocol'

const MAX_EVENT_HISTORY = 500
const MAX_FILE_BYTES = 8 * 1024 * 1024
const LOCK_STALE_MS = 2 * 60_000
const LOCK_WAIT_MS = 10_000

export class CollaborationConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(`Collaboration changed concurrently (current revision: ${currentRevision}). Refresh and retry.`)
    this.name = 'CollaborationConflictError'
  }
}

export class CollaborationAuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CollaborationAuthorizationError'
  }
}

export class CollaborationManager {
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly rootForWorkspace: (workspaceId: string) => string) {}

  async create(primary: Omit<CollaborationMember, 'id' | 'role' | 'addedAt'>, secondaries: Array<Omit<CollaborationMember, 'id' | 'role' | 'addedAt'>>): Promise<CollaborationGroup> {
    if (!secondaries.length) throw new Error('A collaboration needs at least one secondary session')
    const all = [primary, ...secondaries]
    const identities = new Set(all.map(member => this.identity(member)))
    if (identities.size !== all.length) throw new Error('A session can only appear once in a collaboration')
    const groupId = `collab_${randomUUID()}`
    const now = Date.now()
    const members: CollaborationMember[] = [
      { ...primary, id: 'primary', role: 'primary', addedAt: now },
      ...secondaries.map((member, index) => ({ ...member, id: `secondary_${index + 1}`, role: 'secondary' as const, addedAt: now })),
    ]
    const group: CollaborationGroup = {
      id: groupId, version: 1, revision: 0, primaryMemberId: 'primary', members,
      board: {}, files: {}, events: [], createdAt: now, updatedAt: now,
    }
    await this.write(group)
    return group
  }

  async get(groupId: string): Promise<CollaborationGroup> {
    return this.read(groupId)
  }

  /** Rehydrate an opaque group id after a server restart. The coordinator
   * workspace is public metadata, not a credential; remote relays carry it
   * alongside the group id. */
  async open(groupId: string, coordinatorWorkspaceId: string): Promise<CollaborationGroup> {
    this.groupWorkspaces.set(groupId, coordinatorWorkspaceId)
    return this.read(groupId)
  }

  async list(workspaceId: string): Promise<CollaborationGroup[]> {
    const { readdir } = await import('node:fs/promises')
    const dir = this.directory(workspaceId)
    try {
      const files = await readdir(dir)
      const groups = await Promise.all(files.filter(name => name.endsWith('.json')).map(name => this.readByPath(join(dir, name))))
      return groups.filter(group => group.members.some(member => member.workspaceId === workspaceId)).sort((a, b) => b.updatedAt - a.updatedAt)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  /** Primary -> a selected secondary. The caller must be the primary member. */
  request(groupId: string, actorMemberId: string, targetMemberId: string, text: string, operationId: string, expectedRevision: number): Promise<CollaborationChangeResult> {
    return this.mutate(groupId, expectedRevision, operationId, group => {
      this.requirePrimary(group, actorMemberId)
      const target = this.member(group, targetMemberId)
      if (target.role !== 'secondary') throw new CollaborationAuthorizationError('Requests can only target a secondary session')
      return this.appendEvent(group, { operationId, type: 'request', fromMemberId: actorMemberId, toMemberId: targetMemberId, text })
    })
  }

  /** Secondary -> primary. Direct secondary-to-secondary and self-routing are rejected. */
  report(groupId: string, actorMemberId: string, text: string, operationId: string, expectedRevision: number): Promise<CollaborationChangeResult> {
    return this.mutate(groupId, expectedRevision, operationId, group => {
      const actor = this.member(group, actorMemberId)
      if (actor.role !== 'secondary') throw new CollaborationAuthorizationError('Only a secondary session can report to the primary')
      return this.appendEvent(group, { operationId, type: 'report', fromMemberId: actorMemberId, toMemberId: group.primaryMemberId, text })
    })
  }

  updateBoard(groupId: string, actorMemberId: string, itemId: string, value: unknown, operationId: string, expectedRevision: number): Promise<CollaborationChangeResult> {
    if (!itemId.trim()) return Promise.reject(new Error('Board item id is required'))
    return this.mutate(groupId, expectedRevision, operationId, group => {
      this.member(group, actorMemberId)
      const revision = group.revision + 1
      const item: CollaborationBoardItem = { id: itemId, value, version: revision, updatedAt: Date.now(), updatedBy: actorMemberId }
      group.board[itemId] = item
      return this.appendEvent(group, { operationId, type: 'board', fromMemberId: actorMemberId })
    })
  }

  async putFile(groupId: string, actorMemberId: string, name: string, dataBase64: string, contentType: string | undefined, operationId: string, expectedRevision: number): Promise<CollaborationChangeResult> {
    const data = Buffer.from(dataBase64, 'base64')
    if (!name.trim() || name.includes('/') || name.includes('\\')) throw new Error('Shared file name must be a plain file name')
    if (!data.length || data.length > MAX_FILE_BYTES) throw new Error(`Shared file must be between 1 byte and ${MAX_FILE_BYTES} bytes`)
    return this.mutate(groupId, expectedRevision, operationId, async group => {
      this.member(group, actorMemberId)
      const id = this.safeFileId(name)
      const sha256 = createHash('sha256').update(data).digest('hex')
      const file: CollaborationFile = { id, name, contentType, size: data.length, sha256, version: group.revision + 1, updatedAt: Date.now(), updatedBy: actorMemberId }
      const filesDir = this.filesDirectory(group)
      await mkdir(filesDir, { recursive: true })
      // Publish bytes before metadata. Readers therefore either see the prior
      // metadata or a complete new file; never a partially-written payload.
      const path = join(filesDir, id)
      const tmp = `${path}.${randomUUID()}.tmp`
      await writeFile(tmp, data)
      await rename(tmp, path)
      group.files[id] = file
      return this.appendEvent(group, { operationId, type: 'file', fromMemberId: actorMemberId })
    })
  }

  async getFile(groupId: string, fileId: string): Promise<{ file: CollaborationFile; dataBase64: string }> {
    const group = await this.read(groupId)
    const file = group.files[fileId]
    if (!file) throw new Error('Shared file not found')
    const data = await readFile(join(this.filesDirectory(group), file.id))
    if (createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error('Shared file integrity check failed')
    return { file, dataBase64: data.toString('base64') }
  }

  private mutate(groupId: string, expectedRevision: number, operationId: string, apply: (group: CollaborationGroup) => CollaborationEvent | Promise<CollaborationEvent>): Promise<CollaborationChangeResult> {
    if (!operationId?.trim()) return Promise.reject(new Error('operationId is required for idempotent collaboration mutations'))
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) return Promise.reject(new Error('expectedRevision must be a non-negative integer'))
    return this.enqueue(groupId, () => this.withFileLock(groupId, async () => {
      const group = await this.read(groupId)
      if (group.events.some(event => event.operationId === operationId)) return { group, applied: false }
      if (group.revision !== expectedRevision) throw new CollaborationConflictError(group.revision)
      const event = await apply(group)
      group.revision += 1
      event.revision = group.revision
      group.events.push(event)
      if (group.events.length > MAX_EVENT_HISTORY) group.events.splice(0, group.events.length - MAX_EVENT_HISTORY)
      group.updatedAt = Date.now()
      await this.write(group)
      return { group, applied: true }
    }))
  }

  private appendEvent(group: CollaborationGroup, input: Omit<CollaborationEvent, 'id' | 'createdAt' | 'revision'>): CollaborationEvent {
    return { ...input, id: randomUUID(), createdAt: Date.now(), revision: group.revision + 1 }
  }
  private member(group: CollaborationGroup, memberId: string): CollaborationMember {
    const member = group.members.find(candidate => candidate.id === memberId)
    if (!member) throw new CollaborationAuthorizationError('Session is not a member of this collaboration')
    return member
  }
  private requirePrimary(group: CollaborationGroup, memberId: string): CollaborationMember {
    const member = this.member(group, memberId)
    if (member.id !== group.primaryMemberId || member.role !== 'primary') throw new CollaborationAuthorizationError('Only the primary session can initiate requests')
    return member
  }
  private identity(member: Pick<CollaborationMember, 'sessionId' | 'workspaceId' | 'serverUrl'>): string { return `${member.serverUrl ?? 'local'}:${member.workspaceId}:${member.sessionId}` }
  private directory(workspaceId: string): string { return join(this.rootForWorkspace(workspaceId), '.craft-agent', 'collaborations') }
  private path(groupId: string, workspaceId: string): string { return join(this.directory(workspaceId), `${groupId}.json`) }
  private filesDirectory(group: CollaborationGroup): string { return join(this.directory(group.members.find(member => member.id === group.primaryMemberId)!.workspaceId), group.id, 'files') }
  private safeFileId(name: string): string { return createHash('sha256').update(name).digest('hex') }
  private async read(groupId: string): Promise<CollaborationGroup> {
    // The coordinator is the only storage owner. Find it lazily across known
    // workspace roots to allow a caller in any local workspace to read a group.
    const roots = new Set<string>()
    // Group ids are opaque; candidate directories are registered by writes.
    const workspaceId = this.groupWorkspaces.get(groupId)
    if (!workspaceId) throw new Error('Collaboration not found on this server')
    roots.add(workspaceId)
    for (const id of roots) return this.readByPath(this.path(groupId, id))
    throw new Error('Collaboration not found')
  }
  private readonly groupWorkspaces = new Map<string, string>()
  private async readByPath(path: string): Promise<CollaborationGroup> {
    const raw = await readFile(path, 'utf8')
    const group = JSON.parse(raw) as CollaborationGroup
    this.assertGroup(group)
    this.groupWorkspaces.set(group.id, group.members.find(member => member.id === group.primaryMemberId)!.workspaceId)
    return group
  }
  private async write(group: CollaborationGroup): Promise<void> {
    const primary = this.member(group, group.primaryMemberId)
    const dir = this.directory(primary.workspaceId)
    await mkdir(dir, { recursive: true })
    const path = this.path(group.id, primary.workspaceId)
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(group), 'utf8')
    await rename(tmp, path)
    this.groupWorkspaces.set(group.id, primary.workspaceId)
  }
  private assertGroup(group: CollaborationGroup): void {
    if (!group || group.version !== 1 || !group.id || !Array.isArray(group.members) || !Number.isInteger(group.revision)) throw new Error('Invalid collaboration record')
    const primary = group.members.find(member => member.id === group.primaryMemberId && member.role === 'primary')
    if (!primary) throw new Error('Invalid collaboration primary')
  }
  private enqueue<T>(groupId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(groupId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work)
    this.queues.set(groupId, next)
    void next.finally(() => { if (this.queues.get(groupId) === next) this.queues.delete(groupId) }).catch(() => undefined)
    return next
  }

  /**
   * The in-memory queue handles normal multi-session traffic. The lock closes
   * the remaining hole when two server processes deliberately share a
   * workspace directory (for example a desktop instance plus a headless
   * server). mkdir is atomic on the supported local filesystems.
   */
  private async withFileLock<T>(groupId: string, work: () => Promise<T>): Promise<T> {
    const workspaceId = this.groupWorkspaces.get(groupId)
    if (!workspaceId) throw new Error('Collaboration not found on this server')
    const lockPath = `${this.path(groupId, workspaceId)}.lock`
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        await mkdir(lockPath)
        break
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          const age = Date.now() - (await stat(lockPath)).mtimeMs
          if (age > LOCK_STALE_MS) {
            await rm(lockPath, { recursive: true, force: true })
            continue
          }
        } catch { /* lock was released between stat and check */ }
        if (Date.now() >= deadline) throw new Error('Timed out waiting for a concurrent collaboration update')
        await new Promise(resolve => setTimeout(resolve, 15 + Math.floor(Math.random() * 20)))
      }
    }
    try {
      return await work()
    } finally {
      await rm(lockPath, { recursive: true, force: true })
    }
  }
}
