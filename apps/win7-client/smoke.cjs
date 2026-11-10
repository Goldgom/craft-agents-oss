// Run with Electron 22: electron.exe apps/win7-client/smoke.cjs --remote-smoke-test
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { WebSocketServer } = require('ws')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenbird-win7-smoke-'))
app.setPath('appData', temp)
app.commandLine.appendSwitch('disable-gpu')
const errors = []
const requests = new Set()
const token = 'win7-smoke-test-token-not-a-real-secret'
let handshake = false
const mock = new WebSocketServer({ host: '127.0.0.1', port: 0 })
mock.on('connection', socket => socket.on('message', data => {
  const message = JSON.parse(data.toString())
  if (message.type === 'handshake') {
    assert.equal(message.token, token)
    assert.equal(message.workspaceId, 'smoke')
    handshake = true
    socket.send(JSON.stringify({ id: message.id, type: 'handshake_ack', clientId: 'smoke-client', serverVersion: '26.9.28' }))
  } else if (message.type === 'request') {
    requests.add(message.channel)
    let result = []
    if (message.channel === 'workspaces:get') result = [{ id: 'smoke', name: 'Win7 Smoke Workspace', rootPath: '/remote/smoke', createdAt: Date.now() }]
    else if (message.channel === 'theme:getColorTheme') result = 'default'
    else if (message.channel === 'theme:getWorkspaceColorTheme' || message.channel === 'theme:getSelectedPack') result = null
    else if (message.channel === 'theme:getApp' || message.channel === 'workspaceSettings:get' || message.channel === 'drafts:getAll') result = {}
    else if (message.channel === 'sessions:getUnreadSummary') result = { hasUnreadByWorkspace: {}, totalUnread: 0 }
    else if (message.channel === 'notification:getEnabled') result = false
    else if (message.channel === 'preferences:read') result = { content: JSON.stringify({ gettingStartedGuideVersion: 1 }) }
    else if (message.channel === 'settings:get') result = { theme: 'system' }
    else if (message.channel === 'workspace:getSettings') result = {}
    else if (message.channel === 'onboarding:getAuthState') result = { authState: {}, setupNeeds: { isFullyConfigured: true } }
    socket.send(JSON.stringify({ id: message.id, type: 'response', channel: message.channel, result }))
  }
}))
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message)
  })
})
require(process.argv.includes('--packaged-app') ? './release/win-unpacked/resources/app.asar/main.cjs' : './dist/app/main.cjs')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await wait(100) }
  throw new Error('Smoke test timed out')
}

app.whenReady().then(async () => {
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL().includes('settings.html'))
  const window = BrowserWindow.getAllWindows()[0]
  const contents = window.webContents
  await until(() => contents.executeJavaScript('Boolean(document.getElementById("connect") && window.TokenBirdRemote)'))
  assert.match(await contents.executeJavaScript('document.body.innerText'), /Win7 Remote/)
  const url = 'ws://127.0.0.1:' + mock.address().port
  await contents.executeJavaScript(`window.TokenBirdRemote.connect(${JSON.stringify({ serverUrl: url, token, workspaceId: 'smoke' })})`)
  await until(() => contents.getURL().includes('embedded=win7'))
  await until(() => handshake && requests.has('workspaces:get') && requests.has('sessions:get'))
  await wait(2000)
  const diagnostics = await contents.executeJavaScript(`({
    text: document.body.innerText.slice(0,1000),
    foreground: getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim(),
    background: getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),
    recipeCount: Array.from(document.documentElement.style).filter(name => name.startsWith('--win7-color-')).length,
    translucent: getComputedStyle(document.documentElement).getPropertyValue('--win7-color-90').trim(),
    nodeAvailable: typeof require !== 'undefined',
    chrome: navigator.userAgent
  })`)
  assert.equal(diagnostics.nodeAvailable, false)
  assert.ok(diagnostics.recipeCount > 0)
  assert.match(diagnostics.foreground, /rgb|#/)
  assert.ok(diagnostics.text.length > 50, 'The main UI is blank')
  assert.ok(!errors.some(message => /Uncaught|is not a function/.test(message)), JSON.stringify(errors))
  assert.ok(!/something went wrong|请重新加载|发生了错误/i.test(diagnostics.text), diagnostics.text)
  assert.ok(!contents.getURL().includes(token))
  const translucent = await contents.executeJavaScript(`(() => {
    const probe = document.createElement('div')
    probe.className = 'bg-foreground/10'
    document.body.appendChild(probe)
    const value = getComputedStyle(probe).backgroundColor
    probe.remove()
    return value
  })()`)
  assert.match(translucent, /rgba\(.+, 0\.1\)$/, 'Opaque modern-color fallback was selected')
  const profile = fs.readFileSync(path.join(temp, 'TokenBird-Win7-Remote/connection.json'), 'utf8')
  assert.ok(!profile.includes(token), 'Unremembered token leaked into profile')
  const screenshot = await contents.capturePage()
  fs.writeFileSync(path.resolve(__dirname, '../../.toolchains/win7-client-smoke.png'), screenshot.toPNG())
  await contents.executeJavaScript(`document.documentElement.classList.add('dark')`)
  await wait(1200)
  const dark = await contents.executeJavaScript(`getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim()`)
  assert.notEqual(diagnostics.foreground, dark)
  console.log(JSON.stringify({ success: true, diagnostics, rpcChannels: [...requests], rendererErrors: errors }, null, 2))
  for (const socket of mock.clients) socket.terminate()
  mock.close()
  app.exit(0)
}).catch(error => {
  console.error(error.stack)
  console.error('Renderer errors:', JSON.stringify(errors))
  console.error('RPC channels:', JSON.stringify([...requests]))
  for (const socket of mock.clients) socket.terminate()
  mock.close()
  app.exit(1)
})
setTimeout(() => { console.error('Smoke test deadline exceeded'); app.exit(1) }, 45000).unref()
