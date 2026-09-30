import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerDeps } from '@craft-agent/server-core/handlers'
import type { HandlerFn, RequestContext, RpcServer } from '@craft-agent/server-core/transport'
import { registerCollaborationHandlers } from '@craft-agent/server-core/handlers/rpc/collaborations'
import type { CollaborationIpcRegistrar } from './collaboration-remote'
import type { NativeAuthorityEvent } from '../native-window-authority'

/** Native-only entry points for same-server, cross-workspace collaboration. */
export const LOCAL_COLLABORATION_IPC = {
  WORKSPACES: '__collaboration:localWorkspaces',
  CANDIDATES: '__collaboration:localCandidates',
  CREATE: '__collaboration:createLocal',
} as const

export function registerLocalCollaborationIpcHandlers(ipc: CollaborationIpcRegistrar, server: RpcServer, deps: HandlerDeps,
  assertSender: (event: NativeAuthorityEvent) => { workspaceId: string; bindingId: string }): void {
  const handlers = new Map<string, HandlerFn>()
  const nativeContexts = new WeakSet<RequestContext>()
  // Reuse the core implementation and its per-session-manager creation lock.
  // These handlers are private to this bridge, never registered on the network.
  const localServer: RpcServer = {
    handle: (channel, handler) => { handlers.set(channel, handler) },
    push: server.push.bind(server),
    invokeClient: server.invokeClient.bind(server),
    hasClientCapability: server.hasClientCapability.bind(server),
    findClientsWithCapability: server.findClientsWithCapability.bind(server),
  }
  registerCollaborationHandlers(localServer, deps, nativeContexts)
  for (const [ipcChannel, rpcChannel] of [
    [LOCAL_COLLABORATION_IPC.WORKSPACES, RPC_CHANNELS.collaborations.LIST_WORKSPACES],
    [LOCAL_COLLABORATION_IPC.CANDIDATES, RPC_CHANNELS.collaborations.LIST_CANDIDATES],
    [LOCAL_COLLABORATION_IPC.CREATE, RPC_CHANNELS.collaborations.CREATE],
  ]) {
    ipc.handle(ipcChannel!, async (event, ...args) => {
      let binding: ReturnType<typeof assertSender>
      try { binding = assertSender(event as NativeAuthorityEvent) }
      catch { throw new Error('A trusted local workspace window is required for local collaboration') }
      const { workspaceId } = binding
      if (!workspaceId || !deps.sessionManager.getWorkspaces().some(workspace => workspace.id === workspaceId && !workspace.remoteServer)) {
        throw new Error('A local workspace window is required for local collaboration')
      }
      const context: RequestContext = { clientId: `native-collaboration:${event.sender.id}`, webContentsId: event.sender.id, workspaceId }
      nativeContexts.add(context)
      try {
        const result = await handlers.get(rpcChannel!)!(context, ...args)
        if (ipcChannel !== LOCAL_COLLABORATION_IPC.CREATE && assertSender(event as NativeAuthorityEvent).bindingId !== binding.bindingId) {
          throw new Error('Application workspace changed. Reopen collaboration selection.')
        }
        return result
      } finally {
        nativeContexts.delete(context)
      }
    })
  }
}
