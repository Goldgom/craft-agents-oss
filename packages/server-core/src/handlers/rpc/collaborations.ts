import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { RPC_CHANNELS, type CollaborationMember } from '@craft-agent/shared/protocol'
import { CollaborationManager } from '../../collaboration/CollaborationManager'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

const managers = new WeakMap<object, CollaborationManager>()

function managerFor(deps: HandlerDeps): CollaborationManager {
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

async function localActor(
  deps: HandlerDeps,
  group: Awaited<ReturnType<CollaborationManager['get']>>,
  actorMemberId: string,
): Promise<CollaborationMember> {
  const actor = group.members.find(member => member.id === actorMemberId)
  if (!actor) throw new Error('Session is not a collaboration member')
  // A client may not impersonate a remote member. Remote delivery is a
  // separate authenticated relay concern; this endpoint only accepts local
  // sessions that this server can resolve.
  if (actor.serverUrl) throw new Error('Remote collaboration members must use the relay endpoint')
  const session = await deps.sessionManager.getSession(actor.sessionId)
  if (!session || session.workspaceId !== actor.workspaceId) throw new Error('Local collaboration session is unavailable')
  return actor
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

async function deliverLocal(deps: HandlerDeps, member: CollaborationMember, message: string): Promise<'delivered' | 'queued' | 'relay-required'> {
  if (member.serverUrl) return 'relay-required'
  const target = await deps.sessionManager.getSession(member.sessionId)
  if (!target) throw new Error(`Target session ${member.sessionId} no longer exists`)
  const busy = target.isProcessing
  await deps.sessionManager.sendMessage(member.sessionId, message)
  return busy ? 'queued' : 'delivered'
}

export function registerCollaborationHandlers(server: RpcServer, deps: HandlerDeps): void {
  const manager = managerFor(deps)

  server.handle(RPC_CHANNELS.collaborations.CREATE, async (_ctx, primarySessionId: string, secondarySessions: Array<{ sessionId: string; workspaceId: string; serverUrl?: string; name?: string }>) => {
    const primary = await deps.sessionManager.getSession(text(primarySessionId, 'primarySessionId'))
    if (!primary) throw new Error('Primary session not found')
    if (!Array.isArray(secondarySessions) || !secondarySessions.length) throw new Error('At least one secondary session is required')
    const secondaries = await Promise.all(secondarySessions.map(async item => {
      const sessionId = text(item?.sessionId, 'secondary sessionId')
      const workspaceId = text(item?.workspaceId, 'secondary workspaceId')
      // Local sessions must exist. For cross-server members only an address is
      // persisted; bearer credentials remain in the configured relay/client.
      if (!item.serverUrl) {
        const session = await deps.sessionManager.getSession(sessionId)
        if (!session || session.workspaceId !== workspaceId) throw new Error(`Secondary session ${sessionId} not found in workspace ${workspaceId}`)
      }
      return { sessionId, workspaceId, serverUrl: item.serverUrl, name: item.name }
    }))
    const group = await manager.create({ sessionId: primary.id, workspaceId: primary.workspaceId, name: primary.name }, secondaries)
    pushTyped(server, RPC_CHANNELS.collaborations.EVENT, { to: 'workspace', workspaceId: primary.workspaceId }, { groupId: group.id, revision: group.revision })
    return group
  })

  server.handle(RPC_CHANNELS.collaborations.GET, async (_ctx, groupId: string, coordinatorWorkspaceId: string) => manager.open(text(groupId, 'groupId'), text(coordinatorWorkspaceId, 'coordinatorWorkspaceId')))
  server.handle(RPC_CHANNELS.collaborations.LIST, async (_ctx, workspaceId: string) => manager.list(text(workspaceId, 'workspaceId')))

  server.handle(RPC_CHANNELS.collaborations.REQUEST, async (_ctx, input: { groupId: string; coordinatorWorkspaceId: string; actorMemberId: string; targetMemberId: string; message: string; operationId: string; expectedRevision: number }) => {
    const group = await manager.open(text(input.groupId, 'groupId'), text(input.coordinatorWorkspaceId, 'coordinatorWorkspaceId'))
    const actor = await localActor(deps, group, text(input.actorMemberId, 'actorMemberId'))
    const result = await manager.request(group.id, actor.id, text(input.targetMemberId, 'targetMemberId'), text(input.message, 'message'), text(input.operationId, 'operationId'), input.expectedRevision)
    const target = result.group.members.find(member => member.id === input.targetMemberId)!
    const delivery = result.applied ? await deliverLocal(deps, target, `[Collaboration request ${group.id} from primary]\n\n${input.message.trim()}`) : 'queued'
    pushTyped(server, RPC_CHANNELS.collaborations.EVENT, { to: 'workspace', workspaceId: actor.workspaceId }, { groupId: group.id, revision: result.group.revision })
    return { ...result, delivery }
  })

  server.handle(RPC_CHANNELS.collaborations.REPORT, async (_ctx, input: { groupId: string; coordinatorWorkspaceId: string; actorMemberId: string; message: string; operationId: string; expectedRevision: number }) => {
    const group = await manager.open(text(input.groupId, 'groupId'), text(input.coordinatorWorkspaceId, 'coordinatorWorkspaceId'))
    const actor = await localActor(deps, group, text(input.actorMemberId, 'actorMemberId'))
    const result = await manager.report(group.id, actor.id, text(input.message, 'message'), text(input.operationId, 'operationId'), input.expectedRevision)
    const primary = result.group.members.find(member => member.id === result.group.primaryMemberId)!
    const delivery = result.applied ? await deliverLocal(deps, primary, `[Collaboration report ${group.id} from ${actor.name ?? actor.sessionId}]\n\n${input.message.trim()}`) : 'queued'
    pushTyped(server, RPC_CHANNELS.collaborations.EVENT, { to: 'workspace', workspaceId: primary.workspaceId }, { groupId: group.id, revision: result.group.revision })
    return { ...result, delivery }
  })

  server.handle(RPC_CHANNELS.collaborations.UPDATE_BOARD, async (_ctx, input: { groupId: string; coordinatorWorkspaceId: string; actorMemberId: string; itemId: string; value: unknown; operationId: string; expectedRevision: number }) => {
    const group = await manager.open(text(input.groupId, 'groupId'), text(input.coordinatorWorkspaceId, 'coordinatorWorkspaceId'))
    const actor = await localActor(deps, group, text(input.actorMemberId, 'actorMemberId'))
    const result = await manager.updateBoard(group.id, actor.id, text(input.itemId, 'itemId'), input.value, text(input.operationId, 'operationId'), input.expectedRevision)
    pushTyped(server, RPC_CHANNELS.collaborations.EVENT, { to: 'workspace', workspaceId: actor.workspaceId }, { groupId: group.id, revision: result.group.revision })
    return result
  })

  server.handle(RPC_CHANNELS.collaborations.PUT_FILE, async (_ctx, input: { groupId: string; coordinatorWorkspaceId: string; actorMemberId: string; name: string; dataBase64: string; contentType?: string; operationId: string; expectedRevision: number }) => {
    const group = await manager.open(text(input.groupId, 'groupId'), text(input.coordinatorWorkspaceId, 'coordinatorWorkspaceId'))
    const actor = await localActor(deps, group, text(input.actorMemberId, 'actorMemberId'))
    const result = await manager.putFile(group.id, actor.id, text(input.name, 'name'), text(input.dataBase64, 'dataBase64'), input.contentType, text(input.operationId, 'operationId'), input.expectedRevision)
    pushTyped(server, RPC_CHANNELS.collaborations.EVENT, { to: 'workspace', workspaceId: actor.workspaceId }, { groupId: group.id, revision: result.group.revision })
    return result
  })

  server.handle(RPC_CHANNELS.collaborations.GET_FILE, async (_ctx, groupId: string, coordinatorWorkspaceId: string, fileId: string) => {
    const group = await manager.open(text(groupId, 'groupId'), text(coordinatorWorkspaceId, 'coordinatorWorkspaceId'))
    return manager.getFile(group.id, text(fileId, 'fileId'))
  })
}
