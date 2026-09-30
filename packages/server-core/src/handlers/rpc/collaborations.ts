import { randomUUID } from 'node:crypto'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import {
  RPC_CHANNELS,
  type CollaborationCreateResult,
  type CollaborationEvent,
  type CollaborationGroup,
  type CollaborationMember,
  type CollaborationSessionSelection,
} from '@craft-agent/shared/protocol'
import { CollaborationManager } from '../../collaboration/CollaborationManager'
import { pushTyped, type RequestContext, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

const managers = new WeakMap<object, CollaborationManager>()
const creationQueues = new WeakMap<object, Promise<unknown>>()

async function withCreationLock<T>(owner: object, work: () => Promise<T>): Promise<T> {
  const previous = creationQueues.get(owner) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(work)
  creationQueues.set(owner, next)
  try {
    return await next
  } finally {
    if (creationQueues.get(owner) === next) creationQueues.delete(owner)
  }
}

function managerFor(deps: HandlerDeps): CollaborationManager {
  const owned = deps.sessionManager.getCollaborationManager?.()
  if (owned) return owned
  let manager = managers.get(deps.sessionManager)
  if (!manager) {
    manager = new CollaborationManager(workspaceId => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`Workspace ${workspaceId} not found`)
      return workspace.rootPath
    })
    managers.set(deps.sessionManager, manager)
  }
  return manager
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function requireWorkspace(ctx: RequestContext, workspaceId: string): void {
  if (!ctx.workspaceId || ctx.workspaceId !== workspaceId) {
    throw new Error('Collaboration access is limited to the connected workspace')
  }
}

function isTrustedDesktopContext(deps: HandlerDeps, ctx: RequestContext, nativeContexts?: WeakSet<RequestContext>): boolean {
  // WS handshake window IDs are caller-supplied. Only native Electron IPC can
  // add an actual context object to this in-process capability set.
  return nativeContexts?.has(ctx) === true && ctx.webContentsId != null
    && ctx.workspaceId != null
    && deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId) === ctx.workspaceId
}

function requireGroupReader(ctx: RequestContext, group: CollaborationGroup): CollaborationMember {
  const member = group.members.find(candidate =>
    !candidate.serverUrl && candidate.workspaceId === ctx.workspaceId,
  )
  if (!member) throw new Error('Connected workspace is not a member of this collaboration')
  return member
}

async function localActor(
  deps: HandlerDeps,
  ctx: RequestContext,
  group: CollaborationGroup,
  actorMemberId: string,
): Promise<CollaborationMember> {
  const actor = group.members.find(member => member.id === actorMemberId)
  if (!actor) throw new Error('Session is not a collaboration member')
  if (actor.serverUrl) throw new Error('Remote collaboration members require an authenticated relay')
  requireWorkspace(ctx, actor.workspaceId)
  const session = await deps.sessionManager.getSession(actor.sessionId)
  const membership = session?.collaboration
  if (!session || session.workspaceId !== actor.workspaceId) throw new Error('Local collaboration session is unavailable')
  if (!membership
    || membership.groupId !== group.id
    || membership.memberId !== actor.id
    || membership.role !== actor.role) {
    throw new Error('Session collaboration membership is stale or invalid')
  }
  return actor
}

function broadcastGroup(server: RpcServer, group: CollaborationGroup): void {
  const workspaceIds = new Set(
    group.members.filter(member => !member.serverUrl).map(member => member.workspaceId),
  )
  for (const workspaceId of workspaceIds) {
    pushTyped(
      server,
      RPC_CHANNELS.collaborations.EVENT,
      { to: 'workspace', workspaceId },
      { groupId: group.id, revision: group.revision },
    )
  }
}

function deliveryMessage(group: CollaborationGroup, event: CollaborationEvent): {
  target: CollaborationMember
  message: string
} {
  if ((event.type !== 'request' && event.type !== 'report') || !event.toMemberId || !event.text) {
    throw new Error('Collaboration event is not deliverable')
  }
  const source = group.members.find(member => member.id === event.fromMemberId)
  const target = group.members.find(member => member.id === event.toMemberId)
  if (!source || !target) throw new Error('Collaboration delivery member is missing')
  const heading = event.type === 'request'
    ? `[Collaboration request ${group.id} from primary]`
    : `[Collaboration report ${group.id} from ${source.name ?? source.sessionId}]`
  return { target, message: `${heading}\n\n${event.text}` }
}

async function attemptDelivery(
  server: RpcServer,
  deps: HandlerDeps,
  manager: CollaborationManager,
  groupId: string,
  operationId: string,
): Promise<{ group: CollaborationGroup; delivery: 'delivered' | 'queued' | 'relay-required' | 'delivering' }> {
  const claimed = await manager.claimDelivery(groupId, operationId)
  if (!claimed.claimed) {
    const status = claimed.status === 'failed' || claimed.status === 'pending'
      ? 'delivering'
      : claimed.status
    return { group: claimed.group, delivery: status }
  }

  try {
    const { target, message } = deliveryMessage(claimed.group, claimed.event!)
    if (target.serverUrl) {
      const group = await manager.completeDelivery(groupId, operationId, claimed.attempt!, 'relay-required', 'Authenticated cross-server relay is not configured')
      broadcastGroup(server, group)
      return { group, delivery: 'relay-required' }
    }
    const session = await deps.sessionManager.getSession(target.sessionId)
    if (!session || session.workspaceId !== target.workspaceId) {
      throw new Error(`Target session ${target.sessionId} is unavailable`)
    }
    const busy = session.isProcessing === true
    await deps.sessionManager.sendMessage(
      target.sessionId,
      message,
      undefined,
      undefined,
      { collaborationDispatch: true },
    )
    const delivery = busy ? 'queued' : 'delivered'
    const group = await manager.completeDelivery(groupId, operationId, claimed.attempt!, delivery)
    broadcastGroup(server, group)
    return { group, delivery }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const group = await manager.completeDelivery(groupId, operationId, claimed.attempt!, 'failed', message)
    broadcastGroup(server, group)
    throw error
  }
}

export function registerCollaborationHandlers(server: RpcServer, deps: HandlerDeps, nativeContexts?: WeakSet<RequestContext>): void {
  const manager = managerFor(deps)

  server.handle(RPC_CHANNELS.collaborations.CREATE, async (ctx, primarySessionId: string, secondarySessions: CollaborationSessionSelection[]) => {
    return withCreationLock(deps.sessionManager, async () => {
      const primary = await deps.sessionManager.getSession(text(primarySessionId, 'primarySessionId'))
      if (!primary) throw new Error('Primary session not found')
      requireWorkspace(ctx, primary.workspaceId)
      if (primary.isArchived || primary.hidden) throw new Error('Primary session is unavailable for collaboration')
      if (primary.collaboration) throw new Error('Primary session already belongs to a collaboration')
      if (!deps.sessionManager.setSessionCollaboration) throw new Error('Session collaboration is unavailable')
      if (!Array.isArray(secondarySessions) || !secondarySessions.length) throw new Error('At least one secondary session is required')
      if (secondarySessions.length > 32) throw new Error('A collaboration supports at most 32 secondary sessions')
      const canUseOtherLocalWorkspaces = isTrustedDesktopContext(deps, ctx, nativeContexts)
      const workspaceIds = new Set(deps.sessionManager.getWorkspaces()
        .filter(workspace => !workspace.remoteServer).map(workspace => workspace.id))
      const identities = new Set([JSON.stringify([primary.workspaceId, primary.id])])
      // Validate every selection before any createSession side effects. In
      // particular, a malicious final entry must not leave earlier new chats.
      const selections = await Promise.all(secondarySessions.map(async item => {
        if (item?.serverUrl) throw new Error('Cross-server collaboration is unavailable until an authenticated relay is configured')
        const workspaceId = text(item?.workspaceId, 'secondary workspaceId')
        if (workspaceId !== primary.workspaceId && !canUseOtherLocalWorkspaces) {
          throw new Error('Cross-workspace collaboration requires a trusted local desktop client')
        }
        if (!workspaceIds.has(workspaceId)) throw new Error(`Workspace ${workspaceId} is not hosted on this server`)
        if (item.name !== undefined && (typeof item.name !== 'string' || item.name.trim().length > 200)) {
          throw new Error('Session name must be at most 200 characters')
        }
        const name = item.name?.trim() || undefined
        if (item.createNew === true) {
          if (item.sessionId !== undefined) throw new Error('Choose an existing session or a new session, not both')
          return { workspaceId, name, createNew: true as const }
        }
        if (item.createNew !== undefined && item.createNew !== false) throw new Error('Invalid new session selection')
        const sessionId = text(item?.sessionId, 'secondary sessionId')
        const identity = JSON.stringify([workspaceId, sessionId])
        if (identities.has(identity)) throw new Error('A session can only appear once in a collaboration')
        identities.add(identity)
        const session = await deps.sessionManager.getSession(sessionId)
        if (!session || session.workspaceId !== workspaceId) throw new Error(`Secondary session ${sessionId} not found in workspace ${workspaceId}`)
        if (session.isArchived || session.hidden) throw new Error(`Secondary session ${sessionId} is unavailable for collaboration`)
        if (session.collaboration) throw new Error(`Secondary session ${sessionId} already belongs to a collaboration`)
        return { sessionId, workspaceId, name: name ?? session.name, createNew: false as const }
      }))

      const createdSessionIds: string[] = []
      const updatedSessionIds: string[] = []
      let group: CollaborationGroup | undefined
      try {
        const secondaries: Array<{ sessionId: string; workspaceId: string; name?: string }> = []
        for (const selection of selections) {
          if (selection.createNew) {
            // Fresh collaborators use their workspace's normal defaults. Never
            // copy the primary's private history, credentials or access grants.
            const session = await deps.sessionManager.createSession(selection.workspaceId, { name: selection.name })
            createdSessionIds.push(session.id)
            secondaries.push({ sessionId: session.id, workspaceId: session.workspaceId, name: session.name })
          } else {
            secondaries.push({ sessionId: selection.sessionId, workspaceId: selection.workspaceId, name: selection.name })
          }
        }
        group = await manager.create(
          { sessionId: primary.id, workspaceId: primary.workspaceId, name: primary.name },
          secondaries,
        )
        const latestUserMessage = [...primary.messages]
          .reverse()
          .find(message => message.role === 'user' && !message.hidden && message.content.trim())
        if (latestUserMessage) {
          const seeded = await manager.updateBoard(group.id, group.primaryMemberId, 'goal.current', {
            kind: 'goal',
            text: latestUserMessage.content.trim(),
            status: 'active',
            requestedAt: latestUserMessage.timestamp,
            requestedBySessionId: primary.id,
          }, randomUUID(), group.revision)
          group = seeded.group
        }
        for (const member of group.members) {
          // Track before persistence so a failed flush also rolls back the
          // in-memory membership on the session that threw.
          updatedSessionIds.push(member.sessionId)
          await deps.sessionManager.setSessionCollaboration(member.sessionId, {
            groupId: group.id,
            memberId: member.id,
            role: member.role,
            coordinatorWorkspaceId: primary.workspaceId,
          })
        }
      } catch (error) {
        const rollback = await Promise.allSettled(updatedSessionIds.map(async sessionId => {
          const session = await deps.sessionManager.getSession(sessionId)
          if (session?.collaboration?.groupId === group?.id) await deps.sessionManager.setSessionCollaboration!(sessionId, null)
        }))
        if (group) rollback.push(...await Promise.allSettled([manager.discard(group)]))
        // Only delete sessions created by this attempt, never existing chats.
        rollback.push(...await Promise.allSettled(createdSessionIds.map(sessionId => deps.sessionManager.deleteSession(sessionId))))
        for (const result of rollback) {
          if (result.status === 'rejected') deps.platform.logger?.warn?.('Collaboration creation cleanup failed', result.reason)
        }
        throw error
      }

      broadcastGroup(server, group)
      let activationStatus: CollaborationCreateResult['activationStatus'] = 'started'
      try {
        await deps.sessionManager.sendMessage(
          primary.id,
          `[Collaboration started ${group.id}]\n\nRead collaboration_board with action=get to inspect members and goal.current. If no goal is recorded, ask the user for it before dispatching work. Assign bounded tasks with explicit deliverables and verification to the secondary session IDs, then integrate their reports.`,
          undefined,
          undefined,
          { hidden: true, collaborationDispatch: true },
        )
      } catch {
        activationStatus = 'failed'
        // Provider errors can echo credentials. Keep a useful correlation
        // point without logging the raw error, stack, or cause.
        deps.platform.logger?.warn?.('Collaboration created but the primary activation message could not be delivered', {
          groupId: group.id,
          primarySessionId: primary.id,
        })
      }
      // The group is already durable. Report activation failure separately so
      // clients can recover the primary without attempting duplicate creation.
      return { ...group, activationStatus } satisfies CollaborationCreateResult
    })
  })

  server.handle(RPC_CHANNELS.collaborations.GET, async (ctx, groupId: string, coordinatorWorkspaceId: string) => {
    const group = await manager.open(text(groupId, 'groupId'), text(coordinatorWorkspaceId, 'coordinatorWorkspaceId'))
    requireGroupReader(ctx, group)
    return group
  })

  server.handle(RPC_CHANNELS.collaborations.LIST, async (ctx, workspaceId: string) => {
    const requestedWorkspaceId = text(workspaceId, 'workspaceId')
    requireWorkspace(ctx, requestedWorkspaceId)
    const groups = new Map((await manager.list(requestedWorkspaceId)).map(group => [group.id, group]))
    // Migration fallback for groups created before per-workspace indexes were
    // introduced. Session metadata already carries the coordinator address.
    const sessions = await deps.sessionManager.getSessions()
    const refs = sessions
      .filter(session => session.workspaceId === requestedWorkspaceId && session.collaboration)
      .map(session => session.collaboration!)
    const opened = await Promise.allSettled(refs.map(ref =>
      manager.open(ref.groupId, ref.coordinatorWorkspaceId),
    ))
    for (const result of opened) {
      if (result.status === 'fulfilled'
        && result.value.members.some(member => !member.serverUrl && member.workspaceId === requestedWorkspaceId)) {
        groups.set(result.value.id, result.value)
        try {
          await manager.ensureMemberIndexes(result.value)
        } catch (error) {
          deps.platform.logger?.warn?.('Failed to migrate collaboration workspace indexes', error)
        }
      }
    }
    return [...groups.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  })

  // Only a native IPC context, bound to its actual Electron sender, may
  // enumerate other local workspaces. All WebSocket clients, even ones claiming
  // a desktop window ID, stay inside their authenticated workspace boundary.
  server.handle(RPC_CHANNELS.collaborations.LIST_WORKSPACES, async (ctx) => {
    if (!ctx.workspaceId) throw new Error('A connected workspace is required')
    const trusted = isTrustedDesktopContext(deps, ctx, nativeContexts)
    return deps.sessionManager.getWorkspaces()
      .filter(workspace => !workspace.remoteServer && (trusted || workspace.id === ctx.workspaceId))
      .map(workspace => ({ id: workspace.id, name: workspace.name }))
  })

  server.handle(RPC_CHANNELS.collaborations.LIST_CANDIDATES, async (ctx) => {
    if (!ctx.workspaceId) throw new Error('A connected workspace is required')
    return deps.sessionManager.getSessions(isTrustedDesktopContext(deps, ctx, nativeContexts) ? undefined : ctx.workspaceId)
  })

  server.handle(RPC_CHANNELS.collaborations.REQUEST, async (ctx, input: { groupId: string; coordinatorWorkspaceId: string; actorMemberId: string; targetMemberId: string; message: string; operationId: string; expectedRevision: number }) => {
    const group = await manager.open(text(input.groupId, 'groupId'), text(input.coordinatorWorkspaceId, 'coordinatorWorkspaceId'))
    const actor = await localActor(deps, ctx, group, text(input.actorMemberId, 'actorMemberId'))
    const result = await manager.request(group.id, actor.id, text(input.targetMemberId, 'targetMemberId'), text(input.message, 'message'), text(input.operationId, 'operationId'), input.expectedRevision)
    const delivery = await attemptDelivery(server, deps, manager, group.id, input.operationId)
    return { group: delivery.group, applied: result.applied, delivery: delivery.delivery }
  })

  server.handle(RPC_CHANNELS.collaborations.REPORT, async (ctx, input: { groupId: string; coordinatorWorkspaceId: string; actorMemberId: string; message: string; operationId: string; expectedRevision: number }) => {
    const group = await manager.open(text(input.groupId, 'groupId'), text(input.coordinatorWorkspaceId, 'coordinatorWorkspaceId'))
    const actor = await localActor(deps, ctx, group, text(input.actorMemberId, 'actorMemberId'))
    const result = await manager.report(group.id, actor.id, text(input.message, 'message'), text(input.operationId, 'operationId'), input.expectedRevision)
    const delivery = await attemptDelivery(server, deps, manager, group.id, input.operationId)
    return { group: delivery.group, applied: result.applied, delivery: delivery.delivery }
  })

  server.handle(RPC_CHANNELS.collaborations.UPDATE_BOARD, async (ctx, input: { groupId: string; coordinatorWorkspaceId: string; actorMemberId: string; itemId: string; value: unknown; operationId: string; expectedRevision: number }) => {
    const group = await manager.open(text(input.groupId, 'groupId'), text(input.coordinatorWorkspaceId, 'coordinatorWorkspaceId'))
    const actor = await localActor(deps, ctx, group, text(input.actorMemberId, 'actorMemberId'))
    const result = await manager.updateBoard(group.id, actor.id, text(input.itemId, 'itemId'), input.value, text(input.operationId, 'operationId'), input.expectedRevision)
    broadcastGroup(server, result.group)
    return result
  })

  server.handle(RPC_CHANNELS.collaborations.PUT_FILE, async (ctx, input: { groupId: string; coordinatorWorkspaceId: string; actorMemberId: string; name: string; dataBase64: string; contentType?: string; operationId: string; expectedRevision: number }) => {
    const group = await manager.open(text(input.groupId, 'groupId'), text(input.coordinatorWorkspaceId, 'coordinatorWorkspaceId'))
    const actor = await localActor(deps, ctx, group, text(input.actorMemberId, 'actorMemberId'))
    const result = await manager.putFile(group.id, actor.id, text(input.name, 'name'), text(input.dataBase64, 'dataBase64'), input.contentType, text(input.operationId, 'operationId'), input.expectedRevision)
    broadcastGroup(server, result.group)
    return result
  })

  server.handle(RPC_CHANNELS.collaborations.GET_FILE, async (ctx, groupId: string, coordinatorWorkspaceId: string, fileId: string) => {
    const group = await manager.open(text(groupId, 'groupId'), text(coordinatorWorkspaceId, 'coordinatorWorkspaceId'))
    requireGroupReader(ctx, group)
    return manager.getFile(group.id, text(fileId, 'fileId'))
  })

  server.handle(RPC_CHANNELS.collaborations.RETRY_DELIVERY, async (ctx, groupId: string, coordinatorWorkspaceId: string, operationId: string) => {
    const group = await manager.open(text(groupId, 'groupId'), text(coordinatorWorkspaceId, 'coordinatorWorkspaceId'))
    requireGroupReader(ctx, group)
    return attemptDelivery(server, deps, manager, group.id, text(operationId, 'operationId'))
  })

  server.handle(RPC_CHANNELS.collaborations.END, async (ctx, groupId: string, coordinatorWorkspaceId: string) => {
    const group = await manager.open(text(groupId, 'groupId'), text(coordinatorWorkspaceId, 'coordinatorWorkspaceId'))
    const primary = group.members.find(member => member.id === group.primaryMemberId)!
    requireWorkspace(ctx, primary.workspaceId)
    await localActor(deps, ctx, group, primary.id)
    const result = await manager.end(group.id, primary.id, randomUUID(), group.revision)
    const cleared = await Promise.allSettled(result.group.members.filter(member => !member.serverUrl).map(async member => {
      const session = await deps.sessionManager.getSession(member.sessionId)
      if (session?.collaboration?.groupId === result.group.id) {
        await deps.sessionManager.setSessionCollaboration?.(member.sessionId, null)
      }
    }))
    for (const entry of cleared) {
      if (entry.status === 'rejected') deps.platform.logger?.warn?.('Failed to clear ended collaboration metadata', entry.reason)
    }
    broadcastGroup(server, result.group)
    return result.group
  })
}
