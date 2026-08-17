/**
 * Remote server management (远程服务器管理).
 *
 * GUI-only handlers (run on the local embedded server) that manage the
 * client's registry of remote Craft Agent servers:
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
  upsertRemoteServerProfile,
  deleteRemoteServerProfile,
  markRemoteServerConnected,
  toProfileInfo,
  type RemoteServerProfile,
  type RemoteServerSftpInput,
} from '@craft-agent/shared/config/remote-servers'
import { getWorkspaces, addWorkspace, updateWorkspaceRemoteServer } from '@craft-agent/shared/config'
import { getDefaultWorkspacesDir, generateUniqueWorkspacePath } from '@craft-agent/shared/workspaces'
import { join } from 'path'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from './handler-deps'
import { connectToRemote } from './workspace'

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
): Promise<{ result: T | null; error: string | null }> {
  const { client, error } = await connectToRemote(profile.url, profile.token)
  if (!client) return { result: null, error: error ?? 'Connection failed' }
  try {
    const result = await fn(client)
    return { result, error: null }
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
  const existing = getWorkspaces().find(
    (w) => w.remoteServer?.remoteWorkspaceId === remoteWorkspace.id,
  )
  if (existing) {
    // Keep the stub in sync with the profile — the user may have changed the
    // server URL/token since the instance was first opened. Stale snapshots
    // cause reconnect loops against the old endpoint.
    if (
      existing.remoteServer
      && (existing.remoteServer.url !== profile.url || existing.remoteServer.token !== profile.token)
    ) {
      updateWorkspaceRemoteServer(existing.id, {
        url: profile.url,
        token: profile.token,
        remoteWorkspaceId: existing.remoteServer.remoteWorkspaceId,
      })
    }
    return getWorkspaces().find((w) => w.id === existing.id) ?? existing
  }

  const slug = remoteWorkspace.slug || remoteWorkspace.name
  const rootPath = generateUniqueWorkspacePath(slug, getDefaultWorkspacesDir())
  return addWorkspace({
    name: remoteWorkspace.name,
    rootPath,
    remoteServer: {
      url: profile.url,
      token: profile.token,
      remoteWorkspaceId: remoteWorkspace.id,
    },
  })
}

export function registerRemoteServersGuiHandlers(server: RpcServer, deps: HandlerDeps): void {
  // --- Profile CRUD (local storage) ----------------------------------------
  server.handle(RPC_CHANNELS.remoteServers.LIST, async () => {
    return loadRemoteServerProfiles().map(toProfileInfo)
  })

  server.handle(
    RPC_CHANNELS.remoteServers.SAVE,
    async (_ctx, input: { id?: string; name: string; url: string; token?: string; sftp?: RemoteServerSftpInput }) => {
      const previous = input.id ? getRemoteServerProfile(input.id) : undefined
      const profile = upsertRemoteServerProfile(input)

      // Propagate URL/token changes to remote workspace stubs that were
      // created from this profile — otherwise instances keep connecting to
      // the old endpoint after the user edits the server link.
      if (previous && (previous.url !== profile.url || previous.token !== profile.token)) {
        for (const ws of getWorkspaces()) {
          const rs = ws.remoteServer
          if (!rs) continue
          const boundToProfile =
            rs.url === previous.url
            && (previous.token ? rs.token === previous.token : true)
          if (boundToProfile) {
            updateWorkspaceRemoteServer(ws.id, {
              url: profile.url,
              token: profile.token,
              remoteWorkspaceId: rs.remoteWorkspaceId,
            })
          }
        }
      }

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
          ? getRemoteServerProfile(input.id)
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

      const { client, error } = await connectToRemote(profile.url, profile.token)
      if (!client) return { ok: false, error: error ?? 'Connection failed' }
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

      const { result, error } = await withRemoteProfile(profile, async (client) => {
        return (await client.invoke(RPC_CHANNELS.server.CREATE_WORKSPACE, name)) as {
          id: string
          name: string
          slug?: string
        }
      })
      if (error) return { ok: false, error }
      if (!result) return { ok: false, error: 'Remote server returned no workspace' }

      const local = findOrCreateRemoteStub(profile, result)
      return { ok: true, workspace: { id: local.id, name: local.name, slug: local.slug } }
    },
  )

  server.handle(
    RPC_CHANNELS.remoteServers.OPEN_WORKSPACE,
    async (_ctx, profileId: string, remoteWorkspaceId: string) => {
      const profile = getRemoteServerProfile(profileId)
      if (!profile) return { ok: false, error: 'Server profile not found' }

      // Resolve the remote workspace metadata so we can create a stub if needed.
      const { result, error } = await withRemoteProfile(profile, async (client) => {
        const workspaces = (await client.invoke(RPC_CHANNELS.server.GET_WORKSPACES)) as Array<{
          id: string
          name: string
          slug?: string
        }>
        return workspaces.find((w) => w.id === remoteWorkspaceId)
      })
      if (error) return { ok: false, error }
      if (!result) return { ok: false, error: 'Workspace not found on remote server' }

      const local = findOrCreateRemoteStub(profile, result)
      deps.windowManager?.focusOrCreateWindow(local.id)
      return { ok: true, workspaceId: local.id }
    },
  )
}
