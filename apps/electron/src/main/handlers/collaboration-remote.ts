import { RPC_CHANNELS, type CollaborationSessionSelection } from '@craft-agent/shared/protocol'
import type { NativeAuthorityEvent } from '../native-window-authority'
import { validateNativeRemoteUrl } from '../remote-transport-policy'

/** These names are native Electron IPC only. Never register them on WsRpcServer:
 * an authenticated WebSocket caller can spoof its handshake webContentsId. */
export const REMOTE_COLLABORATION_IPC = {
  WORKSPACES: '__collaboration:remoteWorkspaces',
  CANDIDATES: '__collaboration:remoteCandidates',
  CREATE: '__collaboration:createRemote',
  OPEN_WORKSPACE: '__collaboration:openRemoteWorkspace',
} as const

interface RemoteClient {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  destroy(): void
}
interface IpcEvent { sender: { id: number } }
export interface CollaborationIpcRegistrar {
  handle(channel: string, listener: (event: IpcEvent, ...args: any[]) => Promise<any>): void
}

/** Saved credentials remain in main; sender identity comes from Electron, not
 * request payloads. Remote membership is always bound to a single workspace. */
export function registerRemoteCollaborationIpcHandlers(ipc: CollaborationIpcRegistrar, deps: {
  getProfile: (id: string) => { url: string; token: string; revision?: string } | undefined | Promise<{ url: string; token: string; revision?: string } | undefined>
  connect: (url: string, token: string, workspaceId: string | undefined, options: { beforeHandshake: () => Promise<void> }) => Promise<{ client: RemoteClient | null; error: string | null }>
  /** Must validate actual registered WebContents, mainFrame and trusted app URL. */
  assertSender: (event: NativeAuthorityEvent) => { bindingId: string }
  openWorkspace: (profileId: string, workspaceId: string, assertCurrent: () => Promise<void>) => Promise<unknown>
}): void {
  function requireSender(event: IpcEvent): string {
    try { return deps.assertSender(event as NativeAuthorityEvent).bindingId }
    catch { throw new Error('Remote collaboration selection requires a trusted local desktop client') }
  }
  async function pin(event: IpcEvent, profileId: string) {
    const bindingId = requireSender(event)
    if (typeof profileId !== 'string' || !profileId.trim() || profileId.length > 256) throw new Error('Server profile is required')
    const resolved = await deps.getProfile(profileId)
    if (!resolved) throw new Error('Server profile not found')
    const profile = { ...resolved }
    validateNativeRemoteUrl(profile.url)
    const assertCurrent = async () => {
      if (requireSender(event) !== bindingId) throw new Error('Application workspace changed. Reopen collaboration selection.')
      const current = await deps.getProfile(profileId)
      if (requireSender(event) !== bindingId || !current || current.url !== profile.url || current.token !== profile.token || current.revision !== profile.revision) {
        throw new Error('Saved server or application workspace changed. Check the selected collaboration before retrying.')
      }
    }
    await assertCurrent()
    return { profile, assertCurrent }
  }
  function redact(value: unknown, token: string, depth = 0): unknown {
    if (depth > 64) throw new Error('Invalid remote collaboration response')
    if (typeof value === 'string') return token ? (value === token ? '[redacted]' : token.length >= 8 ? value.split(token).join('[redacted]') : value) : value
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value
    if (Array.isArray(value)) return value.map(item => redact(item, token, depth + 1))
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, token, depth + 1), redact(item, token, depth + 1)]))
    throw new Error('Invalid remote collaboration response')
  }
  function safeError(error: unknown, token: string): Error {
    const message = error instanceof Error ? error.message : String(error)
    // Never propagate a provider error's original stack/cause: it may echo the
    // saved handshake credential. Keep useful diagnostics with exact redaction.
    return new Error(token ? message.split(token).join('[redacted]') : message)
  }
  async function invoke(event: IpcEvent, profileId: string, workspaceId: string | undefined, channel: string, args: unknown[]) {
    if (workspaceId !== undefined && (typeof workspaceId !== 'string' || !workspaceId.trim())) throw new Error('Workspace is required')
    const { profile, assertCurrent } = await pin(event, profileId)
    let client: RemoteClient | null = null
    try {
      const connection = await deps.connect(profile.url, profile.token, workspaceId, { beforeHandshake: assertCurrent })
      client = connection.client
      if (!client) throw new Error(connection.error ?? 'Connection failed')
      await assertCurrent()
      const result = await client.invoke(channel, ...args)
      await assertCurrent()
      return redact(result, profile.token)
    } catch (error) {
      throw safeError(error, profile.token)
    } finally {
      client?.destroy()
    }
  }

  ipc.handle(REMOTE_COLLABORATION_IPC.WORKSPACES, async (event, profileId: string) => {
    const workspaces = await invoke(event, profileId, undefined, RPC_CHANNELS.server.GET_WORKSPACES, []) as Array<{ id: string; name: string; remoteServer?: unknown }>
    // Do not send workspace secrets/config back to the renderer.
    return workspaces.filter(workspace => !workspace.remoteServer).map(workspace => ({ id: workspace.id, name: workspace.name }))
  })
  ipc.handle(REMOTE_COLLABORATION_IPC.CANDIDATES, (event, profileId: string, workspaceId: string) => {
    if (!workspaceId) return Promise.reject(new Error('Workspace is required'))
    return invoke(event, profileId, workspaceId, RPC_CHANNELS.collaborations.LIST_CANDIDATES, [])
  })
  ipc.handle(REMOTE_COLLABORATION_IPC.CREATE, async (event, profileId: string, workspaceId: string, primarySessionId: string, secondaries: CollaborationSessionSelection[]) => {
    requireSender(event)
    if (!workspaceId) throw new Error('Workspace is required')
    if (!Array.isArray(secondaries) || !secondaries.length || secondaries.length > 32) throw new Error('Choose between 1 and 32 secondary sessions')
    if (secondaries.some(item => !item || item.serverUrl || item.workspaceId !== workspaceId)) {
      throw new Error('Remote collaboration members must share the selected server and workspace')
    }
    return invoke(event, profileId, workspaceId, RPC_CHANNELS.collaborations.CREATE, [primarySessionId, secondaries])
  })
  ipc.handle(REMOTE_COLLABORATION_IPC.OPEN_WORKSPACE, async (event, profileId: string, workspaceId: string) => {
    const { profile, assertCurrent } = await pin(event, profileId)
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new Error('Workspace is required')
    try {
      const result = await deps.openWorkspace(profileId, workspaceId, assertCurrent)
      await assertCurrent()
      if (result && typeof result === 'object' && 'error' in result && typeof result.error === 'string') {
        return redact({ ...result, error: safeError(new Error(result.error), profile.token).message }, profile.token)
      }
      return redact(result, profile.token)
    } catch (error) {
      throw safeError(error, profile.token)
    }
  })
}
