import type { RemoteServerConfig } from '@craft-agent/core/types'
import type { NativeAuthorityEvent } from '../native-window-authority'
import type { RelayResolvedServer, RelayWindowBinding } from './CollaborationRelayManager'

/** Derive primary location from native state, never from dialog form fields. */
export async function resolveNativeCollaborationBinding(event: unknown, deps: {
  assertSender(event: NativeAuthorityEvent): { webContentsId: number; workspaceId: string; bindingId: string }
  getWorkspace(id: string): { id: string; name: string; remoteServer?: RemoteServerConfig } | null | undefined
  startupProfileId?: string
  resolveProfile(id: string): Promise<(RelayResolvedServer & { profileId: string }) | undefined>
  resolveWorkspace(config: RemoteServerConfig): Promise<RemoteServerConfig>
}): Promise<RelayWindowBinding> {
  const native = deps.assertSender(event as NativeAuthorityEvent)
  if (!native.workspaceId) throw new Error('Choose a workspace before configuring collaboration')
  const workspace = deps.getWorkspace(native.workspaceId)
  const remote = workspace?.remoteServer
  const profileId = deps.startupProfileId ?? remote?.profileId
  if (!deps.startupProfileId && !workspace) throw new Error('Workspace is not registered')
  if (remote && !profileId) throw new Error('Open this remote workspace from a saved server profile before configuring collaboration')
  if (!profileId) return {
    senderId: native.webContentsId, generation: native.bindingId,
    server: { kind: 'local' }, serverWorkspaceId: native.workspaceId,
    serverName: 'Local', workspaceName: workspace!.name,
  }
  const profile = await deps.resolveProfile(profileId)
  if (!profile) throw new Error('Saved server profile is unavailable')
  if (remote && !deps.startupProfileId) {
    const resolved = await deps.resolveWorkspace(remote)
    if (profile.url !== resolved.url || profile.token !== resolved.token) {
      throw new Error('Saved server connection changed. Reopen the workspace from its profile.')
    }
    if (JSON.stringify(deps.getWorkspace(native.workspaceId)?.remoteServer) !== JSON.stringify(remote)) {
      throw new Error('Workspace connection changed. Reopen the collaboration dialog.')
    }
  }
  if (deps.assertSender(event as NativeAuthorityEvent).bindingId !== native.bindingId) throw new Error('Application workspace changed. Retry.')
  return {
    senderId: native.webContentsId, generation: `${native.bindingId}:${profile.revision}`,
    server: { kind: 'saved', profileId },
    serverWorkspaceId: deps.startupProfileId ? native.workspaceId : remote!.remoteWorkspaceId,
    serverName: profile.name, workspaceName: workspace?.name ?? native.workspaceId,
  }
}
