import { CollaborationRelayManager, type CollaborationRelayDependencies } from '../collaboration/CollaborationRelayManager';
import type { CollaborationIpcRegistrar } from './collaboration-remote';
import type { CollaborationRelayCreateInput, CollaborationRelayStatusLookup, CollaborationServerRef } from '@craft-agent/shared/protocol';
export const COLLABORATION_RELAY_IPC = {
    CONTEXT: '__collaboration:setupContext', WORKSPACES: '__collaboration:relayWorkspaces', CANDIDATES: '__collaboration:relayCandidates',
    CREATE: '__collaboration:createMultiServer', LIST: '__collaboration:listMultiServer', FILE: '__collaboration:getRelayFile', STATUS: '__collaboration:relayStatus', END: '__collaboration:endMultiServer',
} as const;
/** Register after app.whenReady; parent supplies the validated native binding and vault resolver. */
export function registerCollaborationRelayIpcHandlers(ipc: CollaborationIpcRegistrar, deps: CollaborationRelayDependencies): CollaborationRelayManager {
    const manager = new CollaborationRelayManager(deps);
    const safe = (fn: (...args: any[]) => Promise<unknown>) => async (...args: any[]) => { try {
        return await fn(...args);
    }
    catch {
        throw new Error('Collaboration setup failed. Reopen the dialog and check the selected server credentials, verified TLS, and protocol support.');
    } };
    ipc.handle(COLLABORATION_RELAY_IPC.CONTEXT, safe((event, id: string) => manager.setup(event, id)));
    ipc.handle(COLLABORATION_RELAY_IPC.WORKSPACES, safe((event, server: CollaborationServerRef) => manager.workspaces(event, server)));
    ipc.handle(COLLABORATION_RELAY_IPC.CANDIDATES, safe((event, server: CollaborationServerRef, workspaceId: string) => manager.candidates(event, server, workspaceId)));
    ipc.handle(COLLABORATION_RELAY_IPC.CREATE, safe((event, input: CollaborationRelayCreateInput) => manager.create(event, input)));
    ipc.handle(COLLABORATION_RELAY_IPC.STATUS, safe((event, lookup: CollaborationRelayStatusLookup) => manager.status(event, lookup)));
    ipc.handle(COLLABORATION_RELAY_IPC.LIST, safe(event => manager.list(event)));
    ipc.handle(COLLABORATION_RELAY_IPC.FILE, safe((event, lookup: CollaborationRelayStatusLookup, fileId: string) => manager.file(event, lookup, fileId)));
    ipc.handle(COLLABORATION_RELAY_IPC.END, safe((event, lookup: CollaborationRelayStatusLookup) => manager.end(event, lookup)));
    void manager.start().catch(() => { });
    return manager;
}
