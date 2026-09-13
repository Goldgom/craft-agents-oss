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
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
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
export const MAX_COLLABORATION_FILE_BYTES = 8 * 1024 * 1024
const MAX_FILE_NAME_CHARS = 255
const MAX_CONTENT_TYPE_CHARS = 255
const MAX_MESSAGE_CHARS = 64 * 1024
const MAX_BOARD_VALUE_CHARS = 256 * 1024
const MAX_ITEM_ID_CHARS = 128
const MAX_BOARD_ITEMS = 256
const MAX_SHARED_FILES = 256
const MAX_UNRESOLVED_DELIVERIES = 1_000
const MAX_OPERATION_ID_CHARS = 256
const MAX_APPLIED_OPERATIONS = 10_000
const LOCK_STALE_MS = 2 * 60_000
const LOCK_WAIT_MS = 10_000
const DELIVERY_LEASE_MS = 30_000
const GROUP_ID_PATTERN = /^collab_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/i

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

  /** Release coordinator caches after all queued mutations have drained. */
  async cleanup(): Promise<void> {
    await Promise.allSettled(this.queues.values())
    this.queues.clear()
    this.groupWorkspaces.clear()
  }

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
      id: groupId, version: 1, revision: 0, status: 'active', primaryMemberId: 'primary', members,
      board: {}, files: {}, events: [], appliedOperations: {}, createdAt: now, updatedAt: now,
    }
    await this.write(group)
    try {
      await this.writeMemberIndexes(group)
    } catch (error) {
      await this.discard(group).catch(() => undefined)
      throw error
    }
    return group
  }

  async get(groupId: string): Promise<CollaborationGroup> {
    return this.read(groupId)
  }

  /** Rehydrate an opaque group id after a server restart. The coordinator
   * workspace is public metadata, not a credential; remote relays carry it
   * alongside the group id. */
  async open(groupId: string, coordinatorWorkspaceId: string): Promise<CollaborationGroup> {
    this.assertGroupId(groupId)
    this.groupWorkspaces.set(groupId, coordinatorWorkspaceId)
    return this.read(groupId)
  }

  async list(workspaceId: string): Promise<CollaborationGroup[]> {
    const dir = this.directory(workspaceId)
    const groups = new Map<string, CollaborationGroup>()
    try {
      const files = await readdir(dir)
      const settled = await Promise.allSettled(
        files
          .filter(name => GROUP_ID_PATTERN.test(name.slice(0, -'.json'.length)) && name.endsWith('.json'))
          .map(name => this.readByPath(join(dir, name))),
      )
      for (const result of settled) {
        if (result.status === 'fulfilled') groups.set(result.value.id, result.value)
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    try {
      const refs = await readdir(this.indexDirectory(workspaceId))
      const settled = await Promise.allSettled(refs.filter(name => name.endsWith('.json')).map(async name => {
        const ref = JSON.parse(await readFile(join(this.indexDirectory(workspaceId), name), 'utf8')) as {
          groupId?: unknown
          coordinatorWorkspaceId?: unknown
        }
        if (typeof ref.groupId !== 'string' || typeof ref.coordinatorWorkspaceId !== 'string') {
          throw new Error('Invalid collaboration index')
        }
        return this.open(ref.groupId, ref.coordinatorWorkspaceId)
      }))
      for (const result of settled) {
        if (result.status === 'fulfilled') groups.set(result.value.id, result.value)
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    return [...groups.values()]
      .filter(group => group.members.some(member => !member.serverUrl && member.workspaceId === workspaceId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Repair or migrate the per-workspace references used for discovery after
   * restart. Safe to call repeatedly because each index is atomically replaced. */
  async ensureMemberIndexes(group: CollaborationGroup): Promise<void> {
    this.assertGroup(group)
    await this.writeMemberIndexes(group)
  }

  /** Primary -> a selected secondary. The caller must be the primary member. */
  request(groupId: string, actorMemberId: string, targetMemberId: string, text: string, operationId: string, expectedRevision: number): Promise<CollaborationChangeResult> {
    this.assertMessage(text)
    return this.mutate(groupId, expectedRevision, operationId, group => {
      this.requireActive(group)
      this.requirePrimary(group, actorMemberId)
      const target = this.member(group, targetMemberId)
      if (target.role !== 'secondary') throw new CollaborationAuthorizationError('Requests can only target a secondary session')
      this.requireOutboxCapacity(group)
      return this.appendEvent(group, {
        operationId, type: 'request', fromMemberId: actorMemberId, toMemberId: targetMemberId, text,
        delivery: { status: 'pending', attempts: 0, updatedAt: Date.now() },
      })
    })
  }

  /** Secondary -> primary. Direct secondary-to-secondary and self-routing are rejected. */
  report(groupId: string, actorMemberId: string, text: string, operationId: string, expectedRevision: number): Promise<CollaborationChangeResult> {
    this.assertMessage(text)
    return this.mutate(groupId, expectedRevision, operationId, group => {
      this.requireActive(group)
      const actor = this.member(group, actorMemberId)
      if (actor.role !== 'secondary') throw new CollaborationAuthorizationError('Only a secondary session can report to the primary')
      this.requireOutboxCapacity(group)
      return this.appendEvent(group, {
        operationId, type: 'report', fromMemberId: actorMemberId, toMemberId: group.primaryMemberId, text,
        delivery: { status: 'pending', attempts: 0, updatedAt: Date.now() },
      })
    })
  }

  updateBoard(groupId: string, actorMemberId: string, itemId: string, value: unknown, operationId: string, expectedRevision: number): Promise<CollaborationChangeResult> {
    if (!itemId.trim() || itemId.length > MAX_ITEM_ID_CHARS) return Promise.reject(new Error(`Board item id must be between 1 and ${MAX_ITEM_ID_CHARS} characters`))
    if (itemId === '__proto__' || itemId === 'prototype' || itemId === 'constructor') return Promise.reject(new Error('Reserved board item id'))
    let encoded: string
    try {
      encoded = JSON.stringify(value)
    } catch {
      return Promise.reject(new Error('Board value must be JSON-compatible'))
    }
    if (encoded === undefined || encoded.length > MAX_BOARD_VALUE_CHARS) return Promise.reject(new Error(`Board value must be at most ${MAX_BOARD_VALUE_CHARS} JSON characters`))
    return this.mutate(groupId, expectedRevision, operationId, group => {
      this.requireActive(group)
      this.member(group, actorMemberId)
      if (!Object.prototype.hasOwnProperty.call(group.board, itemId)
        && Object.keys(group.board).length >= MAX_BOARD_ITEMS) {
        throw new Error(`A collaboration board supports at most ${MAX_BOARD_ITEMS} items`)
      }
      const revision = group.revision + 1
      const item: CollaborationBoardItem = { id: itemId, value, version: revision, updatedAt: Date.now(), updatedBy: actorMemberId }
      group.board[itemId] = item
      return this.appendEvent(group, {
        operationId,
        type: 'board',
        fromMemberId: actorMemberId,
        boardItemId: itemId,
        boardValue: value,
      })
    })
  }

  async putFile(groupId: string, actorMemberId: string, name: string, dataBase64: string, contentType: string | undefined, operationId: string, expectedRevision: number): Promise<CollaborationChangeResult> {
    if (dataBase64.length > Math.ceil(MAX_COLLABORATION_FILE_BYTES / 3) * 4 + 4) throw new Error(`Shared file must be at most ${MAX_COLLABORATION_FILE_BYTES} bytes`)
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) throw new Error('Shared file data must be valid base64')
    const data = Buffer.from(dataBase64, 'base64')
    if (!name.trim() || name.length > MAX_FILE_NAME_CHARS || name.includes('/') || name.includes('\\')) throw new Error(`Shared file name must be a plain file name of at most ${MAX_FILE_NAME_CHARS} characters`)
    if (contentType && contentType.length > MAX_CONTENT_TYPE_CHARS) throw new Error(`Shared file content type must be at most ${MAX_CONTENT_TYPE_CHARS} characters`)
    if (!data.length || data.length > MAX_COLLABORATION_FILE_BYTES) throw new Error(`Shared file must be between 1 byte and ${MAX_COLLABORATION_FILE_BYTES} bytes`)
    return this.mutate(groupId, expectedRevision, operationId, async group => {
      this.requireActive(group)
      this.member(group, actorMemberId)
      const id = this.safeFileId(name)
      if (!Object.prototype.hasOwnProperty.call(group.files, id)
        && Object.keys(group.files).length >= MAX_SHARED_FILES) {
        throw new Error(`A collaboration supports at most ${MAX_SHARED_FILES} shared files`)
      }
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

  end(groupId: string, actorMemberId: string, operationId: string, expectedRevision: number): Promise<CollaborationChangeResult> {
    return this.mutate(groupId, expectedRevision, operationId, group => {
      this.requireActive(group)
      this.requirePrimary(group, actorMemberId)
      group.status = 'ended'
      group.endedAt = Date.now()
      group.endedBy = actorMemberId
      return this.appendEvent(group, {
        operationId,
        type: 'lifecycle',
        fromMemberId: actorMemberId,
        text: 'Collaboration ended',
      })
    })
  }

  async claimDelivery(groupId: string, operationId: string): Promise<{
    group: CollaborationGroup
    event?: CollaborationEvent
    claimed: boolean
    status: NonNullable<CollaborationEvent['delivery']>['status']
    attempt?: number
  }> {
    return this.enqueue(groupId, () => this.withFileLock(groupId, async () => {
      const group = await this.read(groupId)
      this.requireActive(group)
      const event = group.events.find(candidate => candidate.operationId === operationId)
      if (!event || (event.type !== 'request' && event.type !== 'report')) {
        throw new Error('Collaboration delivery was not found in the retained event history')
      }
      const current = event.delivery
      if (current?.status === 'delivered' || current?.status === 'queued') {
        return { group, event, claimed: false, status: current.status, attempt: current.attempts }
      }
      if (current?.status === 'delivering' && Date.now() - current.updatedAt < DELIVERY_LEASE_MS) {
        return { group, event, claimed: false, status: 'delivering' as const, attempt: current.attempts }
      }
      event.delivery = {
        status: 'delivering',
        attempts: (current?.attempts ?? 0) + 1,
        updatedAt: Date.now(),
      }
      group.revision += 1
      group.updatedAt = Date.now()
      await this.write(group)
      return { group, event, claimed: true, status: 'delivering' as const, attempt: event.delivery.attempts }
    }))
  }

  async completeDelivery(
    groupId: string,
    operationId: string,
    expectedAttempt: number,
    status: 'delivered' | 'queued' | 'failed' | 'relay-required',
    lastError?: string,
  ): Promise<CollaborationGroup> {
    return this.enqueue(groupId, () => this.withFileLock(groupId, async () => {
      const group = await this.read(groupId)
      const event = group.events.find(candidate => candidate.operationId === operationId)
      if (!event || (event.type !== 'request' && event.type !== 'report')) return group
      // A lease may expire while a slow delivery is still in flight. Once a
      // newer worker has claimed the event, the older worker must not overwrite
      // its result (for example, changing a successful retry back to failed).
      if (event.delivery?.status !== 'delivering' || event.delivery.attempts !== expectedAttempt) return group
      event.delivery = {
        status,
        attempts: expectedAttempt,
        updatedAt: Date.now(),
        lastError: lastError?.slice(0, 2_000),
      }
      group.revision += 1
      group.updatedAt = Date.now()
      await this.write(group)
      return group
    }))
  }

  async discard(group: CollaborationGroup): Promise<void> {
    const primary = this.member(group, group.primaryMemberId)
    await Promise.allSettled([
      rm(this.path(group.id, primary.workspaceId), { force: true }),
      rm(join(this.directory(primary.workspaceId), group.id), { recursive: true, force: true }),
      ...group.members
        .filter(member => !member.serverUrl)
        .map(member => rm(this.indexPath(member.workspaceId, group.id), { force: true })),
    ])
    this.groupWorkspaces.delete(group.id)
  }

  private mutate(groupId: string, expectedRevision: number, operationId: string, apply: (group: CollaborationGroup) => CollaborationEvent | Promise<CollaborationEvent>): Promise<CollaborationChangeResult> {
    if (!operationId?.trim() || operationId.length > MAX_OPERATION_ID_CHARS) return Promise.reject(new Error(`operationId must be between 1 and ${MAX_OPERATION_ID_CHARS} characters`))
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) return Promise.reject(new Error('expectedRevision must be a non-negative integer'))
    return this.enqueue(groupId, () => this.withFileLock(groupId, async () => {
      const group = await this.read(groupId)
      const operationKey = this.operationKey(operationId)
      if (group.appliedOperations[operationKey] !== undefined) return { group, applied: false }
      if (group.revision !== expectedRevision) throw new CollaborationConflictError(group.revision)
      const event = await apply(group)
      group.revision += 1
      event.revision = group.revision
      group.appliedOperations[operationKey] = group.revision
      const operationKeys = Object.keys(group.appliedOperations)
      if (operationKeys.length > MAX_APPLIED_OPERATIONS) {
        for (const key of operationKeys.slice(0, operationKeys.length - MAX_APPLIED_OPERATIONS)) {
          delete group.appliedOperations[key]
        }
      }
      group.events.push(event)
      while (group.events.length > MAX_EVENT_HISTORY) {
        const removable = group.events.findIndex(candidate =>
          (candidate.type !== 'request' && candidate.type !== 'report')
          || candidate.delivery?.status === 'delivered'
          || candidate.delivery?.status === 'queued',
        )
        // Never discard an unresolved outbox item merely to enforce the
        // presentation-history cap. It must remain discoverable and retryable.
        if (removable < 0) break
        group.events.splice(removable, 1)
      }
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
  private requireActive(group: CollaborationGroup): void {
    if (group.status !== 'active') throw new CollaborationAuthorizationError('Collaboration has ended')
  }
  private requireOutboxCapacity(group: CollaborationGroup): void {
    const unresolved = group.events.filter(event =>
      (event.type === 'request' || event.type === 'report')
      && event.delivery?.status !== 'delivered'
      && event.delivery?.status !== 'queued',
    ).length
    if (unresolved >= MAX_UNRESOLVED_DELIVERIES) {
      throw new Error(`A collaboration supports at most ${MAX_UNRESOLVED_DELIVERIES} unresolved deliveries`)
    }
  }
  private assertMessage(value: string): void {
    if (!value.trim() || value.length > MAX_MESSAGE_CHARS) throw new Error(`Collaboration message must be between 1 and ${MAX_MESSAGE_CHARS} characters`)
  }
  private assertGroupId(groupId: string): void {
    if (!GROUP_ID_PATTERN.test(groupId)) throw new Error('Invalid collaboration group id')
  }
  private operationKey(operationId: string): string { return createHash('sha256').update(operationId).digest('hex') }
  private identity(member: Pick<CollaborationMember, 'sessionId' | 'workspaceId' | 'serverUrl'>): string { return `${member.serverUrl ?? 'local'}:${member.workspaceId}:${member.sessionId}` }
  private directory(workspaceId: string): string { return join(this.rootForWorkspace(workspaceId), '.craft-agent', 'collaborations') }
  private indexDirectory(workspaceId: string): string { return join(this.directory(workspaceId), 'index') }
  private indexPath(workspaceId: string, groupId: string): string { return join(this.indexDirectory(workspaceId), `${groupId}.json`) }
  private path(groupId: string, workspaceId: string): string {
    this.assertGroupId(groupId)
    return join(this.directory(workspaceId), `${groupId}.json`)
  }
  private filesDirectory(group: CollaborationGroup): string { return join(this.directory(group.members.find(member => member.id === group.primaryMemberId)!.workspaceId), group.id, 'files') }
  private safeFileId(name: string): string { return createHash('sha256').update(name).digest('hex') }
  private async read(groupId: string): Promise<CollaborationGroup> {
    this.assertGroupId(groupId)
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
  private async writeMemberIndexes(group: CollaborationGroup): Promise<void> {
    const coordinatorWorkspaceId = this.member(group, group.primaryMemberId).workspaceId
    const workspaceIds = new Set(group.members.filter(member => !member.serverUrl).map(member => member.workspaceId))
    await Promise.all([...workspaceIds].map(async workspaceId => {
      const dir = this.indexDirectory(workspaceId)
      await mkdir(dir, { recursive: true })
      const path = this.indexPath(workspaceId, group.id)
      const tmp = `${path}.${randomUUID()}.tmp`
      await writeFile(tmp, JSON.stringify({ groupId: group.id, coordinatorWorkspaceId }), 'utf8')
      await rename(tmp, path)
    }))
  }
  private assertGroup(group: CollaborationGroup): void {
    if (!group || group.version !== 1 || !group.id || !Array.isArray(group.members) || !Number.isInteger(group.revision)) throw new Error('Invalid collaboration record')
    this.assertGroupId(group.id)
    const primary = group.members.find(member => member.id === group.primaryMemberId && member.role === 'primary')
    if (!primary) throw new Error('Invalid collaboration primary')
    group.status ??= 'active'
    if (group.status !== 'active' && group.status !== 'ended') throw new Error('Invalid collaboration status')
    if (!group.board || typeof group.board !== 'object' || !group.files || typeof group.files !== 'object' || !Array.isArray(group.events)) {
      throw new Error('Invalid collaboration state')
    }
    for (const [id, file] of Object.entries(group.files)) {
      if (!file || id !== file.id || !SHA256_PATTERN.test(id)) throw new Error('Invalid collaboration file metadata')
    }
    group.appliedOperations ??= Object.fromEntries(
      (group.events ?? []).map(event => [this.operationKey(event.operationId), event.revision]),
    )
    if (typeof group.appliedOperations !== 'object') throw new Error('Invalid collaboration operation history')
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
