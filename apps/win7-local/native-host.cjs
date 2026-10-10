'use strict'
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeTheme, Notification, powerSaveBlocker, nativeImage } = require('electron')
const http = require('node:http')
const path = require('node:path')
const { randomBytes } = require('node:crypto')

function installNativeHost({ trusted, backend, createWindow, external, dataRoot }) {
  const callbacks = new Map()
  const services = require('./native-services.cjs')
  const notifications = new Set()
  let blocker, keepAwake = false
  const prefsFile = path.join(dataRoot, 'native-preferences.json')
  const fs = require('node:fs')
  try { keepAwake = JSON.parse(fs.readFileSync(prefsFile, 'utf8')).keepAwake === true } catch {}
  const setAwake = enabled => {
    if (blocker !== undefined && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker)
    blocker = enabled ? powerSaveBlocker.start('prevent-app-suspension') : undefined
    keepAwake = Boolean(enabled)
  }
  setAwake(keepAwake)
  const emit = (target, event, ...args) => {
    if (target && !target.isDestroyed()) target.webContents.send('desktop:event', event, ...args)
  }
  const focused = () => BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const localPath = value => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /^[\\/]{2}/.test(value) || value.includes('\0')) throw new Error('Expected a local absolute path')
    return value
  }
  const openOptions = spec => {
    spec = spec || {}
    const allowed = ['openFile', 'openDirectory', 'multiSelections', 'showHiddenFiles', 'createDirectory']
    return { title: typeof spec.title === 'string' ? spec.title : undefined,
      defaultPath: typeof spec.defaultPath === 'string' ? spec.defaultPath : undefined,
      filters: Array.isArray(spec.filters) ? spec.filters : undefined,
      properties: Array.isArray(spec.properties) ? spec.properties.filter(value => allowed.includes(value)) : ['openFile'] }
  }
  const updateInfo = () => ({ available: false, currentVersion: app.getVersion(), latestVersion: null,
    downloadState: 'idle', downloadProgress: 0, error: 'Win7 专用版不使用现代桌面自动更新，请手动安装 Win7 安装包。' })
  const handlers = {
    getClientVersion: () => app.getVersion(), getSystemTheme: () => nativeTheme.shouldUseDarkColors,
    getRuntimeTools: () => services.getRuntimeToolStatuses(),
    setRuntimeToolPath: (_win, tool, value) => {
      if (!['java', 'python', 'node'].includes(tool)) throw new Error('Unsupported runtime tool')
      return services.updateRuntimeToolPath(tool, value)
    },
    getWindowMode: win => win.localMode || 'main',
    setWindowWorkspace: (win, id) => { backend.requireWorkspace(id); win.localWorkspace = id },
    openWorkspace: (_win, id) => { const workspace = backend.requireWorkspace(id || backend.connection.workspaceId); createWindow(workspace.id) },
    openSessionInNewWindow: (_win, id, sessionId) => {
      backend.requireWorkspace(id)
      if (typeof sessionId !== 'string' || !/^[\w-]+$/.test(sessionId)) throw new Error('Invalid session ID')
      createWindow(id, sessionId)
    },
    openFileDialog: async win => { const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] }); return result.canceled ? [] : result.filePaths },
    openFolderDialog: async win => { const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); return result.canceled ? null : result.filePaths[0] },
    pickStudioMindMapDirectory: async (win, defaultPath) => { const result = await dialog.showOpenDialog(win, { title: '选择思维导图工作目录', defaultPath, properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0] },
    readStudioMindMapSession: (_win, directory, id) => services.readMindMapSession(localPath(directory), id),
    writeStudioMindMapSession: (_win, directory, id, data) => services.writeMindMapSession(localPath(directory), id, data),
    deleteStudioMindMapSession: (_win, directory, id) => services.deleteMindMapSession(localPath(directory), id),
    getStudioMindMapWorkspaceContext: (_win, directory) => services.mindMapWorkspaceContext(localPath(directory)),
    exportChatTranscript: (win, request) => services.exportChatTranscript(win, request),
    openTokenNestRecharge: (win, url, slug) => services.openTokenNestRechargeWindow(win, url, slug),
    'client:saveBlob': async (win, name, base64) => {
      if (typeof name !== 'string' || name.length > 240 || /[\\/<>:"|?*\x00-\x1f]/.test(name) || !name.trim()) throw new Error('Invalid export filename')
      if (typeof base64 !== 'string' || base64.length > 90_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Invalid or oversized export')
      const result = await dialog.showSaveDialog(win, { title: '保存导出文件', defaultPath: name })
      if (result.canceled || !result.filePath) return { canceled: true }
      const filename = localPath(result.filePath)
      await fs.promises.writeFile(filename, Buffer.from(base64, 'base64'))
      return { canceled: false, path: filename }
    },
    'client:openFileDialog': (win, spec) => dialog.showOpenDialog(win, openOptions(spec)),
    'client:saveFileDialog': (win, spec) => dialog.showSaveDialog(win, { title: spec?.title, defaultPath: spec?.defaultPath, filters: spec?.filters }),
    'client:openExternal': (_win, url) => external(url),
    'client:openPath': async (_win, value) => { const error = await shell.openPath(localPath(value)); if (error) throw new Error(error); return '' },
    'client:showInFolder': (_win, value) => shell.showItemInFolder(localPath(value)),
    'client:confirmDialog': async (win, spec) => {
      const result = await dialog.showMessageBox(win, { type: 'question', title: spec.title, message: spec.message,
        detail: spec.detail, buttons: spec.buttons || ['确认', '取消'], defaultId: spec.defaultId ?? 0, cancelId: spec.cancelId ?? 1 })
      return { response: result.response }
    },
    showLogoutConfirmation: async win => (await dialog.showMessageBox(win, { type: 'question', message: '确认退出登录？', buttons: ['取消', '退出登录'], defaultId: 0, cancelId: 0 })).response === 1,
    showDeleteSessionConfirmation: async (win, name) => (await dialog.showMessageBox(win, { type: 'warning', message: `删除会话“${String(name)}”？`, buttons: ['取消', '删除'], defaultId: 0, cancelId: 0 })).response === 1,
    closeWindow: win => win.close(),
    confirmCloseWindow: win => { win.localCloseConfirmed = true; win.close() },
    cancelCloseWindow: win => { clearTimeout(win.localCloseTimer); win.localCloseTimer = undefined },
    getWindowFocusState: win => win.isFocused(),
    menuQuit: () => app.quit(), menuMinimize: win => win.minimize(),
    menuMaximize: win => win.isMaximized() ? win.unmaximize() : win.maximize(),
    menuZoomIn: win => win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5),
    menuZoomOut: win => win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5),
    menuZoomReset: win => win.webContents.setZoomLevel(0), menuToggleDevTools: win => win.webContents.toggleDevTools(),
    getKeepAwakeWhileRunning: () => keepAwake,
    setKeepAwakeWhileRunning: (_win, value) => { setAwake(value); fs.writeFileSync(prefsFile, JSON.stringify({ keepAwake })) },
    refreshBadge: win => {
      const count = backend.instance.sessionManager.getUnreadSummary().totalUnreadSessions
      if (!count) win.setOverlayIcon(null, '')
      else emit(win, 'badgeDrawWindows', { count })
    },
    setDockIconWithBadge: (win, dataUrl) => {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/') || dataUrl.length > 1000000) throw new Error('Invalid badge image')
      win.setOverlayIcon(nativeImage.createFromDataURL(dataUrl), '未读消息')
    },
    showNotification: (win, title, body, workspaceId, sessionId) => {
      if (!backend.notificationsEnabled()) return
      if (!Notification.isSupported()) throw new Error('当前系统不支持桌面通知')
      const notification = new Notification({ title: String(title), body: String(body) })
      notifications.add(notification)
      notification.once('close', () => notifications.delete(notification))
      notification.once('click', () => {
        notifications.delete(notification)
        const target = !win.isDestroyed() && win.localWorkspace === workspaceId ? win : createWindow(workspaceId, sessionId)
        if (target.isMinimized()) target.restore()
        target.show(); target.focus()
        if (target === win) emit(target, 'notificationNavigate', { workspaceId, sessionId })
      })
      notification.show()
    },
    getUpdateInfo: updateInfo,
    relaunchApp: () => { app.relaunch(); app.quit() },
    'oauth:create': async (win, kind) => {
      if (!['source', 'chatgpt', 'tokennest'].includes(kind)) throw new Error('Invalid OAuth kind')
      if ([...callbacks.values()].some(item => item.owner === win.webContents.id)) throw new Error('已有登录正在进行，请完成或取消后重试')
      const id = randomBytes(24).toString('hex')
      const entry = { owner: win.webContents.id, state: null, resolve: null, reject: null }
      const callbackPath = kind === 'chatgpt' ? '/auth/callback' : '/callback'
      entry.server = http.createServer((req, res) => {
        const parsed = new URL(req.url, 'http://127.0.0.1')
        if (req.method !== 'GET' || parsed.pathname !== callbackPath || !entry.state || parsed.searchParams.get('state') !== entry.state) {
          res.writeHead(400).end('Invalid OAuth callback'); return
        }
        if (!entry.resolve) { res.writeHead(409).end('Callback already consumed'); return }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'" }).end('登录已完成，请返回 TokenBird。')
        entry.resolve(Object.fromEntries(parsed.searchParams)); entry.resolve = null
      })
      await new Promise((resolve, reject) => { entry.server.once('error', reject); entry.server.listen(kind === 'chatgpt' ? 1455 : 0, kind === 'chatgpt' ? 'localhost' : '127.0.0.1', resolve) })
      entry.timer = setTimeout(() => closeCallback(id, new Error('OAuth 登录超时')), 300000)
      callbacks.set(id, entry)
      return { id, url: `http://${kind === 'chatgpt' ? 'localhost' : '127.0.0.1'}:${entry.server.address().port}${callbackPath}` }
    },
    'oauth:wait': (win, id, state) => {
      const entry = callbacks.get(id)
      if (!entry || entry.owner !== win.webContents.id || entry.state || typeof state !== 'string' || !state) throw new Error('Invalid OAuth callback owner or state')
      entry.state = state
      return new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject })
    },
    'oauth:close': (win, id) => {
      const entry = callbacks.get(id)
      if (entry && entry.owner !== win.webContents.id) throw new Error('Invalid callback owner')
      closeCallback(id, new Error('OAuth 登录已取消'))
    },
  }
  function closeCallback(id, error) {
    const entry = callbacks.get(id)
    if (!entry) return
    callbacks.delete(id); clearTimeout(entry.timer); entry.server.close()
    if (entry.resolve && entry.reject) entry.reject(error)
  }
  for (const method of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) {
    handlers['menu' + method[0].toUpperCase() + method.slice(1)] = win => win.webContents[method]()
  }
  ipcMain.handle('desktop:invoke', (event, method, ...args) => {
    trusted(event)
    if (!Object.hasOwn(handlers, method)) throw new Error('Unknown desktop operation')
    return handlers[method](BrowserWindow.fromWebContents(event.sender), ...args)
  })
  nativeTheme.on('updated', () => BrowserWindow.getAllWindows().forEach(win => emit(win, 'systemTheme', nativeTheme.shouldUseDarkColors)))
  const command = event => () => emit(focused(), event)
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { label: '新建聊天', accelerator: 'Ctrl+N', click: command('menuNewChat') },
      { label: '新建窗口', accelerator: 'Ctrl+Shift+N', click: () => createWindow(focused()?.localWorkspace || backend.connection.workspaceId) },
      { label: '设置', accelerator: 'Ctrl+,', click: command('menuOpenSettings') },
      { label: '打开本地数据目录', click: () => shell.openPath(dataRoot) },
      { type: 'separator' }, { label: '关闭窗口', accelerator: 'Ctrl+W', click: () => { const win = focused(); if (win) { win.localCloseSource = 'keyboard-shortcut'; win.close() } } }, { role: 'quit' },
    ] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '查看', submenu: [
      { label: '侧边栏', click: command('menuToggleSidebar') }, { label: '专注模式', click: command('menuToggleFocusMode') },
      { label: '快捷键', click: command('menuKeyboardShortcuts') }, { type: 'separator' },
      { role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' },
    ] },
  ]))
  return {
    attach(win) {
      const owner = win.webContents.id
      win.on('focus', () => emit(win, 'windowFocus', true))
      win.on('blur', () => emit(win, 'windowFocus', false))
      win.on('close', event => {
        if (win.localCloseConfirmed || app.localQuitting) return
        event.preventDefault()
        if (win.localCloseTimer) return
        emit(win, 'closeRequested', { source: win.localCloseSource || 'window-button' })
        win.localCloseSource = undefined
        win.localCloseTimer = setTimeout(() => { win.localCloseConfirmed = true; win.close() }, 3000)
      })
      win.on('closed', () => {
        clearTimeout(win.localCloseTimer)
        for (const [id, entry] of callbacks) if (entry.owner === owner) closeCallback(id, new Error('Window closed'))
      })
    },
    showSettings(win) { emit(win, 'menuOpenSettings') },
  }
}
module.exports = { installNativeHost }
