'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const temp = process.argv[process.argv.indexOf('--restore-root') + 1]
const id = process.argv[process.argv.indexOf('--restore-session') + 1]
assert.ok(temp && id)
app.setPath('appData', temp)
app.commandLine.appendSwitch('disable-gpu')
require(process.argv.includes('--packaged-app') ? './release/win-unpacked/resources/app.asar/main.cjs' : './dist/app/main.cjs')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) { if (await predicate()) return; await wait(100) }
  throw new Error('Restart test timed out')
}
app.whenReady().then(async () => {
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL().includes('embedded=win7'))
  const contents = BrowserWindow.getAllWindows()[0].webContents
  await until(() => contents.executeJavaScript('Boolean(window.electronAPI)'))
  const session = await contents.executeJavaScript(`window.electronAPI.getSessionMessages(${JSON.stringify(id)})`)
  assert.ok(session.messages.some(message => message.role === 'assistant' && message.content.includes('WIN7_LOCAL_OK')))
  const connection = await contents.executeJavaScript('window.TokenBirdRemote.getConnection()')
  assert.equal(connection.mode, 'local')
  await contents.executeJavaScript('window.TokenBirdRemote.configureServer()')
  assert.ok(!contents.getURL().includes('settings.html'))
  const profile = await contents.executeJavaScript(`window.electronAPI.getLlmConnection('anthropic-api')`)
  assert.equal(profile.providerType, 'pi_compat')
  const masked = await contents.executeJavaScript(`window.electronAPI.getLlmConnectionApiKey('anthropic-api')`)
  assert.ok(masked, 'OS-protected API key was not restored')
  assert.ok(!JSON.stringify(profile).includes('win7-local-smoke-not-a-real-api-key'))
  console.log(JSON.stringify({ success: true, historySurvivesRestart: true, osProtectedKeyReadable: true, sessionId: id, dataDirectory: path.join(temp, 'TokenBird-Win7-Local') }))
  app.quit()
}).catch(error => { console.error(error.stack); process.exitCode = 1; app.quit() })
setTimeout(() => app.exit(1), 50000).unref()
