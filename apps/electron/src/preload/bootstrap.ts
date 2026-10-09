/**
 * WS-mode preload — replaces the full IPC preload (index.ts).
 *
 * Normal mode (local server):
 *   Creates a RoutedClient that routes LOCAL_ONLY channels to the local
 *   Electron server and REMOTE_ELIGIBLE channels to whichever server owns
 *   the active workspace (local or remote). Workspace switches swap the
 *   workspace client transparently.
 *
 * Remote frontend mode (reported by main):
 *   Creates a single WsRpcClient connected to the remote server.
 *   All channels go to the remote server.
 *
 * On localhost the WS handshake completes in <1ms. The React app takes >100ms
 * to initialise, so by the time any component calls an API method, the
 * connection is established.
 */

import '@sentry/electron/preload'
import { contextBridge, ipcRenderer, shell, webUtils } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import { WsRpcClient, type TransportConnectionState } from '../transport/client'
import { RoutedClient, type WorkspaceTransportClient } from '../transport/routed-client'
import { NativeRemoteClient } from './native-remote-client'
import { createNativeWorkspaceSwitcher } from './native-workspace-switch'
import { buildClientApi } from '../transport/build-api'
import { CHANNEL_MAP } from '../transport/channel-map'
import { createCallbackServer } from '@craft-agent/shared/auth/callback-server'
import { CHATGPT_OAUTH_CONFIG } from '@craft-agent/shared/auth/chatgpt-oauth-config'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import {
  CLIENT_OPEN_EXTERNAL,
  CLIENT_OPEN_PATH,
  CLIENT_SHOW_IN_FOLDER,
  CLIENT_CONFIRM_DIALOG,
  CLIENT_OPEN_FILE_DIALOG,
  CLIENT_SAVE_FILE_DIALOG,
  CLIENT_BROWSER_INVOKE,
  CLIENT_CANVAS_INVOKE,
  CLIENT_RUN_SHELL,
  CLIENT_REMOTE_ACCESS,
  CLIENT_REQUEST_FILES,
  CLIENT_SFTP_TRANSFER,
  LOCAL_CLIENT_CAPABILITIES,
} from '@craft-agent/server-core/transport'
import type { ConfirmDialogSpec, FileDialogSpec, BrowserCapabilityRequest } from '@craft-agent/server-core/transport'
import type { RpcClient } from '@craft-agent/server-core/transport'
import type { RemoteServerConfig } from '@craft-agent/core/types'
import type { ElectronAPI } from '../shared/types'
import { TOKENNEST_RECHARGE_IPC } from '../shared/tokennest-recharge'
import { canvasExportInfo } from '../shared/canvas-export'
import { BIRD_COMPANION_IPC } from '../shared/bird-companion'
import { NATIVE_CREDENTIAL_IPC } from '@craft-agent/shared/credentials/native-types'

// ---------------------------------------------------------------------------
// Client interface — common surface for both RoutedClient and WsRpcClient
// ---------------------------------------------------------------------------

interface TransportClient extends RpcClient {
  isChannelAvailable(channel: string): boolean
  getConnectionState(): TransportConnectionState
  onConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void
  reconnectNow(): void
}

// ---------------------------------------------------------------------------
// Connection setup
// ---------------------------------------------------------------------------

// ── Picker mode (startup server location = 无服务) ───────────────────────────
// Checked FIRST: a picker-only launch has no local service or transport IPC. Expose
// only the minimal API the server picker page needs; no WS clients are created.
const startupContext: {
  mode?: 'picker' | 'normal'
  remote?: { url: string; profileId?: string; token?: string; workspaceId?: string }
} = ipcRenderer.sendSync('__get-startup-context')
const isPickerMode = startupContext?.mode === 'picker'

if (isPickerMode) {
  // Real methods the picker page needs.
  const pickerApi: Record<string, unknown> = {
    // Sync flag read by the renderer ROOT so it can render the picker page
    // without ever mounting the full App (which expects a live server).
    startupMode: 'picker',
    getRuntimeEnvironment: (): 'electron' | 'web' => 'electron',
    getStartupContext: () => ipcRenderer.invoke('__get-server-context'),
    getRemoteServers: () => ipcRenderer.invoke('__picker-get-profiles'),
    selectStartupServer: (target: string) => ipcRenderer.invoke('__select-startup-server', target),
    switchServer: (target: string) => ipcRenderer.invoke('__select-startup-server', target),
    getStartupLocation: () => ipcRenderer.invoke('__get-startup-location'),
    setStartupLocation: (value: string) => ipcRenderer.invoke('__set-startup-location', value),
  }

  // Safe stubs for the remaining ElectronAPI surface. The App shell mounts and
  // runs several effects before it learns it is in picker mode — these keep
  // those calls from throwing on a missing method.
  const extraKeys = [
    'getTransportConnectionState',
    'onTransportConnectionStateChanged',
    'reconnectTransport',
    'getFilePath',
    'changeLanguage',
    'relaunchApp',
    'removeWorkspace',
    'getSystemWarnings',
    'performOAuth',
    'onTransferProgress',
    'invokeOnServer',
    'transferSessionToWorkspace',
    'isChannelAvailable',
    'onStudioCanvasRequest',
  ]
  for (const key of new Set([...Object.keys(CHANNEL_MAP), ...extraKeys])) {
    if (pickerApi[key] !== undefined) continue
    pickerApi[key] = key.startsWith('on')
      ? () => () => {}
      : async () => undefined
  }

  contextBridge.exposeInMainWorld('electronAPI', pickerApi)
} else {

const webContentsId: number = ipcRenderer.sendSync('__get-web-contents-id')
// Main owns the current connection. A renderer reload may retain the process
// environment from before a server switch, so never infer routing from it.
const isClientOnly = !!startupContext.remote

let client: TransportClient
let routedClient: RoutedClient | null = null
let nativeThinClient: NativeRemoteClient | null = null

if (isClientOnly) {
  // ── Thin-client mode ───────────────────────────────────────────────────
  // Single WsRpcClient connected directly to the remote server.
  // No local server, no routing — all channels go to remote.

  if (startupContext.remote?.profileId) {
    nativeThinClient = new NativeRemoteClient(ipcRenderer)
    nativeThinClient.connect()
    client = nativeThinClient
  } else {
  const wsUrl = startupContext.remote!.url
  const wsToken = startupContext.remote!.token ?? ''

  // Block unencrypted ws:// to non-localhost servers — tokens would be sent in cleartext
  const parsed = new URL(wsUrl)
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
  if (parsed.protocol === 'ws:' && !isLocalhost) {
    throw new Error(
      `Refusing to connect to remote server over unencrypted ws://. ` +
      `Use wss:// (TLS) for non-localhost connections. ` +
      `Set CRAFT_RPC_TLS_CERT/KEY on the server to enable TLS.`
    )
  }

  // Workspace ID is optional — if missing, renderer shows a workspace picker
  const workspaceId = startupContext.remote?.workspaceId || ipcRenderer.sendSync('__get-workspace-id') || undefined

  const wsClient = new WsRpcClient(wsUrl, {
    token: wsToken,
    workspaceId,
    webContentsId,
    autoReconnect: true,
    mode: 'remote',
    clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES, CLIENT_REMOTE_ACCESS],
  })
  wsClient.connect()
  client = wsClient

  }

} else {
  // ── Normal mode ────────────────────────────────────────────────────────
  // RoutedClient routes LOCAL_ONLY to local server, REMOTE_ELIGIBLE to
  // whichever server owns the workspace (local or remote).

  const wsPort: number = ipcRenderer.sendSync('__get-ws-port')
  const wsToken: string = ipcRenderer.sendSync('__get-ws-token')
  const workspaceId: string = ipcRenderer.sendSync('__get-workspace-id')

  const localClient = new WsRpcClient(`ws://127.0.0.1:${wsPort}`, {
    token: wsToken,
    workspaceId,
    webContentsId,
    autoReconnect: true,
    mode: 'local',
    clientCapabilities: LOCAL_CLIENT_CAPABILITIES.filter(channel => channel !== CLIENT_SFTP_TRANSFER),
  })

  // Check if the current workspace is remote (synchronous IPC during preload eval)
  const remoteConfig: RemoteServerConfig | null = ipcRenderer.sendSync('__get-workspace-remote-config')

  let initialWorkspaceClient: WorkspaceTransportClient
  if (remoteConfig && typeof remoteConfig.url === 'string') {
    // Saved/stub credentials are resolved and used only in main.
    initialWorkspaceClient = new NativeRemoteClient(ipcRenderer)
    initialWorkspaceClient.connect()
  } else {
    // Workspace is local — workspace client IS the local client
    initialWorkspaceClient = localClient
  }

  routedClient = new RoutedClient(localClient, initialWorkspaceClient)

  // Set workspace ID mapping if initial workspace is remote
  if (remoteConfig) {
    routedClient.setWorkspaceMapping(workspaceId, remoteConfig.remoteWorkspaceId)
  }

  // Factory for creating remote workspace clients on switch
  routedClient.setClientFactory(() => new NativeRemoteClient(ipcRenderer))

  localClient.connect()
  client = routedClient
}

// ---------------------------------------------------------------------------
// Register client-side capability handlers (server can invoke these)
// ---------------------------------------------------------------------------

client.handleCapability(CLIENT_OPEN_EXTERNAL, (url: string) => shell.openExternal(url))

client.handleCapability(CLIENT_OPEN_PATH, async (path: string) => {
  const error = await shell.openPath(path)
  return { error: error || undefined }
})

client.handleCapability(CLIENT_SHOW_IN_FOLDER, (path: string) => {
  shell.showItemInFolder(path)
})

client.handleCapability(CLIENT_CONFIRM_DIALOG, async (spec: ConfirmDialogSpec) => {
  return await ipcRenderer.invoke('__dialog:showMessageBox', spec)
})

client.handleCapability(CLIENT_OPEN_FILE_DIALOG, async (spec: FileDialogSpec) => {
  return await ipcRenderer.invoke('__dialog:showOpenDialog', spec)
})

client.handleCapability(CLIENT_SAVE_FILE_DIALOG, async (spec: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
  return await ipcRenderer.invoke('__dialog:showSaveDialog', spec)
})

// Browser pane invocation. The remote server packages an IBrowserPaneManager
// method call as a BrowserCapabilityRequest; we dispatch it to the local
// `BrowserPaneManager` via the `__browser:invoke` IPC channel registered in
// `apps/electron/src/main/browser-pane-manager.ts:registerCapabilityIpc()`.
client.handleCapability(CLIENT_BROWSER_INVOKE, async (req: BrowserCapabilityRequest) => {
  return await ipcRenderer.invoke('__browser:invoke', req)
})

let canvasRequestHandler: ((request: Record<string, unknown>) => Promise<unknown>) | null = null
client.handleCapability(CLIENT_CANVAS_INVOKE, async (request: Record<string, unknown>) => {
  if (!canvasRequestHandler) throw new Error('Canvas editor is not ready in the desktop client')
  const input = { ...request }
  if (input.action === 'import_image' && typeof input.imagePath === 'string') {
    if (!isAbsolute(input.imagePath)) throw new Error('imagePath must be absolute')
    const bytes = await readFile(input.imagePath)
    if (bytes.length > 30_000_000) throw new Error('Image exceeds 30 MB')
    input.imageBase64 = bytes.toString('base64')
    input.imageName = input.imagePath.split(/[\\/]/).pop() || '导入图片'
  }
  if (input.action === 'open_project' && typeof input.projectPath === 'string') {
    if (!isAbsolute(input.projectPath)) throw new Error('projectPath must be absolute')
    const bytes = await readFile(input.projectPath)
    if (bytes.length > 150_000_000) throw new Error('Project exceeds 150 MB')
    input.projectText = bytes.toString('utf8')
  }
  const result = await canvasRequestHandler(input) as Record<string, unknown>
  if ((input.action === 'export_image' || input.action === 'export_png' || input.action === 'export_selection_mask' || input.action === 'save_project' || input.action === 'download_history' || input.action === 'download_candidate') && typeof input.outputPath === 'string' && typeof result?.base64 === 'string') {
    if (!isAbsolute(input.outputPath)) throw new Error('outputPath must be absolute')
    const extension = extname(input.outputPath).toLowerCase()
    if (!canvasExportInfo(input).extensions.includes(extension)) throw new Error('Output path has the wrong file extension')
    const bytes = Buffer.from(result.base64, 'base64')
    await writeFile(input.outputPath, bytes, { flag: 'wx' })
    return { saved: true, outputPath: input.outputPath, bytes: bytes.length, mime: canvasExportInfo(input).mime, width: result.width, height: result.height }
  }
  return result
})

// `localbash` — the remote server asks THIS machine to run a shell command on
// behalf of the agent (remote-mode local execution bridge).
client.handleCapability(CLIENT_RUN_SHELL, async (req: { command: string; cwd?: string; timeoutMs?: number }) => {
  return await ipcRenderer.invoke('__shell:run', req)
})

client.handleCapability(CLIENT_REQUEST_FILES, async (req: import('@craft-agent/core/types').ClientFileRequest) => {
  return await ipcRenderer.invoke('__client:request-files', req)
})

client.handleCapability(CLIENT_SFTP_TRANSFER, async (req: { direction: 'upload' | 'download'; localPath: string; remotePath: string }) => {
  return await ipcRenderer.invoke('__sftp:transfer-active', req)
})

// ---------------------------------------------------------------------------
// Build ElectronAPI proxy
// ---------------------------------------------------------------------------

const api = buildClientApi(client, CHANNEL_MAP, (ch) => client.isChannelAvailable(ch))
;(api as ElectronAPI).onStudioCanvasRequest = (handler) => {
  canvasRequestHandler = handler
  return () => { if (canvasRequestHandler === handler) canvasRequestHandler = null }
}

;(api as any).getRuntimeEnvironment = (): 'electron' | 'web' => 'electron'
;(api as any).openTokenNestRecharge = (url: string, connectionSlug?: string): Promise<void> => ipcRenderer.invoke(TOKENNEST_RECHARGE_IPC, url, connectionSlug)

// ---------------------------------------------------------------------------
// Transport connection state logging (for remote connections)
// ---------------------------------------------------------------------------

function formatTransportReason(state: TransportConnectionState): string {
  const err = state.lastError
  if (err) {
    const codePart = err.code ? ` [${err.code}]` : ''
    return `${err.kind}${codePart}: ${err.message}`
  }

  if (state.lastClose?.code != null) {
    const reason = state.lastClose.reason ? ` (${state.lastClose.reason})` : ''
    return `close ${state.lastClose.code}${reason}`
  }

  return 'no additional details'
}

// Log remote connection state changes to main process (visible in terminal + main.log).
// Activates whenever the workspace connection is remote (thin client or remote workspace).
client.onConnectionStateChanged((state) => {
  if (state.mode !== 'remote') return

  const emitToMain = (level: 'info' | 'warn' | 'error', message: string) => {
    ipcRenderer.send('__transport:status', {
      level,
      message,
      status: state.status,
      attempt: state.attempt,
      nextRetryInMs: state.nextRetryInMs,
      error: state.lastError,
      close: state.lastClose,
      url: state.url,
    })
  }

  if (state.status === 'connected') {
    const message = `[transport] connected to ${state.url}`
    console.info(message)
    emitToMain('info', message)
    return
  }

  if (state.status === 'reconnecting') {
    const retry = state.nextRetryInMs != null ? ` retry in ${state.nextRetryInMs}ms` : ''
    const message = `[transport] reconnecting (attempt ${state.attempt})${retry} — ${formatTransportReason(state)}`
    console.warn(message)
    emitToMain('warn', message)
    return
  }

  if (state.status === 'failed' || state.status === 'disconnected') {
    const message = `[transport] ${state.status} — ${formatTransportReason(state)}`
    console.error(message)
    emitToMain('error', message)
  }
})

// ---------------------------------------------------------------------------
// Transport state API (exposed to renderer)
// ---------------------------------------------------------------------------

;(api as any).getTransportConnectionState = async () => client.getConnectionState()
;(api as any).onTransportConnectionStateChanged = (callback: (state: TransportConnectionState) => void) => {
  return client.onConnectionStateChanged(callback)
}
;(api as any).reconnectTransport = async () => {
  if (isClientOnly) {
    if (nativeThinClient) await nativeThinClient.rebind()
    else client.reconnectNow()
    return
  }

  if (routedClient) {
    const workspaceId = ipcRenderer.sendSync('__get-workspace-id')
    await (api as ElectronAPI).switchWorkspace(workspaceId)
  } else {
    client.reconnectNow()
  }
}

// ── performOAuth ─────────────────────────────────────────────────────────
// Multi-step orchestration: callback server (local) → oauth:start (server) →
// open browser → wait for callback → oauth:complete (server).
// Runs client-side because the callback server must receive the redirect.
;(api as any).performOAuth = async (args: {
  sourceSlug: string
  sessionId?: string
  authRequestId?: string
}): Promise<{ success: boolean; error?: string; email?: string }> => {
  let callbackServer: Awaited<ReturnType<typeof createCallbackServer>> | null = null
  let flowId: string | undefined
  let state: string | undefined

  try {
    // 1. Start local callback server to receive OAuth redirect
    callbackServer = await createCallbackServer({ appType: 'electron' })
    const callbackUrl = `${callbackServer.url}/callback`

    // 2. Ask server to prepare the flow (PKCE, auth URL, store in flow store)
    const startResult = await client.invoke('oauth:start', {
      sourceSlug: args.sourceSlug,
      callbackUrl,
      sessionId: args.sessionId,
      authRequestId: args.authRequestId,
    })
    flowId = startResult.flowId
    state = startResult.state

    // 3. Open browser for user consent (local — must open on the user's machine, not remote server)
    await shell.openExternal(startResult.authUrl)

    // 4. Wait for OAuth provider to redirect to our callback server
    const callback = await callbackServer.promise

    // 5. Check for errors from the provider
    if (callback.query.error) {
      const error = callback.query.error_description || callback.query.error
      await client.invoke('oauth:cancel', { flowId, state })
      return { success: false, error }
    }

    const code = callback.query.code
    if (!code) {
      await client.invoke('oauth:cancel', { flowId, state })
      return { success: false, error: 'No authorization code received' }
    }

    // 6. Send code to server for token exchange + credential storage
    const result = await client.invoke('oauth:complete', { flowId, code, state })
    return { success: result.success, error: result.error, email: result.email }
  } catch (err) {
    // Clean up server-side flow on error
    if (flowId && state) {
      client.invoke('oauth:cancel', { flowId, state }).catch(() => {})
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'OAuth flow failed',
    }
  } finally {
    callbackServer?.close()
  }
}

// ── startClaudeOAuth ─────────────────────────────────────────────────────
// Override the channel-map stub: the server now returns authUrl without opening
// the browser. We open it locally so it works in remote mode.
// Claude OAuth is two-step: browser opens → user copies code → pastes in UI.
;(api as any).startClaudeOAuth = async (): Promise<{
  success: boolean
  authUrl?: string
  error?: string
}> => {
  try {
    const result = await client.invoke('onboarding:startClaudeOAuth')
    if (result.success && result.authUrl) {
      await shell.openExternal(result.authUrl)
    }
    return result
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Claude OAuth failed',
    }
  }
}

// ── performChatGptOAuth ──────────────────────────────────────────────────
// Same shape as performOAuth: callback server (port 1455) → chatgpt:startOAuth →
// browser → callback → chatgpt:completeOAuth.
// Overrides the startChatGptOAuth API method so the renderer call is unchanged.
;(api as any).startChatGptOAuth = async (
  connectionSlug: string,
): Promise<{ success: boolean; error?: string }> => {
  let callbackServer: Awaited<ReturnType<typeof createCallbackServer>> | null = null
  let flowId: string | undefined
  let state: string | undefined

  try {
    // 1. Start callback server on ChatGPT's fixed port with /auth/callback path
    callbackServer = await createCallbackServer({
      appType: 'electron',
      port: CHATGPT_OAUTH_CONFIG.CALLBACK_PORT,
      callbackPaths: ['/auth/callback'],
    })

    // 2. Ask server to prepare the flow (PKCE, auth URL, store pending flow)
    const startResult = await client.invoke('chatgpt:startOAuth', connectionSlug)
    flowId = startResult.flowId
    state = startResult.state

    // 3. Open browser for user consent
    await shell.openExternal(startResult.authUrl)

    // 4. Wait for OpenAI to redirect to our callback server
    const callback = await callbackServer.promise

    // 5. Check for errors from the provider
    if (callback.query.error) {
      const error = callback.query.error_description || callback.query.error
      await client.invoke('chatgpt:cancelOAuth', { state })
      return { success: false, error }
    }

    const code = callback.query.code
    if (!code) {
      await client.invoke('chatgpt:cancelOAuth', { state })
      return { success: false, error: 'No authorization code received' }
    }

    // 6. Send code to server for token exchange + credential storage
    const result = await client.invoke('chatgpt:completeOAuth', { flowId, code, state })
    return { success: result.success, error: result.error }
  } catch (err) {
    if (state) {
      client.invoke('chatgpt:cancelOAuth', { state }).catch(() => {})
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'ChatGPT OAuth flow failed',
    }
  } finally {
    callbackServer?.close()
  }
}

// ── performTokenNestOAuth ────────────────────────────────────────────────
// Public native-client flow: local 127.0.0.1 callback + server-owned PKCE
// verifier/token exchange. The IP literal matches TokenNest's RFC 8252 rules.
;(api as any).startTokenNestOAuth = async (
  connectionSlug = 'tokennest',
): Promise<{ success: boolean; error?: string }> => {
  let callbackServer: Awaited<ReturnType<typeof createCallbackServer>> | null = null
  let flowId: string | undefined
  let state: string | undefined

  try {
    callbackServer = await createCallbackServer({
      appType: 'electron',
      host: '127.0.0.1',
      callbackPaths: ['/callback'],
    })
    const callbackUrl = `${callbackServer.url}/callback`
    const startResult = await client.invoke('tokennest:startOAuth', { connectionSlug, callbackUrl })
    flowId = startResult.flowId
    state = startResult.state
    await shell.openExternal(startResult.authUrl)

    const callback = await callbackServer.promise
    if (!callback.query.state || callback.query.state !== state) {
      await client.invoke('tokennest:cancelOAuth', { flowId, state })
      return { success: false, error: 'TokenNest OAuth state mismatch' }
    }
    if (callback.query.error) {
      const error = callback.query.error_description || callback.query.error
      await client.invoke('tokennest:cancelOAuth', { flowId, state })
      return { success: false, error }
    }
    if (!callback.query.code) {
      await client.invoke('tokennest:cancelOAuth', { flowId, state })
      return { success: false, error: 'No authorization code received' }
    }
    return await client.invoke('tokennest:completeOAuth', {
      flowId,
      state,
      code: callback.query.code,
    })
  } catch (err) {
    if (flowId && state) {
      client.invoke('tokennest:cancelOAuth', { flowId, state }).catch(() => {})
    }
    return { success: false, error: err instanceof Error ? err.message : 'TokenNest OAuth failed' }
  } finally {
    callbackServer?.close()
  }
}

// Same-server cross-workspace authority is available only through native IPC.
// Remote-owned workspaces and thin clients use the scoped network handlers.
;(api as ElectronAPI).switchWorkspace = createNativeWorkspaceSwitcher(async (workspaceId: string) => {
  if (!routedClient) {
    if (nativeThinClient) {
      await ipcRenderer.invoke('__workspace:switch', workspaceId)
      await nativeThinClient.rebind()
    } else {
      await client.invoke(RPC_CHANNELS.window.SWITCH_WORKSPACE, workspaceId)
    }
    return
  }
  const target = await ipcRenderer.invoke('__workspace:switch', workspaceId)
  await routedClient.applyNativeWorkspaceSwitch(target)
})

const invokeCurrentCollaboration = (nativeChannel: string, rpcChannel: string, ...args: unknown[]) => {
  const remoteWorkspace = isClientOnly || !!ipcRenderer.sendSync('__get-workspace-remote-config')
  return remoteWorkspace ? client.invoke(rpcChannel, ...args) : ipcRenderer.invoke(nativeChannel, ...args)
}
;(api as ElectronAPI).listCollaborationWorkspaces = () => invokeCurrentCollaboration('__collaboration:localWorkspaces', RPC_CHANNELS.collaborations.LIST_WORKSPACES)
;(api as ElectronAPI).listCollaborationCandidates = () => invokeCurrentCollaboration('__collaboration:localCandidates', RPC_CHANNELS.collaborations.LIST_CANDIDATES)
;(api as ElectronAPI).createCollaboration = (primaryId, selections) => invokeCurrentCollaboration('__collaboration:createLocal', RPC_CHANNELS.collaborations.CREATE, primaryId, selections)

// Credential management has the same native-only boundary. Main validates the
// real sender's current local workspace; no caller-supplied workspace or RPC fallback.
;(api as ElectronAPI).getNativeCredentialStatus = () => ipcRenderer.invoke(NATIVE_CREDENTIAL_IPC.STATUS)
;(api as ElectronAPI).listNativeCredentials = () => ipcRenderer.invoke(NATIVE_CREDENTIAL_IPC.LIST)
;(api as ElectronAPI).applyNativeCredentialChanges = request => ipcRenderer.invoke(NATIVE_CREDENTIAL_IPC.APPLY, request)
;(api as ElectronAPI).migrateNativeCredentials = request => ipcRenderer.invoke(NATIVE_CREDENTIAL_IPC.MIGRATE, request)

// Saved-profile collaboration calls require native Electron sender identity.
// Never route these through WebSocket handlers or send profile tokens to renderer.
;(api as ElectronAPI).listRemoteCollaborationWorkspaces = profileId => ipcRenderer.invoke('__collaboration:remoteWorkspaces', profileId)
;(api as ElectronAPI).listRemoteCollaborationCandidates = (profileId, workspaceId) => ipcRenderer.invoke('__collaboration:remoteCandidates', profileId, workspaceId)
;(api as ElectronAPI).createRemoteCollaboration = (profileId, workspaceId, primaryId, selections) => ipcRenderer.invoke('__collaboration:createRemote', profileId, workspaceId, primaryId, selections)
;(api as ElectronAPI).openRemoteCollaborationWorkspace = (profileId, workspaceId) => ipcRenderer.invoke('__collaboration:openRemoteWorkspace', profileId, workspaceId)

// App lifecycle — direct IPC (not WS RPC) since it restarts the server itself
;(api as ElectronAPI).relaunchApp = () => ipcRenderer.invoke('app:relaunch')
;(api as ElectronAPI).removeWorkspace = (workspaceId: string) => isClientOnly
  ? client.invoke(RPC_CHANNELS.server.DELETE_WORKSPACE, workspaceId)
  : ipcRenderer.invoke('workspace:remove', workspaceId)
;(api as ElectronAPI).invokeOnServer = (url: string, token: string, channel: string, ...args: any[]) =>
  ipcRenderer.invoke('server:invokeOnServer', url, token, channel, ...args)
;(api as ElectronAPI).transferSessionToWorkspace = (sessionId: string, targetWorkspaceId: string, sessionIndex?: number, sessionCount?: number) =>
  ipcRenderer.invoke('session:transferToWorkspace', sessionId, targetWorkspaceId, sessionIndex, sessionCount)
;(api as ElectronAPI).onTransferProgress = (cb: (progress: { sessionIndex: number; sessionCount: number; chunkSent: number; chunkTotal: number }) => void) => {
  const handler = (_e: any, progress: { sessionIndex: number; sessionCount: number; chunkSent: number; chunkTotal: number }) => cb(progress)
  ipcRenderer.on('transfer:progress', handler)
  return () => { ipcRenderer.removeListener('transfer:progress', handler) }
}

// System warnings — expose env-based flags set during main process startup
// (preload-only: reads env var directly, no IPC round-trip needed)
;(api as ElectronAPI).getSystemWarnings = async () => ({
  vcredistMissing: process.env.CRAFT_VCREDIST_MISSING === '1',
  downloadUrl: process.env.CRAFT_VCREDIST_URL,
})

// i18n: sync language changes to main process (for native menus/dialogs)
;(api as ElectronAPI).changeLanguage = (lang: string) => ipcRenderer.invoke('i18n:changeLanguage', lang)
;(api as ElectronAPI).getBirdCompanionPreferences = () => ipcRenderer.invoke(BIRD_COMPANION_IPC.getPreferences)
;(api as ElectronAPI).setBirdCompanionPreferences = updates => ipcRenderer.invoke(BIRD_COMPANION_IPC.setPreferences, updates)
;(api as ElectronAPI).observeBirdCompanionProgress = event => ipcRenderer.invoke(BIRD_COMPANION_IPC.observe, event)

// webUtils.getPathForFile: returns the absolute OS path of a File object obtained
// from <input type="file"> or OS drag-drop. Returns null for Files fabricated from
// Blobs (clipboard paste, web-drag) — those are content-only, no filesystem path.
;(api as ElectronAPI).getFilePath = (file: File) => {
  try {
    return webUtils.getPathForFile(file) || null
  } catch {
    return null
  }
}

// ── Server switching + startup location (direct IPC to main) ─────────────
// These are client-local concerns (relaunch / local preference) — they bypass
// WS RPC so they keep working in thin-client remote mode where the local
// embedded server is not running.
;(api as ElectronAPI).startupMode = 'normal'
;(api as ElectronAPI).getStartupContext = () => ipcRenderer.invoke('__get-server-context')
;(api as ElectronAPI).switchServer = (target: string) => ipcRenderer.invoke('__select-startup-server', target)
;(api as ElectronAPI).selectStartupServer = (target: string) => ipcRenderer.invoke('__select-startup-server', target)
;(api as ElectronAPI).getStartupLocation = () => ipcRenderer.invoke('__get-startup-location')
;(api as ElectronAPI).setStartupLocation = (value: string) => ipcRenderer.invoke('__set-startup-location', value)
// Profile list is client-local too — overrides the CHANNEL_MAP entry so it
// works identically in thin-client remote mode.
;(api as ElectronAPI).getRemoteServers = () => ipcRenderer.invoke('__picker-get-profiles')
if (isClientOnly) {
  ;(api as ElectronAPI).saveRemoteServer = (input) => ipcRenderer.invoke('__remote-servers:save', input)
  ;(api as ElectronAPI).deleteRemoteServer = (id: string) => ipcRenderer.invoke('__remote-servers:delete', id)
  ;(api as ElectronAPI).testRemoteServer = (input) => ipcRenderer.invoke('__remote-servers:test', input)
}
;(api as ElectronAPI).importAllDataFromLocalFile = (path: string) => ipcRenderer.invoke('data:importFromLocalFile', path)
;(api as ElectronAPI).testRemoteServerSftp = (profileId: string) => ipcRenderer.invoke('__sftp:test', profileId)
;(api as ElectronAPI).transferRemoteServerFile = (profileId, request) => ipcRenderer.invoke('__sftp:transfer-profile', profileId, request)
;(api as ElectronAPI).pickSftpUploadFile = async () => {
  const result = await ipcRenderer.invoke('__dialog:showOpenDialog', {
    title: 'Select file to upload',
    properties: ['openFile'],
    filters: [{ name: 'All Files', extensions: ['*'] }],
  })
  return result.canceled ? null : result.filePaths[0] ?? null
}
;(api as ElectronAPI).pickSftpDownloadDestination = async (defaultName?: string) => {
  const result = await ipcRenderer.invoke('__dialog:showSaveDialog', {
    title: 'Save downloaded file',
    ...(defaultName ? { defaultPath: defaultName } : {}),
    filters: [{ name: 'All Files', extensions: ['*'] }],
  })
  return result.canceled ? null : result.filePath ?? null
}
;(api as ElectronAPI).exportChatTranscript = (request) => ipcRenderer.invoke('__chat:export', request)

// These APIs describe or operate on the client application. Do not route them
// over WebSocket: a thin client has no embedded RPC server, and the remote
// server must never be asked to update or inspect this Electron installation.
;(api as ElectronAPI).getClientVersion = () => ipcRenderer.invoke('__client:get-version')
;(api as ElectronAPI).getSystemTheme = () => ipcRenderer.invoke('__client:get-system-theme')
;(api as ElectronAPI).isDebugMode = () => ipcRenderer.invoke('__client:is-debug-mode')
;(api as ElectronAPI).openFileDialog = () => ipcRenderer.invoke('__client:open-file-dialog')
;(api as ElectronAPI).pickStudioMindMapDirectory = (defaultPath?: string) => ipcRenderer.invoke('__studio:mindmap:pick-directory', defaultPath)
;(api as ElectronAPI).readStudioMindMapSession = (directory: string, id: string) => ipcRenderer.invoke('__studio:mindmap:read', directory, id)
;(api as ElectronAPI).writeStudioMindMapSession = (directory: string, id: string, data: string) => ipcRenderer.invoke('__studio:mindmap:write', directory, id, data)
;(api as ElectronAPI).deleteStudioMindMapSession = (directory: string, id: string) => ipcRenderer.invoke('__studio:mindmap:delete', directory, id)
;(api as ElectronAPI).getStudioMindMapWorkspaceContext = (directory: string) => ipcRenderer.invoke('__studio:mindmap:context', directory)
;(api as ElectronAPI).getUpdateInfo = () => ipcRenderer.invoke('__client:get-update-info')
;(api as ElectronAPI).checkForUpdates = () => ipcRenderer.invoke('__client:check-for-updates')
;(api as ElectronAPI).installUpdate = () => ipcRenderer.invoke('__client:install-update')
;(api as ElectronAPI).dismissUpdate = (version: string) => ipcRenderer.invoke('__client:dismiss-update', version)
;(api as ElectronAPI).getDismissedUpdateVersion = () => ipcRenderer.invoke('__client:get-dismissed-update')

contextBridge.exposeInMainWorld('electronAPI', api)

} // end if (!isPickerMode)
