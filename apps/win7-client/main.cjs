'use strict'

const { app, BrowserWindow, Menu, ipcMain, safeStorage, shell, dialog } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { normalizeConnection } = require('./connection.cjs')

// Separate storage, updater identity and installer from the regular desktop app.
app.setName('TokenBird Win7 Remote')
app.setPath('userData', path.join(app.getPath('appData'), 'TokenBird-Win7-Remote'))
const singleInstance = app.requestSingleInstanceLock()
let window
let server
let origin
let basePath
let connection = {}
let rememberToken = false
const profilePath = path.join(app.getPath('userData'), 'connection.json')

function readProfile() {
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'))
    connection = normalizeConnection(profile)
    if (profile.encryptedToken && safeStorage.isEncryptionAvailable()) {
      connection.token = safeStorage.decryptString(Buffer.from(profile.encryptedToken, 'base64'))
      rememberToken = true
    }
  } catch { connection = {} }
}

function assertTrusted(event, settingsOnly = false) {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame) throw new Error('Untrusted frame')
  if (!window || event.sender !== window.webContents) throw new Error('Untrusted window')
  const url = new URL(frame.url)
  if (url.origin !== origin || !url.pathname.startsWith(basePath)) throw new Error('Untrusted origin')
  if (settingsOnly && url.pathname !== basePath + 'settings.html') throw new Error('Settings only')
}

function settings() { return window.loadURL(origin + basePath + 'settings.html') }

function openExternal(url) {
  try {
    const parsed = new URL(url)
    if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) return Promise.resolve()
    return shell.openExternal(parsed.href)
  } catch { return Promise.resolve() }
}

function makeWindow() {
  window = new BrowserWindow({
    width: 1280, height: 860, minWidth: 800, minHeight: 600,
    title: 'TokenBird Win7 Remote', backgroundColor: '#f5f5f8',
    show: !process.argv.includes('--remote-smoke-test'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false,
    },
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin + basePath)) { event.preventDefault(); void openExternal(url) }
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(origin + basePath)) {
      void window.loadURL(url)
    } else { void openExternal(url) }
    return { action: 'deny' }
  })
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '客户端', submenu: [
      { label: '服务器设置', accelerator: 'Ctrl+Shift+S', click: () => void settings() },
      { label: '重新加载', role: 'reload' },
      { type: 'separator' }, { label: '退出', role: 'quit' },
    ] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '查看', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, { label: '诊断工具', role: 'toggleDevTools' }] },
  ]))
  return settings()
}

function startAssetServer() {
  // No remote proxy or local Agent: this only serves the bundled UI.
  // Random URL capability + exact Host checks prevent other websites from
  // reaching privileged pages via DNS rebinding or a predictable loopback URL.
  basePath = '/' + randomBytes(24).toString('hex') + '/'
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.xml': 'application/xml', '.pdf': 'application/pdf' }
  server = http.createServer((request, response) => {
    if (request.headers.host !== new URL(origin).host || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(403).end(); return
    }
    let pathname
    try { pathname = decodeURIComponent(new URL(request.url, origin).pathname) } catch { response.writeHead(400).end(); return }
    if (!pathname.startsWith(basePath)) { response.writeHead(404).end(); return }
    const relative = pathname.slice(basePath.length) || 'index.html'
    const settingsFile = ['settings.html', 'settings.js', 'settings.css'].includes(relative)
    const assetRoot = settingsFile ? __dirname : path.join(__dirname, 'webui')
    const filename = path.resolve(assetRoot, relative)
    if (!filename.startsWith(assetRoot + path.sep)) { response.writeHead(403).end(); return }
    fs.stat(filename, (error, stat) => {
      if (error || !stat.isFile()) { response.writeHead(404).end(); return }
      response.writeHead(200, {
        'Content-Type': (mime[path.extname(filename)] || 'application/octet-stream') + (['.html', '.js', '.css', '.json'].includes(path.extname(filename)) ? '; charset=utf-8' : ''),
        'Content-Length': stat.size,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' ws: wss: https:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
      })
      if (request.method === 'HEAD') response.end()
      else fs.createReadStream(filename).on('error', () => response.destroy()).pipe(response)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      origin = 'http://127.0.0.1:' + server.address().port
      resolve()
    })
  })
}

ipcMain.handle('remote:get-connection', event => { assertTrusted(event); return { ...connection, rememberToken } })
ipcMain.handle('remote:configure', event => { assertTrusted(event); void settings() })
ipcMain.handle('remote:open-external', (event, url) => { assertTrusted(event); return openExternal(url) })
ipcMain.handle('remote:connect', async (event, input) => {
  assertTrusted(event, true)
  const next = normalizeConnection(input)
  if (input.rememberToken && next.token && !safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统无法安全保存令牌，请取消“记住令牌”后连接')
  }
  const profile = { serverUrl: next.serverUrl, workspaceId: next.workspaceId }
  if (input.rememberToken && next.token) profile.encryptedToken = safeStorage.encryptString(next.token).toString('base64')
  fs.mkdirSync(path.dirname(profilePath), { recursive: true })
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), { mode: 0o600 })
  connection = next
  rememberToken = Boolean(input.rememberToken)
  // Delay navigation until ipcRenderer.invoke has received its response.
  setImmediate(() => void window.loadURL(origin + basePath + 'index.html?embedded=win7'))
})

if (!singleInstance) app.quit()
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus() } })
  app.whenReady().then(async () => { readProfile(); await startAssetServer(); await makeWindow() }).catch(error => {
    dialog.showErrorBox('TokenBird Win7 Remote', error.message)
    app.quit()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => { if (server) server.close() })
}
