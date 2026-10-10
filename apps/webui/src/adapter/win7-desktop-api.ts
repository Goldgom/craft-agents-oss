/** Desktop-only compatibility bridge. The original React UI is unchanged. */
import type { ElectronAPI } from '../../../electron/src/shared/types'
import type { WsRpcClient } from '../../../electron/src/transport/client'
import { toast } from 'sonner'

export const WIN7_DESKTOP_CAPABILITIES = [
  'client:openExternal', 'client:openPath', 'client:showInFolder',
  'client:confirmDialog', 'client:openFileDialog', 'client:saveFileDialog',
]

export function createWin7DesktopApi(base: ElectronAPI, client: WsRpcClient, workspaceId?: string): Partial<ElectronAPI> {
  const bridge = window.TokenBirdDesktop!
  const native = (method: string) => (...args: any[]) => bridge.invoke(method, ...args)
  const on = (event: string) => (callback: (...args: any[]) => void) => bridge.on(event, callback)
  let activeWorkspace = workspaceId
  for (const capability of WIN7_DESKTOP_CAPABILITIES) {
    client.handleCapability(capability, (...args: any[]) => bridge.invoke(capability, ...args))
  }
  const unsupported = async (feature: string): Promise<never> => {
    const message = `Win7 兼容版暂不支持${feature}。`
    toast.error(message)
    throw new Error(message)
  }
  const oauth = async (kind: 'source' | 'chatgpt' | 'tokennest', args: any) => {
    let callbackId: string | undefined
    let flowId: string | undefined
    let state: string | undefined
    const prefix = kind === 'source' ? 'oauth' : kind
    const cancel = kind === 'source' ? 'oauth:cancel' : `${prefix}:cancelOAuth`
    try {
      const callback = await bridge.invoke('oauth:create', kind)
      callbackId = callback.id
      const started = await client.invoke(kind === 'source' ? 'oauth:start' : `${prefix}:startOAuth`,
        kind === 'chatgpt' ? args : { ...args, callbackUrl: callback.url })
      flowId = started.flowId
      state = started.state
      const pending = bridge.invoke('oauth:wait', callbackId, state)
      // Attach rejection immediately, even if browser opening fails.
      pending.catch(() => {})
      await bridge.invoke('client:openExternal', started.authUrl)
      const query = await pending
      if (query.error) throw new Error(query.error_description || query.error)
      if (!query.code) throw new Error('No authorization code received')
      return await client.invoke(kind === 'source' ? 'oauth:complete' : `${prefix}:completeOAuth`, { flowId, state, code: query.code })
    } catch (error) {
      if (state) await client.invoke(cancel, { flowId, state }).catch(() => {})
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (callbackId) await bridge.invoke('oauth:close', callbackId).catch(() => {})
    }
  }
  return {
    openUrl: base.openUrl, openFile: base.openFile, showInFolder: base.showInFolder,
    openFileDialog: native('openFileDialog'), openFolderDialog: native('openFolderDialog'),
    pickStudioMindMapDirectory: native('pickStudioMindMapDirectory'),
    readStudioMindMapSession: native('readStudioMindMapSession'), writeStudioMindMapSession: native('writeStudioMindMapSession'),
    deleteStudioMindMapSession: native('deleteStudioMindMapSession'), getStudioMindMapWorkspaceContext: native('getStudioMindMapWorkspaceContext'),
    exportChatTranscript: native('exportChatTranscript'),
    openTokenNestRecharge: native('openTokenNestRecharge'),
    getRuntimeTools: native('getRuntimeTools'), setRuntimeToolPath: native('setRuntimeToolPath'),
    importAllDataFromLocalFile: filename => base.importAllDataFromPath(filename),
    getFilePath: file => bridge.getFilePath(file),
    getVersions: () => bridge.versions, getRuntimeEnvironment: () => 'electron',
    getClientVersion: native('getClientVersion'),
    getStartupContext: async () => ({ mode: 'local' }),
    getStartupLocation: async () => 'local',
    setStartupLocation: async target => target === 'local' ? { success: true } : unsupported('切换远程启动服务'),
    switchServer: async target => target === 'local' ? { success: true } : unsupported('切换远程启动服务'),
    selectStartupServer: async target => target === 'local' ? { success: true } : unsupported('切换远程启动服务'),
    getSystemTheme: native('getSystemTheme'), onSystemThemeChange: on('systemTheme'),
    isDebugMode: async () => false,
    getWindowWorkspace: () => base.getWindowWorkspace(),
    getWindowMode: native('getWindowMode'),
    switchWorkspace: async id => {
      await base.switchWorkspace(id)
      activeWorkspace = id
      await bridge.invoke('setWindowWorkspace', id)
    },
    openWorkspace: native('openWorkspace'), openSessionInNewWindow: native('openSessionInNewWindow'),
    closeWindow: native('closeWindow'), confirmCloseWindow: native('confirmCloseWindow'),
    cancelCloseWindow: native('cancelCloseWindow'), onCloseRequested: on('closeRequested'),
    getWindowFocusState: native('getWindowFocusState'), onWindowFocusChange: on('windowFocus'),
    checkGitBash: base.checkGitBash, browseForGitBash: base.browseForGitBash, setGitBashPath: base.setGitBashPath,
    openSkillInEditor: base.openSkillInEditor, openSkillInFinder: base.openSkillInFinder,
    showNotification: native('showNotification'), onNotificationNavigate: on('notificationNavigate'),
    showLogoutConfirmation: native('showLogoutConfirmation'),
    showDeleteSessionConfirmation: native('showDeleteSessionConfirmation'),
    onMenuNewChat: on('menuNewChat'), onMenuOpenSettings: on('menuOpenSettings'),
    onMenuKeyboardShortcuts: on('menuKeyboardShortcuts'), onMenuToggleFocusMode: on('menuToggleFocusMode'),
    onMenuToggleSidebar: on('menuToggleSidebar'),
    onDeepLinkNavigate: callback => {
      const rpcCleanup = base.onDeepLinkNavigate(callback)
      const nativeCleanup = bridge.on('deepLinkNavigate', callback)
      return () => { rpcCleanup(); nativeCleanup() }
    },
    menuQuit: native('menuQuit'), menuNewWindow: () => bridge.invoke('openWorkspace', activeWorkspace),
    menuMinimize: native('menuMinimize'), menuMaximize: native('menuMaximize'),
    menuZoomIn: native('menuZoomIn'), menuZoomOut: native('menuZoomOut'), menuZoomReset: native('menuZoomReset'),
    menuToggleDevTools: native('menuToggleDevTools'), menuUndo: native('menuUndo'), menuRedo: native('menuRedo'),
    menuCut: native('menuCut'), menuCopy: native('menuCopy'), menuPaste: native('menuPaste'), menuSelectAll: native('menuSelectAll'),
    refreshBadge: native('refreshBadge'), setDockIconWithBadge: native('setDockIconWithBadge'),
    onBadgeDrawWindows: on('badgeDrawWindows'),
    getKeepAwakeWhileRunning: native('getKeepAwakeWhileRunning'), setKeepAwakeWhileRunning: native('setKeepAwakeWhileRunning'),
    removeWorkspace: id => base.deleteServerWorkspace(id),
    relaunchApp: native('relaunchApp'),
    checkForUpdates: native('getUpdateInfo'), getUpdateInfo: native('getUpdateInfo'),
    installUpdate: () => unsupported('自动升级；请手动安装 Win7 专用安装包'),
    performOAuth: args => oauth('source', args),
    startChatGptOAuth: slug => oauth('chatgpt', slug),
    startTokenNestOAuth: (slug = 'tokennest') => oauth('tokennest', { connectionSlug: slug }),
    startClaudeOAuth: async () => ({ success: false, error: '当前 Claude Code 原生后端不支持 Win7。请使用 API Key；Claude 模型会由本地 Pi 兼容后端运行。' }),
    listRemoteCollaborationWorkspaces: () => unsupported('跨服务器协作'),
    listRemoteCollaborationCandidates: () => unsupported('跨服务器协作'),
    createRemoteCollaboration: () => unsupported('跨服务器协作'),
    openRemoteCollaborationWorkspace: () => unsupported('跨服务器协作'),
  }
}
