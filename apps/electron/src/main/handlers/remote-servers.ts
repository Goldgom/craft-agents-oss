/**
 * Remote server management (远程服务器管理).
 *
 * GUI-only handlers (run on the local embedded server) that manage the
 * client's registry of remote TokenBird servers:
 *   - profile CRUD (URL + token + display name, stored locally)
 *   - connection testing
 *   - listing remote workspaces and creating workspaces ON the remote server
 *   - opening an independent window instance bound to a remote workspace
 *
 * Remote data stays on the remote server — only connection metadata is local.
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import {
  loadRemoteServerProfiles,
  getRemoteServerProfile,
  deleteRemoteServerProfile,
  markRemoteServerConnected,
  toProfileInfo,
  type RemoteServerProfile,
  type RemoteServerSftpInput,
} from '@craft-agent/shared/config/remote-servers'
import { getWorkspaces, addWorkspace, updateWorkspaceRemoteServer } from '@craft-agent/shared/config'
import { getDefaultWorkspacesDir, generateUniqueWorkspacePath } from '@craft-agent/shared/workspaces'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from './handler-deps'
import { connectToRemote } from './workspace'
import { validateNativeRemoteUrl } from '../remote-transport-policy'
import { resolveRemoteProfile, saveRemoteProfile, type ResolvedRemoteProfile } from '../remote-credentials'

export const GUI_HANDLED_CHANNELS = [
  RPC_CHANNELS.remoteServers.LIST,
  RPC_CHANNELS.remoteServers.SAVE,
  RPC_CHANNELS.remoteServers.DELETE,
  RPC_CHANNELS.remoteServers.TEST,
  RPC_CHANNELS.remoteServers.LIST_WORKSPACES,
  RPC_CHANNELS.remoteServers.CREATE_WORKSPACE,
  RPC_CHANNELS.remoteServers.OPEN_WORKSPACE,
] as const

/** One-shot helper: connect to a profile and run a remote invoke. */
async function withRemoteProfile<T>(
  profile: RemoteServerProfile,
  fn: (client: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> }) => Promise<T>,
  assertCurrent?: () => Promise<void>,
): Promise<{ result: T | null; error: string | null; profile?: ResolvedRemoteProfile }> {
  const resolved = await resolveRemoteProfile(profile.id)
  if (!resolved) return { result: null, error: 'Server profile not found' }
  const guard = async () => {
    await assertCurrent?.()
    const current = await resolveRemoteProfile(profile.id)
    if (!current || current.revision !== resolved.revision) throw new Error('Remote server profile changed. Retry.')
  }
  const { client } = await connectToRemote(validateNativeRemoteUrl(resolved.url), resolved.token, undefined, {
    beforeHandshake: guard, tlsRejectUnauthorized: true, useNodeWebSocket: true,
  })
  if (!client) return { result: null, error: 'Connection failed. Check Remote Servers settings.' }
  try {
    const current = await resolveRemoteProfile(profile.id)
    if (!current || current.revision !== resolved.revision) return { result: null, error: 'Remote server profile changed. Retry.' }
    await guard()
    const result = await fn(client)
    await guard()
    const after = await resolveRemoteProfile(profile.id)
    if (!after || after.revision !== resolved.revision) return { result: null, error: 'Remote server profile changed. Retry.' }
    return { result, error: null, profile: resolved }
  } catch {
    return { result: null, error: 'Remote request failed. Check Remote Servers settings.' }
  } finally {
    client.destroy()
  }
}

/**
 * Find or create the local metadata stub for a remote workspace so windows
 * can bind to it. Returns the local workspace.
 */
function findOrCreateRemoteStub(
  profile: RemoteServerProfile,
  remoteWorkspace: { id: string; name: string; slug?: string },
) {
  const binding = {
    url: profile.url,
    token: profile.tokenRef ? '' : profile.token,
    ...(profile.tokenRef ? { tokenRef: profile.tokenRef, tokenRefKind: 'profile' as const } : {}),
    profileId: profile.id,
    revision: profile.revision,
    remoteWorkspaceId: remoteWorkspace.id,
  }
  const existing = getWorkspaces().find(
    workspace => workspace.remoteServer?.profileId === profile.id
      && workspace.remoteServer.remoteWorkspaceId === remoteWorkspace.id,
  )
  if (existing) {
    const bindingChanged = JSON.stringify(existing.remoteServer) !== JSON.stringify(binding)
    if (bindingChanged) updateWorkspaceRemoteServer(existing.id, binding)
    return { workspace: getWorkspaces().find(workspace => workspace.id === existing.id) ?? existing, bindingChanged }
  }

  const slug = remoteWorkspace.slug || remoteWorkspace.name
  const rootPath = generateUniqueWorkspacePath(slug, getDefaultWorkspacesDir())
  return { workspace: addWorkspace({
    name: remoteWorkspace.name,
    rootPath,
    remoteServer: binding,
  }), bindingChanged: false }
}

export function registerRemoteServersGuiHandlers(server: RpcServer, deps: HandlerDeps): void {
  // --- Profile CRUD (local storage) ----------------------------------------
  server.handle(RPC_CHANNELS.remoteServers.LIST, async () => {
    return loadRemoteServerProfiles().map(toProfileInfo)
  })

  server.handle(
    RPC_CHANNELS.remoteServers.SAVE,
    async (_ctx, input: { id?: string; name: string; url: string; token?: string; sftp?: RemoteServerSftpInput }) => {
      const profile = await saveRemoteProfile(input)
      // Other config files retain their complete previous endpoint/ref snapshot
      // until explicitly reopened. No guessed URL/token matching or partial
      // cross-file "save all" publication occurs here.
      return toProfileInfo(profile)
    },
  )

  server.handle(RPC_CHANNELS.remoteServers.DELETE, async (_ctx, id: string) => {
    return { success: deleteRemoteServerProfile(id) }
  })

  // --- Connection test -------------------------------------------------------
  server.handle(
    RPC_CHANNELS.remoteServers.TEST,
    async (
      _ctx,
      input: { id?: string; url?: string; token?: string },
    ): Promise<{ ok: boolean; error?: string; serverVersion?: string }> => {
      const profile =
        input.id != null
          ? await resolveRemoteProfile(input.id)
          : input.url
            ? {
                id: 'adhoc',
                name: 'adhoc',
                url: input.url,
                token: input.token ?? '',
                createdAt: 0,
                updatedAt: 0,
              }
            : undefined
      if (!profile) return { ok: false, error: 'Server profile not found' }

      const { client } = await connectToRemote(profile.url, profile.token)
      if (!client) return { ok: false, error: 'Connection failed. Check Remote Servers settings.' }
      try {
        const serverVersion = client.getServerVersion?.() ?? undefined
        if (profile.id !== 'adhoc') markRemoteServerConnected(profile.id)
        return { ok: true, serverVersion }
      } finally {
        client.destroy()
      }
    },
  )

  // --- Remote workspace operations ------------------------------------------
  server.handle(RPC_CHANNELS.remoteServers.LIST_WORKSPACES, async (_ctx, profileId: string) => {
    const profile = getRemoteServerProfile(profileId)
    if (!profile) return { ok: false, error: 'Server profile not found' }

    const { result, error } = await withRemoteProfile(profile, async (client) => {
      return (await client.invoke(RPC_CHANNELS.server.GET_WORKSPACES)) as unknown[]
    })
    if (error) return { ok: false, error }
    markRemoteServerConnected(profileId)
    return { ok: true, workspaces: result ?? [] }
  })

  server.handle(
    RPC_CHANNELS.remoteServers.CREATE_WORKSPACE,
    async (_ctx, profileId: string, name: string) => {
      const profile = getRemoteServerProfile(profileId)
      if (!profile) return { ok: false, error: 'Server profile not found' }

      const { result, error, profile: connectedProfile } = await withRemoteProfile(profile, async (client) => {
        return (await client.invoke(RPC_CHANNELS.server.CREATE_WORKSPACE, name)) as {
          id: string
          name: string
          slug?: string
        }
      })
      if (error) return { ok: false, error }
      if (!result || !connectedProfile) return { ok: false, error: 'Remote server returned no workspace' }

      const { workspace: local } = findOrCreateRemoteStub(connectedProfile, result)
      return { ok: true, workspace: { id: local.id, name: local.name, slug: local.slug } }
    },
  )

  server.handle(RPC_CHANNELS.remoteServers.OPEN_WORKSPACE, (_ctx, profileId: string, remoteWorkspaceId: string) =>
    openSavedRemoteWorkspace(profileId, remoteWorkspaceId, (id, bindingChanged) => {
      if (bindingChanged) {
        for (const window of deps.windowManager?.getAllWindowsForWorkspace(id) ?? []) window.webContents.reload()
      }
      deps.windowManager?.focusOrCreateWindow(id)
    }),
  )
}

/** Used by native collaboration IPC as well as the existing workspace picker. */
export async function openSavedRemoteWorkspace(profileId: string, remoteWorkspaceId: string, focusWorkspace: (id: string, bindingChanged: boolean) => void, assertCurrent?: () => Promise<void>) {
  const profile = getRemoteServerProfile(profileId)
  if (!profile) return { ok: false, error: 'Server profile not found' }

  // Resolve the remote workspace metadata so we can create a stub if needed.
  const { result, error, profile: connectedProfile } = await withRemoteProfile(profile, async (client) => {
    const workspaces = (await client.invoke(RPC_CHANNELS.server.GET_WORKSPACES)) as Array<{
      id: string
      name: string
      slug?: string
    }>
    return workspaces.find((w) => w.id === remoteWorkspaceId)
  }, assertCurrent)
  if (error) return { ok: false, error }
  if (!result || !connectedProfile) return { ok: false, error: 'Workspace not found on remote server' }

  await assertCurrent?.()
  const { workspace: local, bindingChanged } = findOrCreateRemoteStub(connectedProfile, result)
  focusWorkspace(local.id, bindingChanged)
  return { ok: true, workspaceId: local.id }
}
