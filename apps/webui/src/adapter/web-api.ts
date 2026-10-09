/**
 * Web API adapter — browser-compatible ElectronAPI implementation.
 *
 * Reuses the same WsRpcClient + buildClientApi() + CHANNEL_MAP from the Electron app.
 * Overrides LOCAL_ONLY methods (window management, native dialogs, etc.) with web equivalents.
 *
 * Auth: the browser's session cookie (set by /api/auth) is automatically sent
 * on the WebSocket upgrade request — no bearer token needed.
 */

import i18n from 'i18next'
import webuiPackage from '../../package.json'
import { canvasExportInfo } from '../../../electron/src/shared/canvas-export'
import { toast } from 'sonner'
import { openExternalUrl } from '@craft-agent/ui'
import { WsRpcClient } from '../../../electron/src/transport/client'
import { buildClientApi } from '../../../electron/src/transport/build-api'
import { CHANNEL_MAP } from '../../../electron/src/transport/channel-map'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { blobBase64, getPickedFile, pickedAttachment, saveBlob, webFilePicker } from './browser-files'
import { requestBrowserClientFiles } from './client-files'
import { pickServerDirectory } from './directory-picker'
import { exportWebChat } from './chat-export'
import type { ElectronAPI, TransportConnectionState } from '../../../electron/src/shared/types'
import {
  CLIENT_ANDROID_ADB,
  CLIENT_ANDROID_PERMISSION,
  CLIENT_CANVAS_INVOKE,
  CLIENT_REMOTE_ACCESS,
  CLIENT_REQUEST_FILES,
  type AndroidAdbRequest,
  type AndroidPermissionRequest,
} from '@craft-agent/server-core/transport'
import {
  invokeAndroidNative,
  parseAndroidJson,
  type AndroidPermissionSnapshot,
  type NetworkAdbConfig,
} from '../../../electron/src/shared/android-native'

// ---------------------------------------------------------------------------
// Web file picker (replaces native Electron dialog)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// System theme detection
// ---------------------------------------------------------------------------

const darkMediaQuery = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null

function getSystemTheme(): boolean {
  return darkMediaQuery?.matches ?? false
}

const TOKENNEST_OAUTH_CALLBACK_EVENT = 'craft-agent:tokennest-oauth-callback'
const TOKENNEST_OAUTH_TIMEOUT_MS = 5 * 60 * 1000

interface TokenNestOAuthCallback {
  code?: string | null
  state?: string | null
  error?: string | null
  error_description?: string | null
}

function waitForAndroidTokenNestCallback(
  expectedState: string,
  openBrowser: () => void,
): Promise<TokenNestOAuthCallback> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener(TOKENNEST_OAUTH_CALLBACK_EVENT, onCallback)
      reject(new Error('TokenNest sign-in timed out'))
    }, TOKENNEST_OAUTH_TIMEOUT_MS)

    const onCallback = (event: Event) => {
      const detail = (event as CustomEvent<TokenNestOAuthCallback>).detail
      // Ignore unrelated loopback requests. The RPC server performs the same
      // state and flow ownership checks before exchanging any authorization code.
      const nativeOpenError = !detail?.state
        && (detail?.error === 'browser_unavailable' || detail?.error === 'invalid_authorization_url')
      if (!nativeOpenError && detail?.state !== expectedState) return
      window.clearTimeout(timeout)
      window.removeEventListener(TOKENNEST_OAUTH_CALLBACK_EVENT, onCallback)
      resolve(detail ?? {})
    }

    window.addEventListener(TOKENNEST_OAUTH_CALLBACK_EVENT, onCallback)
    try {
      openBrowser()
    } catch (error) {
      window.clearTimeout(timeout)
      window.removeEventListener(TOKENNEST_OAUTH_CALLBACK_EVENT, onCallback)
      reject(error)
    }
  })
}

// ---------------------------------------------------------------------------
// Create web API
// ---------------------------------------------------------------------------

export interface WebApiOptions {
  /** WebSocket server URL (ws:// or wss://) */
  serverUrl: string
  /** Workspace ID to connect as. */
  workspaceId?: string
  /** Bearer token for embedded/mobile clients that do not have HTTP cookies. */
  token?: string
  /** Native Android's selected connection mode. Browser WebUI defaults to remote. */
  connectionMode?: 'local' | 'remote'
}

export function createWebApi(options: WebApiOptions): {
  api: ElectronAPI
  client: WsRpcClient
} {
  const { serverUrl, workspaceId, token, connectionMode } = options
  // The browser adapter has no native window manager to retain this value.
  // Keep it in sync locally so components mounted after the Android workspace
  // picker (such as the floating switcher) see the selected workspace.
  let activeWorkspaceId = workspaceId
  const androidBridge = window.CraftAgentAndroid
  const androidCapabilities = androidBridge
    ? [CLIENT_ANDROID_PERMISSION, CLIENT_ANDROID_ADB, CLIENT_CANVAS_INVOKE]
    : [CLIENT_CANVAS_INVOKE]

  const client = new WsRpcClient(serverUrl, {
    workspaceId,
    token,
    autoReconnect: true,
    mode: 'remote',
    clientCapabilities: [...androidCapabilities, CLIENT_REQUEST_FILES, ...(connectionMode === 'local' ? [] : [CLIENT_REMOTE_ACCESS])],
    // No token — auth is via session cookie sent on WebSocket upgrade
  })

  client.handleCapability(CLIENT_REQUEST_FILES, requestBrowserClientFiles)

  if (androidBridge) {
    client.handleCapability(CLIENT_ANDROID_PERMISSION, async (request: AndroidPermissionRequest) => {
      if (request.action === 'status') {
        return parseAndroidJson<AndroidPermissionSnapshot>(
          androidBridge.getPermissionSnapshot(),
          { permissions: [] },
        )
      }
      if (!request.permission) throw new Error('permission is required')
      return await invokeAndroidNative<AndroidPermissionSnapshot>(
        'craft-agent:android-permission-result',
        requestId => androidBridge.requestPermission(
          requestId,
          request.permission!,
          request.reason ?? 'AI needs this permission to complete the requested work.',
        ),
      )
    })

    client.handleCapability(CLIENT_ANDROID_ADB, async (request: AndroidAdbRequest) => {
      if (request.action === 'status') {
        return parseAndroidJson<NetworkAdbConfig>(androidBridge.getNetworkAdbConfig(), {
          enabled: false,
          host: '',
          port: 0,
          requiresSystemPairing: true,
        })
      }
      if (!request.command) throw new Error('command is required')
      return await invokeAndroidNative(
        'craft-agent:android-adb-result',
        requestId => androidBridge.runNetworkAdbCommand(
          requestId,
          request.command!,
          request.reason ?? 'AI requested this command to complete the current task.',
        ),
      )
    })
  }

  // Build the API proxy from the same channel map the Electron app uses
  const baseApi = buildClientApi(
    client,
    CHANNEL_MAP,
    (ch) => client.isChannelAvailable(ch),
  )

  let canvasHandler: ((input: Record<string, unknown>) => Promise<unknown>) | null = null
  client.handleCapability(CLIENT_CANVAS_INVOKE, async (request: Record<string, unknown>) => {
    if (!canvasHandler) throw new Error('画布正在加载，请稍后重试')
    const input = { ...request }
    if (input.action === 'import_image' && typeof input.imagePath === 'string') {
      const bytes = await baseApi.readFileBinary(input.imagePath)
      if (bytes.length > 30_000_000) throw new Error('图片超过 30 MB')
      input.imageBase64 = await blobBase64(new Blob([bytes as BlobPart]))
      input.imageName = input.imagePath.split(/[\\/]/).pop()
    }
    if (input.action === 'open_project' && typeof input.projectPath === 'string') input.projectText = await baseApi.readFile(input.projectPath)
    const result = await canvasHandler(input) as Record<string, unknown>
    if (['export_image', 'export_png', 'export_selection_mask', 'save_project', 'download_history', 'download_candidate'].includes(String(input.action)) && typeof result?.base64 === 'string') {
      const info = canvasExportInfo(input)
      const name = typeof input.outputPath === 'string' ? input.outputPath.split(/[\\/]/).pop()! : `TokenBird-canvas.${info.extension}`
      const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0))
      const saved = await saveBlob(new Blob([bytes], { type: info.mime }), name)
      return { saved: !saved.canceled, canceled: Boolean(saved.canceled), outputPath: saved.path, bytes: bytes.length }
    }
    return result
  })
  const downloadServerFile = async (path: string) => {
    const file = getPickedFile(path)
    const blob = file ?? new Blob([await baseApi.readFileBinary(path, { userInitiated: true }) as BlobPart], { type: 'application/octet-stream' })
    await saveBlob(blob, file?.name ?? path.split(/[\\/]/).pop() ?? 'TokenBird-file')
  }

  // Override LOCAL_ONLY methods with web-compatible implementations
  const webOverrides: Partial<ElectronAPI> = {
    // The shared studio mounts with chat. Browsers do not advertise native
    // canvas export, but must provide the subscription contract to mount.
    onStudioCanvasRequest: handler => { canvasHandler = handler; return () => { if (canvasHandler === handler) canvasHandler = null } },
    exportChatTranscript: exportWebChat,
    openTokenNestRecharge: (url: string) => {
      if (androidBridge) { openExternalUrl(url); return Promise.resolve() }
      const popup = window.open(url, 'tokennest-recharge', 'popup,width=1000,height=760')
      if (!popup) return Promise.reject(new Error('Please allow pop-ups to open TokenNest.'))
      popup.focus()
      return new Promise<void>(resolve => {
        const timer = window.setInterval(() => {
          if (popup.closed) { window.clearInterval(timer); resolve() }
        }, 1000)
      })
    },
    // Shell operations — use browser APIs
    openUrl: (url: string) => {
      const result = openExternalUrl(url)
      if (!result.opened) {
        if (result.reason === 'dangerous') {
          toast.error(`Blocked unsafe URL (${result.detail})`)
        } else if (result.reason === 'internal-deeplink') {
          console.warn('[openUrl] tokenbird:// deep links require the desktop app')
        } else {
          console.warn('[openUrl] Malformed URL:', url)
        }
      }
      return Promise.resolve()
    },
    openFile: downloadServerFile,
    showInFolder: async path => { await pickServerDirectory(path.replace(/[\\/][^\\/]+$/, '')) },

    // File dialogs
    openFileDialog: () => webFilePicker(),
    getFilePath: () => null, // browser File bytes are handled by the attachment input
    openFolderDialog: () => pickServerDirectory(),
    pickStudioMindMapDirectory: pickServerDirectory,
    readFile: (path, options) => getPickedFile(path)?.text() ?? baseApi.readFile(path, options),
    readFileBinary: async (path, options) => getPickedFile(path) ? new Uint8Array(await getPickedFile(path)!.arrayBuffer()) : baseApi.readFileBinary(path, options),
    readFileAttachment: path => getPickedFile(path) ? pickedAttachment(path) : baseApi.readFileAttachment(path),
    readUserAttachment: path => getPickedFile(path) ? pickedAttachment(path) : baseApi.readUserAttachment(path),
    readFileDataUrl: async (path, options) => getPickedFile(path) ? `data:${getPickedFile(path)!.type};base64,${await blobBase64(getPickedFile(path)!)}` : baseApi.readFileDataUrl(path, options),
    exportAllData: async () => {
      const result = await client.invoke(RPC_CHANNELS.settings.EXPORT_ALL_DATA_BUNDLE)
      if (!result.success) return result
      const binary = Uint8Array.from(atob(result.bundleBase64), char => char.charCodeAt(0))
      const saved = await saveBlob(new Blob([binary], { type: 'application/zip' }), result.fileName)
      const { bundleBase64: _bundle, ...metadata } = result
      return { ...metadata, success: !saved.canceled, canceled: Boolean(saved.canceled), destPath: saved.path }
    },
    importAllData: async () => {
      const paths = await webFilePicker('.zip')
      if (!paths[0]) return { canceled: true }
      return webOverrides.importAllDataFromLocalFile!(paths[0])
    },
    importAllDataFromLocalFile: async path => {
      const file = getPickedFile(path)
      if (!file) throw new Error('请重新选择这台设备上的备份文件')
      if (file.size > 50 * 1024 * 1024) throw new Error('备份超过 50 MB，请在服务器端导入')
      return client.invoke(RPC_CHANNELS.settings.IMPORT_ALL_DATA_FROM_PAYLOAD, { bundleBase64: await blobBase64(file), fileName: 'backup.zip' })
    },
    changeLanguage: async language => {
      await i18n.changeLanguage(language)
      window.CraftAgentAndroid?.setLanguage?.(language)
    },

    // System info
    getClientVersion: () => Promise.resolve(webuiPackage.version),
    getVersions: () => ({ node: 'n/a', chrome: navigator.userAgent, electron: 'web' }),
    getRuntimeEnvironment: () => 'web',
    getStartupContext: () => Promise.resolve({
      mode: connectionMode ?? 'remote',
      ...(connectionMode === 'remote' ? { serverUrl } : {}),
    }),
    getSystemWarnings: () => Promise.resolve({ vcredistMissing: false }),
    isDebugMode: () => Promise.resolve(import.meta.env.DEV),

    // Theme
    getSystemTheme: () => Promise.resolve(getSystemTheme()),
    onSystemThemeChange: (cb: (isDark: boolean) => void) => {
      if (!darkMediaQuery) return () => {}
      const handler = (e: MediaQueryListEvent) => cb(e.matches)
      darkMediaQuery.addEventListener('change', handler)
      return () => darkMediaQuery.removeEventListener('change', handler)
    },

    // Window management — no-ops or browser equivalents
    setTrafficLightsVisible: () => Promise.resolve(),
    closeWindow: () => Promise.resolve(),
    confirmCloseWindow: () => Promise.resolve(),
    cancelCloseWindow: () => Promise.resolve(),
    onCloseRequested: () => () => {},
    getWindowFocusState: () => Promise.resolve(document.hasFocus()),
    onWindowFocusChange: (cb: (focused: boolean) => void) => {
      const onFocus = () => cb(true)
      const onBlur = () => cb(false)
      window.addEventListener('focus', onFocus)
      window.addEventListener('blur', onBlur)
      return () => {
        window.removeEventListener('focus', onFocus)
        window.removeEventListener('blur', onBlur)
      }
    },

    // Workspace operations — web UI works with a single connection
    getWindowWorkspace: () => Promise.resolve(activeWorkspaceId ?? null),
    getWindowMode: () => Promise.resolve('main'),
    // switchWorkspace must call the server so it registers the client's
    // workspaceId — otherwise push events (session updates) won't arrive.
    switchWorkspace: async (wsId: string) => {
      await client.invoke('window:switchWorkspace', wsId)
      activeWorkspaceId = wsId
    },
    openWorkspace: async wsId => {
      await webOverrides.switchWorkspace!(wsId)
      const url = new URL(window.location.href); url.searchParams.set('workspace', wsId)
      for (const key of ['route', 'panels', 'session', 'sessionId']) url.searchParams.delete(key)
      window.location.assign(url.toString())
    },
    openSessionInNewWindow: async (_wsId: string, sessionId: string) => {
      // Open in new tab
      window.open(`${window.location.origin}/?session=${sessionId}`, '_blank')
    },

    // Auto-update — not applicable to web (but expose server version for About page)
    checkForUpdates: () => Promise.resolve({ available: false, currentVersion: client.getServerVersion() ?? '' } as any),
    getUpdateInfo: () => Promise.resolve({ available: false, currentVersion: client.getServerVersion() ?? '' } as any),
    installUpdate: () => Promise.resolve(),
    dismissUpdate: () => Promise.resolve(),
    getDismissedUpdateVersion: () => Promise.resolve(null),
    onUpdateAvailable: () => () => {},
    onUpdateDownloadProgress: () => () => {},
    // Menu events — register as keyboard shortcuts
    onMenuNewChat: () => () => {},
    onMenuOpenSettings: () => () => {},
    onMenuKeyboardShortcuts: () => () => {},
    onMenuToggleFocusMode: () => () => {},
    onMenuToggleSidebar: () => () => {},
    onDeepLinkNavigate: () => () => {},

    // Menu actions — no-ops (web has no native menu)
    menuQuit: () => Promise.resolve(),
    menuNewWindow: () => { window.open(window.location.href, '_blank'); return Promise.resolve() },
    menuMinimize: () => Promise.resolve(),
    menuMaximize: () => Promise.resolve(),
    menuZoomIn: () => Promise.resolve(),
    menuZoomOut: () => Promise.resolve(),
    menuZoomReset: () => Promise.resolve(),
    menuToggleDevTools: () => Promise.resolve(),
    menuUndo: () => { document.execCommand('undo'); return Promise.resolve() },
    menuRedo: () => { document.execCommand('redo'); return Promise.resolve() },
    menuCut: () => { document.execCommand('cut'); return Promise.resolve() },
    menuCopy: () => { document.execCommand('copy'); return Promise.resolve() },
    menuPaste: () => { document.execCommand('paste'); return Promise.resolve() },
    menuSelectAll: () => { document.execCommand('selectAll'); return Promise.resolve() },

    // Badge — use document title
    refreshBadge: () => Promise.resolve(),
    setDockIconWithBadge: () => Promise.resolve(),
    onBadgeDraw: () => () => {},
    onBadgeDrawWindows: () => () => {},

    // Notifications — Web Notifications API
    showNotification: async (title: string, body: string, _workspaceId: string, sessionId: string) => {
      if (androidBridge?.showNotification) { androidBridge.showNotification(title, body, sessionId); return }
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body })
      }
    },
    onNotificationNavigate: cb => {
      const handler = (event: Event) => cb((event as CustomEvent).detail)
      window.addEventListener('craft-agent:notification-navigate', handler)
      const sessionId = androidBridge?.takeNotificationSession?.()
      if (sessionId) queueMicrotask(() => cb({ workspaceId: activeWorkspaceId ?? '', sessionId }))
      return () => window.removeEventListener('craft-agent:notification-navigate', handler)
    },

    // Git bash (Windows-only) — not applicable
    checkGitBash: () => Promise.resolve({ available: true } as any),
    browseForGitBash: () => Promise.resolve(null),
    setGitBashPath: () => Promise.resolve({ success: true }),

    // Skills — open in browser not possible
    openSkillInEditor: async (wsId, slug) => { const skills = await baseApi.getSkills(wsId); const skill = skills.find(item => item.slug === slug); if (skill) await downloadServerFile(`${skill.path}/SKILL.md`) },
    openSkillInFinder: async (wsId, slug) => { const skills = await baseApi.getSkills(wsId); const skill = skills.find(item => item.slug === slug); if (skill) await pickServerDirectory(skill.path) },

    // Confirmation dialogs — use browser confirm()
    showLogoutConfirmation: () => Promise.resolve(window.confirm(i18n.t('dialog.logoutConfirmation'))),
    showDeleteSessionConfirmation: (name: string) => Promise.resolve(window.confirm(i18n.t('dialog.deleteSessionConfirmation', { name }))),

    // Power settings — not applicable
    getKeepAwakeWhileRunning: () => Promise.resolve(androidBridge?.getKeepAwake?.() ?? false),
    setKeepAwakeWhileRunning: async enabled => { androidBridge?.setKeepAwake?.(enabled) },

    // Transport state
    getTransportConnectionState: () => Promise.resolve(client.getConnectionState() as TransportConnectionState),
    onTransportConnectionStateChanged: (cb: (state: TransportConnectionState) => void) => {
      return client.onConnectionStateChanged(cb as any)
    },
    reconnectTransport: () => { client.reconnectNow(); return Promise.resolve() },
    isChannelAvailable: (ch: string) => (Boolean(androidBridge?.showNotification) && ch === RPC_CHANNELS.notification.SHOW) || client.isChannelAvailable(ch),

    // Relaunch — reload page
    relaunchApp: () => { window.location.reload(); return Promise.resolve() },
    removeWorkspace: async () => { throw new Error('安卓尚未提供工作区移除流程，请在服务器或桌面端管理') },
    getNativeCredentialStatus: async () => ({ ok: false, code: 'VAULT_NATIVE_ONLY', message: '安卓使用模型与数据源配置管理凭据；Windows 原生凭据库仅在桌面端可用。' }),
    listNativeCredentials: async () => ({ ok: false, code: 'VAULT_NATIVE_ONLY', message: '请在模型与数据源配置中管理凭据。' }),
    applyNativeCredentialChanges: async () => ({ ok: false, code: 'VAULT_NATIVE_ONLY', message: 'Windows 原生凭据库不可在安卓修改。' }),
    migrateNativeCredentials: async () => ({ ok: false, code: 'VAULT_NATIVE_ONLY', message: '请在 Windows 端迁移原生凭据。' }),
    getStartupLocation: async () => connectionMode ?? 'local',
    setStartupLocation: async () => { throw new Error('请从安卓菜单的连接方式设置启动服务器') },
    switchServer: async () => { androidBridge?.configureServer(); return { success: false } },
    selectStartupServer: async () => { androidBridge?.configureServer(); return { success: false } },
    onTransferProgress: () => () => {},
    transferSessionToWorkspace: async (sessionId, targetWorkspaceId) => {
      const bundle = await baseApi.exportSession(sessionId)
      return baseApi.importSession(targetWorkspaceId, bundle, 'move')
    },
    testRemoteServerSftp: async () => ({ ok: false, error: '安卓尚未提供 SFTP 客户端，请使用服务器文件操作' }),
    transferRemoteServerFile: async () => { throw new Error('安卓尚未提供 SFTP 客户端，请使用服务器文件操作') },
    pickSftpUploadFile: async () => { throw new Error('安卓尚未提供 SFTP 客户端') },
    pickSftpDownloadDestination: async () => { throw new Error('安卓尚未提供 SFTP 客户端') },
    invokeOnServer: () => Promise.reject(new Error('Cross-server RPC not available in web UI')),
    listRemoteCollaborationWorkspaces: () => Promise.reject(new Error('Saved server selection requires the desktop app')),
    listRemoteCollaborationCandidates: () => Promise.reject(new Error('Saved server selection requires the desktop app')),
    createRemoteCollaboration: () => Promise.reject(new Error('Saved server selection requires the desktop app')),
    openRemoteCollaborationWorkspace: () => Promise.reject(new Error('Saved server selection requires the desktop app')),
  }

  // OAuth overrides — web-compatible browser opening
  // The Electron preload uses shell.openExternal() which isn't available in browsers.
  const oauthOverrides: Partial<ElectronAPI> = {
    // Generic source OAuth — server prepares the flow, we open the auth URL in a new tab.
    // The OAuth provider redirects through the relay to our server's /api/oauth/callback,
    // which completes the token exchange and pushes status via WebSocket.
    performOAuth: async (args: {
      sourceSlug: string
      sessionId?: string
      authRequestId?: string
    }) => {
      // iOS Safari (and any strict mobile pop-up blocker) requires
      // `window.open()` to be called *synchronously* inside the click event
      // — any preceding `await` loses the user-gesture and the call is
      // silently blocked. We pre-open a blank tab here as the first thing
      // in this async function (which still runs on the click tick, before
      // the first await) and rewrite its `location.href` once the auth URL
      // arrives. Same-window fallback covers users who blocked popups
      // entirely. NOTE: dropped `noopener` because the spec returns null
      // for `noopener` opens in some browsers, defeating the pre-open.
      const popup = window.open('about:blank', '_blank')

      try {
        const callbackUrl = `${window.location.origin}/api/oauth/callback`
        const result = await client.invoke('oauth:start', {
          sourceSlug: args.sourceSlug,
          callbackUrl,
          sessionId: args.sessionId,
          authRequestId: args.authRequestId,
        })

        if (popup && !popup.closed) {
          // Happy path — pre-opened popup is still open, redirect it.
          popup.location.href = result.authUrl
        } else if (popup === null) {
          // Popup blocked entirely (popup === null) — fall back to a
          // same-window redirect. The OAuth callback lands back on the
          // WebUI; cookie-based session means the user picks up where
          // they left off after auth.
          window.location.href = result.authUrl
        } else {
          // Popup was opened but the user closed it while we waited for
          // the RPC. Abort rather than redirecting their main tab.
          return {
            success: false,
            error: 'Sign-in window was closed before authentication started.',
          }
        }

        // The server completes the flow when the callback arrives and pushes
        // auth status via WebSocket — the AuthRequestCard updates automatically.
        return { success: true }
      } catch (err) {
        if (popup && !popup.closed) popup.close()
        return {
          success: false,
          error: err instanceof Error ? err.message : 'OAuth flow failed',
        }
      }
    },

    // Claude OAuth — server returns authUrl, we open it in a new tab.
    // Same iOS-safe pre-open pattern as `performOAuth` above.
    startClaudeOAuth: async () => {
      const popup = window.open('about:blank', '_blank')
      try {
        const result = await client.invoke('onboarding:startClaudeOAuth')
        if (result.success && result.authUrl) {
          if (popup && !popup.closed) {
            popup.location.href = result.authUrl
          } else {
            window.location.href = result.authUrl
          }
        } else if (popup && !popup.closed) {
          // No auth URL — close the placeholder we opened on the click.
          popup.close()
        }
        return result
      } catch (err) {
        if (popup && !popup.closed) popup.close()
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Claude OAuth failed',
        }
      }
    },

    // ChatGPT OAuth — requires localhost callback server, not possible in browser
    startChatGptOAuth: async () => {
      return {
        success: false,
        error: i18n.t('errors.chatGptOAuthNotAvailable'),
      }
    },
    // Android owns a loopback HTTP server for bundled WebUI assets. Reuse it
    // as the RFC 8252 callback listener and send the result back to this
    // WebView, while PKCE material and token exchange stay on the agent server.
    startTokenNestOAuth: async (connectionSlug = 'tokennest') => {
      const bridge = window.CraftAgentAndroid
      if (!bridge) {
        return { success: false, error: 'TokenNest sign-in requires the TokenBird Android app or desktop app.' }
      }

      let flowId: string | undefined
      let state: string | undefined
      try {
        const callbackUrl = bridge.getOAuthCallbackUrl()
        if (!callbackUrl) throw new Error('Android OAuth callback server is unavailable')
        const started = await client.invoke('tokennest:startOAuth', { connectionSlug, callbackUrl })
        flowId = started.flowId
        const expectedState = started.state
        state = expectedState

        const callback = await waitForAndroidTokenNestCallback(
          expectedState,
          () => bridge.openTokenNestOAuth(started.authUrl),
        )
        if (!callback.state || callback.state !== expectedState) {
          throw new Error('TokenNest OAuth state mismatch')
        }
        if (callback.error) {
          throw new Error(callback.error_description || callback.error)
        }
        if (!callback.code) throw new Error('No authorization code received')

        return await client.invoke('tokennest:completeOAuth', {
          flowId,
          state: expectedState,
          code: callback.code,
        })
      } catch (error) {
        if (flowId && state) {
          client.invoke('tokennest:cancelOAuth', { flowId, state }).catch(() => {})
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : 'TokenNest OAuth failed',
        }
      }
    },
  }

  const api = { ...baseApi, ...webOverrides, ...oauthOverrides } as ElectronAPI

  return { api, client }
}
