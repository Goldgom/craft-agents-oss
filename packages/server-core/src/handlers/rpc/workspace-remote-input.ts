import type { RemoteServerConfig, Workspace } from '@craft-agent/core/types'

/** Renderer/network input can supply new bytes, never choose encrypted refs. */
export function validateRemoteWorkspaceInput(value: unknown, existing?: RemoteServerConfig): RemoteServerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['url', 'token', 'remoteWorkspaceId'].includes(key))) {
    throw new Error('Remote workspace input cannot select stored credential references')
  }
  const input = value as Record<string, unknown>
  if (typeof input.url !== 'string' || !input.url || input.url.length > 4096
    || typeof input.token !== 'string' || input.token.length > 1_048_576
    || typeof input.remoteWorkspaceId !== 'string' || !input.remoteWorkspaceId || input.remoteWorkspaceId.length > 256) {
    throw new Error('Invalid remote workspace configuration')
  }
  let url: URL
  try { url = new URL(input.url) } catch { throw new Error('Invalid remote workspace URL') }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid remote workspace URL')
  let sameEndpoint = false
  try { sameEndpoint = !!existing && new URL(existing.url).href === url.href } catch { /* Invalid legacy endpoint cannot retain a secret. */ }
  if (!input.token && existing && sameEndpoint) {
    // An unchanged blank write-only editor preserves its own stored snapshot.
    return { ...existing, remoteWorkspaceId: input.remoteWorkspaceId }
  }
  if (!input.token && existing && (existing.token || existing.tokenRef)) {
    throw new Error('Enter credentials when changing the remote server endpoint')
  }
  return { url: input.url, token: input.token, remoteWorkspaceId: input.remoteWorkspaceId }
}

/** Public workspace metadata never exports a token or a reusable vault ref. */
export function redactWorkspaceRemoteCredentials<T extends Pick<Workspace, 'remoteServer'>>(workspace: T): T {
  if (!workspace.remoteServer) return workspace
  const remote = workspace.remoteServer
  return { ...workspace, remoteServer: {
    url: remote.url, token: '', remoteWorkspaceId: remote.remoteWorkspaceId,
    ...(remote.profileId ? { profileId: remote.profileId } : {}),
    ...(remote.revision ? { revision: remote.revision } : {}),
  } }
}
