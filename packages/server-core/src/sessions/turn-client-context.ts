import type { RpcServer } from '../transport/types';
import { CLIENT_REMOTE_ACCESS, CLIENT_REQUEST_FILES } from '../transport/capabilities';

export interface TurnClientContext { callerClientId?: string; remoteAccess?: boolean }

/** Retains remote locality after disconnect. Queued callers cannot replace an active turn's client. */
export class TurnClientContexts {
  private contexts = new Map<string, TurnClientContext>();
  capture(server: RpcServer | null, context?: TurnClientContext): TurnClientContext | undefined {
    if (!context?.callerClientId) return undefined;
    return { ...context, remoteAccess: context.remoteAccess ?? server?.hasClientCapability(context.callerClientId, CLIENT_REMOTE_ACCESS) ?? false };
  }
  bind(sessionId: string, context?: TurnClientContext) { if (context) this.contexts.set(sessionId, context); }
  get(sessionId: string) { return this.contexts.get(sessionId); }
  delete(sessionId: string) { this.contexts.delete(sessionId); }
  clear() { this.contexts.clear(); }
  requireClient(server: RpcServer | null, sessionId: string, workspaceId: string, capability: string): string {
    const id = this.get(sessionId)?.callerClientId;
    if (!id || !server?.findClientsWithCapability(capability, { workspaceId }).includes(id)) {
      throw new Error('The device that initiated this turn is disconnected or does not support this action. Ask the user to reconnect or attach files.');
    }
    return id;
  }
  reminder(server: RpcServer | null, sessionId: string): string {
    const context = this.get(sessionId);
    if (!context) return '';
    if (!context.remoteAccess) return '\n\n<system-reminder>Current connection mode: local. The session runs on the user host.</system-reminder>';
    const canRequest = context.callerClientId && server?.hasClientCapability(context.callerClientId, CLIENT_REQUEST_FILES);
    return '\n\n<system-reminder>Current connection mode: REMOTE ACCESS. The AI and ordinary filesystem/shell tools run on the session host. The user is accessing it from a separate client device; client paths and host paths are different environments. '
      + (canRequest ? 'To obtain files from the accessing device, call request_client_files with a clear reason. The current user chooses files; only selected files are uploaded. Use the returned saved host paths. Cancellation must be respected. ' : 'This accessing device cannot currently provide files; ask the user to reconnect or attach them. ')
      + 'localbash requires shell support on this same accessing device; never assume it runs there or substitute another device after disconnect.</system-reminder>';
  }
}
