import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { COLLABORATION_RELAY_CAPABILITY, COLLABORATION_RELAY_RPC as C, type CollaborationRelayScope } from '@craft-agent/shared/protocol';
import type { HandlerDeps } from '../handler-deps';
import type { RequestContext, RpcServer } from '../../transport';
import { RelayParticipantManager } from '../../collaboration/RelayParticipantManager';
const managers = new WeakMap<object, RelayParticipantManager>();
function managerFor(deps: HandlerDeps) {
    const owned = deps.sessionManager.getCollaborationRelayManager?.();
    if (owned)
        return owned;
    let manager = managers.get(deps.sessionManager);
    if (!manager) {
        manager = new RelayParticipantManager({ sessions: deps.sessionManager, workspaceRoot: id => { const workspace = getWorkspaceByNameOrId(id); if (!workspace || workspace.remoteServer)
                throw new Error('Relay workspace unavailable'); return workspace.rootPath; } });
        managers.set(deps.sessionManager, manager);
    }
    return manager;
}
function bearer(ctx: RequestContext) { if (ctx.authenticatedBy !== 'bearer')
    throw new Error('Collaboration relay requires verified bearer authentication'); }
function workspace(ctx: RequestContext) { bearer(ctx); if (!ctx.workspaceId)
    throw new Error('Collaboration relay requires a workspace'); return ctx.workspaceId; }
function scope(input: unknown): CollaborationRelayScope {
    if (!input || typeof input !== 'object')
        throw new Error('Invalid relay scope');
    const data = input as Record<string, unknown>;
    if (typeof data.groupId !== 'string' || typeof data.epoch !== 'string' || typeof data.ownerId !== 'string')
        throw new Error('Invalid relay scope');
    return { groupId: data.groupId, epoch: data.epoch, ownerId: data.ownerId };
}
export function registerCollaborationRelayHandlers(server: RpcServer, deps: HandlerDeps): void {
    let cached: RelayParticipantManager | undefined;
    const manager = () => cached ??= managerFor(deps);
    const handle = (channel: string, fn: (ctx: RequestContext, input: any) => Promise<unknown>) => server.handle(channel, async (ctx, input) => {
        try {
            return await fn(ctx, input);
        }
        catch {
            throw new Error('Collaboration relay request rejected. Check authentication, membership, protocol compatibility, and connection ownership.');
        }
    });
    handle(C.INFO, async (ctx) => { bearer(ctx); return manager().info(); });
    handle(C.PREPARE, async (ctx, input) => manager().prepare(workspace(ctx), input));
    handle(C.BIND, async (ctx, input) => {
        const ws = workspace(ctx), s = scope(input);
        if (!server.hasClientCapability(ctx.clientId, COLLABORATION_RELAY_CAPABILITY))
            throw new Error('Relay callback capability missing');
        await manager().bind(ws, s, ctx.clientId, request => server.invokeClient(ctx.clientId, COLLABORATION_RELAY_CAPABILITY, request), () => server.hasClientCapability(ctx.clientId, COLLABORATION_RELAY_CAPABILITY));
        return { bound: true };
    });
    const bound = (ctx: RequestContext, input: unknown) => { const ws = workspace(ctx), s = scope(input); manager().requireBinding(ws, s, ctx.clientId); return { ws, s }; };
    handle(C.COMMIT, async (ctx, input) => { const { ws, s } = bound(ctx, input); return manager().commit(ws, s, input.group); });
    handle(C.ABORT, async (ctx, input) => { const ws = workspace(ctx), s = scope(input); const result = await manager().abort(ws, s); return { aborted: true, ...result }; });
    handle(C.GROUP, async (ctx, input) => { const { ws, s } = bound(ctx, input); if (input.action === 'activate')
        return manager().activate(ws, s); if (input.action === 'read' || input.action === 'file')
        return manager().readGroup(ws, s, input.action === 'file' ? input.fileId : undefined); throw new Error('Unsupported relay group operation'); });
    handle(C.APPLY, async (ctx, input) => { const { ws } = bound(ctx, input); return manager().apply(ws, input); });
    handle(C.ACCEPT, async (ctx, input) => { const { ws } = bound(ctx, input); return manager().accept(ws, input); });
    handle(C.PENDING, async (ctx, input) => { const { ws, s } = bound(ctx, input); return manager().pending(ws, s); });
    handle(C.ACK, async (ctx, input) => { const { ws, s } = bound(ctx, input); if (!['operation', 'delivery', 'retireOperations', 'retireDeliveries'].includes(input.kind))
        throw new Error('Unsupported relay acknowledgment'); await manager().acknowledge(ws, s, input); return { acknowledged: true }; });
    handle(C.END, async (ctx, input) => { const ws = workspace(ctx), s = scope(input); await manager().end(ws, s); return { ended: true }; });
}
