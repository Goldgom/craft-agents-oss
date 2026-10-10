'use strict'
const { app, BrowserWindow, Menu, ipcMain, safeStorage, shell, dialog, nativeImage, nativeTheme } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
app.setName('TokenBird Win7 Local')
app.setPath('userData', path.join(app.getPath('appData'), 'TokenBird-Win7-Local'))
const lock = app.requestSingleInstanceLock()
const dataRoot = app.getPath('userData')
const runtime = path.join(__dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'runtime')
Object.assign(process.env, {
  TOKENBIRD_CONFIG_DIR: dataRoot, TOKENBIRD_WIN7_RUNTIME: runtime, TOKENBIRD_WIN7_PRELOAD: path.join(runtime, 'compat.cjs'),
  CRAFT_IS_PACKAGED: 'true', PI_OFFLINE: '1', PI_CODING_AGENT_DIR: path.join(dataRoot, 'pi'),
  OTEL_SDK_DISABLED: 'true', DO_NOT_TRACK: '1',
})
require(path.join(runtime, 'compat.cjs'))
const { readInstalledTools, applyInstalledToolEnvironment } = require('./installed-tools.cjs')
const installedTools = readInstalledTools(path.join(dataRoot, 'installed-tools.ini'))
applyInstalledToolEnvironment(installedTools)
let window, backend, assetServer, origin, desktop
const windows = new Map()
const basePath = '/' + randomBytes(24).toString('hex') + '/'
let stopping = false

function trusted(event, settingsOnly = false) {
  const frame = event.senderFrame
  if (!windows.has(event.sender.id) || frame !== event.sender.mainFrame) throw new Error('Untrusted frame')
  const url = new URL(frame.url)
  if (url.origin !== origin || !url.pathname.startsWith(basePath)) throw new Error('Untrusted origin')
  if (settingsOnly && url.pathname !== basePath + 'settings.html') throw new Error('Settings only')
}
async function external(url) {
  const value = new URL(url)
  if (!['https:', 'http:', 'mailto:'].includes(value.protocol) || value.username || value.password) throw new Error('Unsafe external URL')
  return shell.openExternal(value.href)
}
function startAssets() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.xml': 'application/xml', '.pdf': 'application/pdf' }
  assetServer = http.createServer((request, response) => {
    if (request.headers.host !== new URL(origin).host || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(403).end(); return }
    let pathname
    try { pathname = decodeURIComponent(new URL(request.url, origin).pathname) } catch { response.writeHead(400).end(); return }
    if (!pathname.startsWith(basePath)) { response.writeHead(404).end(); return }
    const relative = pathname.slice(basePath.length) || 'index.html'
    const assetRoot = path.join(__dirname, 'webui')
    const filename = path.resolve(assetRoot, relative)
    if (!filename.startsWith(assetRoot + path.sep)) { response.writeHead(403).end(); return }
    fs.stat(filename, (error, stat) => {
      if (error || !stat.isFile()) { response.writeHead(404).end(); return }
      response.writeHead(200, {
        'Content-Type': (types[path.extname(filename)] || 'application/octet-stream'), 'Content-Length': stat.size,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' ws: wss: https:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      })
      if (request.method === 'HEAD') response.end()
      else fs.createReadStream(filename).on('error', () => response.destroy()).pipe(response)
    })
  })
  return new Promise((resolve, reject) => {
    assetServer.once('error', reject)
    assetServer.listen(0, '127.0.0.1', () => { origin = 'http://127.0.0.1:' + assetServer.address().port; resolve() })
  })
}
ipcMain.handle('local:get-connection', event => { trusted(event); return { ...backend.connection, workspaceId: windows.get(event.sender.id).localWorkspace } })
ipcMain.handle('local:show-settings', event => { trusted(event); desktop.showSettings(windows.get(event.sender.id)) })
ipcMain.handle('local:open-external', (event, url) => { trusted(event); return external(url) })
function createWindow(workspaceId, sessionId) {
  backend.requireWorkspace(workspaceId)
  const win = new BrowserWindow({ width: 1280, height: 860, minWidth: 800, minHeight: 600,
    title: 'TokenBird', backgroundColor: '#f5f5f8', autoHideMenuBar: true,
    icon: path.join(__dirname, 'resources', 'icon.ico'), show: !process.argv.includes('--local-smoke-test'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  win.localWorkspace = workspaceId
  const id = win.webContents.id
  windows.set(id, win)
  win.on('closed', () => windows.delete(id))
  const isLocal = raw => {
    try { const url = new URL(raw); return url.origin === origin && url.pathname.startsWith(basePath) } catch { return false }
  }
  win.webContents.on('will-navigate', (event, url) => { if (!isLocal(url)) { event.preventDefault(); external(url).catch(error => console.warn(error.message)) } })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocal(url)) {
      const parsed = new URL(url)
      createWindow(parsed.searchParams.get('workspace') || win.localWorkspace, parsed.searchParams.get('session') || undefined)
    } else { try { external(url).catch(error => console.warn(error.message)) } catch (error) { console.warn(error.message) } }
    return { action: 'deny' }
  })
  win.webContents.on('will-attach-webview', event => event.preventDefault())
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  desktop.attach(win)
  const url = new URL(origin + basePath + 'index.html?embedded=win7')
  url.searchParams.set('workspace', workspaceId)
  if (sessionId) url.searchParams.set('session', sessionId)
  void win.loadURL(url.href)
  return win
}
async function start() {
  const nativeServices = require('./native-services.cjs')
  const image = input => typeof input === 'string' ? nativeImage.createFromPath(input) : nativeImage.createFromBuffer(input)
  const platform = {
    appRootPath: __dirname, resourcesPath: path.join(__dirname, 'resources'), isPackaged: true, appVersion: app.getVersion(),
    imageProcessor: {
      async getMetadata(buffer) { const value = image(buffer); return value.isEmpty() ? null : value.getSize() },
      async process(input, options = {}) {
        let value = image(input)
        if (value.isEmpty()) throw new Error('Unsupported image')
        if (options.resize) { const size = value.getSize(); const ratio = Math.min(options.resize.width / size.width, options.resize.height / size.height, 1); value = value.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)) }) }
        return options.format === 'jpeg' ? value.toJPEG(options.quality || 90) : value.toPNG()
      },
    },
    logger: { info: () => {}, debug: () => {}, warn: (...args) => console.warn(...args), error: (...args) => console.error(...args) },
    isDebugMode: false, systemDarkMode: () => nativeTheme.shouldUseDarkColors,
    captureError: error => console.error(error.message),
    openExternal: external,
    updateProxySettings: settings => nativeServices.updateConfiguredProxySettings(settings),
    openPath: async filename => {
      if (!path.isAbsolute(filename) || /^[\\/]{2}/.test(filename)) throw new Error('Expected local absolute path')
      const error = await shell.openPath(filename)
      if (error) throw new Error(error)
    },
    showItemInFolder: filename => {
      if (!path.isAbsolute(filename) || /^[\\/]{2}/.test(filename)) throw new Error('Expected local absolute path')
      shell.showItemInFolder(filename)
    },
  }
  const protection = {
    assertAvailable() { if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全凭据存储不可用；未写入 API Key') },
    wrapKey(key) { this.assertAvailable(); return safeStorage.encryptString(key.toString('base64')) },
    unwrapKey(key) { this.assertAvailable(); return Buffer.from(safeStorage.decryptString(key), 'base64') },
  }
  backend = await require('./backend.cjs').startLocalBackend(platform, protection, randomBytes(32).toString('hex'))
  nativeServices.importInstalledToolPaths(installedTools)
  nativeServices.applyRuntimeToolEnvironment()
  await nativeServices.applyConfiguredProxySettings()
  await startAssets()
  desktop = require('./native-host.cjs').installNativeHost({ trusted, backend, createWindow, external, dataRoot })
  window = createWindow(backend.connection.workspaceId)
}
if (!lock) app.quit()
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus() } })
  app.whenReady().then(start).catch(error => {
    console.error(error.stack)
    if (!process.argv.includes('--local-smoke-test')) dialog.showErrorBox('TokenBird Win7 Local', error.message)
    app.quit()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', event => {
    app.localQuitting = true
    if (stopping || !backend) return
    event.preventDefault(); stopping = true
    // Keep the loop alive while chat history and tool subprocesses are cleaned up.
    const deadline = setTimeout(() => app.exit(1), 15000)
    backend.instance.stop().finally(() => { clearTimeout(deadline); assetServer?.close(); app.exit(process.exitCode || 0) })
  })
}
