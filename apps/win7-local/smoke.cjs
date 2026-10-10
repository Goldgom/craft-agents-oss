// Electron 22 integration test; no accounts, remote server or user config needed.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { app, BrowserWindow, dialog } = require('electron')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenbird-win7-local-smoke-'))
const work = path.join(temp, 'test files 中文')
fs.mkdirSync(work)
app.setPath('appData', temp)
app.commandLine.appendSwitch('disable-gpu')
const errors = []
const events = []
const requests = []
let permissionCount = 0
let contents
let localSession
let stage = 'startup'
setInterval(() => console.log('SMOKE_STAGE ' + stage), 10000).unref()
const anthropic = process.argv.includes('--anthropic')
const fakeKey = 'win7-local-smoke-not-a-real-api-key'
const fixture = 'TokenBird Win7 local filesystem smoke\n'
const editedFixture = fixture + 'Edited locally\n'
const mock = http.createServer(async (req, res) => {
  try {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw || '{}')
    requests.push({ path: req.url, model: body.model })
    assert.equal(anthropic ? req.headers['x-api-key'] : req.headers.authorization, anthropic ? fakeKey : 'Bearer ' + fakeKey)
    const messages = body.messages || []
    const active = Array.isArray(body.tools) && messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('WIN7_LOCAL_SMOKE'))
    const tools = anthropic ? messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result').map(block => ({ content: block.content })) : []) : messages.filter(message => message.role === 'tool')
    const deny = messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('WIN7_LOCAL_SMOKE_DENY'))
    let tool
    if (active && tools.length === 0) tool = { name: 'write', arguments: JSON.stringify({ path: path.join(work, deny ? 'denied.txt' : 'local.txt'), content: fixture }) }
    else if (active && !deny && tools.length === 1) tool = { name: 'read', arguments: JSON.stringify({ path: path.join(work, 'local.txt') }) }
    else if (active && !deny && tools.length === 2) tool = { name: 'edit', arguments: JSON.stringify({ path: path.join(work, 'local.txt'), oldText: fixture.trim(), newText: editedFixture.trim() }) }
    else if (active && !deny && tools.length === 3) tool = { name: 'ls', arguments: JSON.stringify({ path: work }) }
    else if (active && !deny) assert.ok(tools.some(message => JSON.stringify(message.content).includes(fixture.trim())), JSON.stringify(tools))
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(anthropic ? { id: 'smoke', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'WIN7_LOCAL_OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } } : { id: 'smoke', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'WIN7_LOCAL_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    if (anthropic) {
      const send = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
      send({ type: 'message_start', message: { id: 'smoke-' + requests.length, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } })
      send({ type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'call-' + requests.length, name: tool.name, input: {} } : { type: 'text', text: '' } })
      if (tool) send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: tool.arguments } })
      else { send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'WIN7_' } }); send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LOCAL_OK' } }) }
      send({ type: 'content_block_stop', index: 0 })
      send({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } })
      send({ type: 'message_stop' })
      res.end()
      return
    }
    const send = (delta, reason = null, usage) => res.write('data: ' + JSON.stringify({ id: 'smoke-' + requests.length, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: reason }], ...(usage ? { usage } : {}) }) + '\n\n')
    send({ role: 'assistant', content: '' })
    if (tool) send({ tool_calls: [{ index: 0, id: 'call-' + requests.length, type: 'function', function: tool }] })
    else { send({ content: 'WIN7_' }); send({ content: 'LOCAL_OK' }) }
    send({}, tool ? 'tool_calls' : 'stop', { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 })
    res.end('data: [DONE]\n\n')
  } catch (error) { errors.push(error.stack); res.writeHead(500).end('Mock test assertion failed') }
})
mock.listen(0, '127.0.0.1')
app.on('web-contents-created', (_event, value) => value.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) }))
require(process.argv.includes('--packaged-app') ? './release/win-unpacked/resources/app.asar/main.cjs' : './dist/app/main.cjs')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, timeout = 45000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await wait(100) }
  throw new Error('Timed out; events=' + JSON.stringify(events.slice(-15)) + '; errors=' + JSON.stringify(errors))
}
app.whenReady().then(async () => {
  await until(() => BrowserWindow.getAllWindows()[0]?.webContents.getURL().includes('embedded=win7'))
  contents = BrowserWindow.getAllWindows()[0].webContents
  await until(() => contents.executeJavaScript('Boolean(window.electronAPI && document.body.innerText.length > 50)'))
  await wait(1500)
  await contents.executeJavaScript("document.querySelector('[data-getting-started-guide] button')?.click(); true")
  assert.equal(await contents.executeJavaScript('window.electronAPI.getRuntimeEnvironment()'), 'electron')
  assert.equal(await contents.executeJavaScript('Boolean(window.TokenBirdLocal)'), false, 'Legacy settings bridge still present')
  assert.ok(!contents.getURL().includes('settings.html'))
  await wait(400)
  assert.equal(typeof await contents.executeJavaScript('window.electronAPI.getNotificationsEnabled()'), 'boolean')
  // Native file dialogs return real absolute paths, not browser file names.
  const originalOpen = dialog.showOpenDialog
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [work] })
  try {
    assert.equal(await contents.executeJavaScript('window.electronAPI.openFolderDialog()'), work)
    assert.deepEqual(await contents.executeJavaScript('window.electronAPI.openFileDialog()'), [work])
  } finally { dialog.showOpenDialog = originalOpen }
  const mapId = 'studio-mindmap-first'
  await contents.executeJavaScript(`window.electronAPI.writeStudioMindMapSession(${JSON.stringify(work)}, ${JSON.stringify(mapId)}, '{"test":true}')`)
  assert.equal(await contents.executeJavaScript(`window.electronAPI.readStudioMindMapSession(${JSON.stringify(work)}, ${JSON.stringify(mapId)})`), '{"test":true}')
  await contents.executeJavaScript(`window.electronAPI.deleteStudioMindMapSession(${JSON.stringify(work)}, ${JSON.stringify(mapId)})`)
  assert.equal(await contents.executeJavaScript(`window.electronAPI.readStudioMindMapSession(${JSON.stringify(work)}, ${JSON.stringify(mapId)})`), '')
  const originalSave = dialog.showSaveDialog
  try {
    const canvasFile = path.join(work, 'canvas-export.tbcanvas')
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: canvasFile })
    const canvasExport = await contents.executeJavaScript(`window.TokenBirdDesktop.invoke('client:saveBlob', 'canvas-export.tbcanvas', btoa('canvas-export-smoke'))`)
    assert.equal(canvasExport.path, canvasFile)
    assert.equal(fs.readFileSync(canvasFile, 'utf8'), 'canvas-export-smoke')
    dialog.showSaveDialog = async () => ({ canceled: true })
    assert.equal((await contents.executeJavaScript(`window.TokenBirdDesktop.invoke('client:saveBlob', 'canvas.tbcanvas', btoa('test'))`)).canceled, true)
    assert.equal(await contents.executeJavaScript(`window.electronAPI.openTokenNestRecharge('file:///invalid').then(() => false, () => true)`), true)
    for (const format of ['markdown', 'docx', 'pdf', 'png']) {
      stage = 'native export ' + format
      const exportFile = path.join(work, 'export.' + ({ markdown: 'md', docx: 'docx', pdf: 'pdf', png: 'png' })[format])
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportFile })
      const request = { format, title: 'Win7 原版聊天导出', exportedAt: '2026-10-02', messages: [{ role: 'user', content: 'Native export test' }, { role: 'assistant', content: 'Win7 export OK' }], labels: { exportedAt: 'Exported', attachments: 'Attachments', toolInput: 'Input', toolResult: 'Result', roles: { user: 'User', assistant: 'Assistant' } } }
      const result = await contents.executeJavaScript(`window.electronAPI.exportChatTranscript(${JSON.stringify(request)})`)
      assert.equal(result.success, true, JSON.stringify(result))
      const bytes = fs.readFileSync(exportFile)
      if (format === 'markdown') assert.match(bytes.toString(), /Win7 export OK/)
      if (format === 'docx') assert.equal(bytes.subarray(0, 2).toString(), 'PK')
      if (format === 'pdf') assert.equal(bytes.subarray(0, 4).toString(), '%PDF')
      if (format === 'png') assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
    }
  } finally { dialog.showSaveDialog = originalSave }
  // Chromium's real OS File must retain its path across the sandboxed bridge.
  await contents.executeJavaScript(`const picker = document.createElement('input'); picker.type = 'file'; picker.id = 'native-path-test'; picker.style.display = 'none'; document.body.append(picker); true`)
  contents.debugger.attach('1.3')
  try {
    const documentNode = await contents.debugger.sendCommand('DOM.getDocument')
    const inputNode = await contents.debugger.sendCommand('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#native-path-test' })
    await contents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [path.join(work, 'export.md')] })
    assert.equal(await contents.executeJavaScript(`window.electronAPI.getFilePath(document.getElementById('native-path-test').files[0])`), path.join(work, 'export.md'))
  } finally { contents.debugger.detach() }
  const initialText = await contents.executeJavaScript('document.body.innerText')
  assert.match(initialText, /Git Bash|选择|Choose|TokenNest|开始|Welcome/i, 'Original onboarding did not render')
  stage = 'configure'
  const model = anthropic ? 'claude-sonnet-4-6' : 'gpt-4o-mini'
  const baseUrl = `http://127.0.0.1:${mock.address().port}${anthropic ? '' : '/v1'}`
  // Same test + setup RPCs called by the unchanged original configuration form.
  const tested = await contents.executeJavaScript(`window.electronAPI.testLlmConnectionSetup(${JSON.stringify({ provider: anthropic ? 'anthropic' : 'pi', apiKey: fakeKey, baseUrl, model, piAuthProvider: anthropic ? undefined : 'openai', customEndpoint: anthropic ? undefined : { api: 'openai-completions' } })})`)
  assert.equal(tested.success, true, JSON.stringify(tested))
  const saved = await contents.executeJavaScript(`window.electronAPI.setupLlmConnection(${JSON.stringify({ slug: 'anthropic-api', credential: fakeKey, baseUrl, defaultModel: model, models: [model], modelSelectionMode: 'userDefined3Tier', customEndpoint: anthropic ? undefined : { api: 'openai-completions', supportsImages: true } })})`)
  assert.equal(saved.success, true, JSON.stringify(saved))
  const firstConnection = await contents.executeJavaScript(`window.electronAPI.getLlmConnection('anthropic-api')`)
  assert.equal(firstConnection.providerType, 'pi_compat')
  assert.equal(firstConnection.piAuthProvider, anthropic ? 'anthropic' : 'openai')
  // Reload performs the same auth-state check as finishing onboarding.
  await contents.reload()
  await until(() => contents.executeJavaScript('Boolean(window.electronAPI && document.body.innerText.length > 50)'))
  await wait(1500)
  await contents.executeJavaScript("document.querySelector('[data-getting-started-guide] button')?.click(); true")
  stage = 'connection'
  const config = await contents.executeJavaScript('window.TokenBirdRemote.getConnection()')
  assert.equal(config.mode, 'local')
  assert.match(config.serverUrl, /^ws:\/\/127\.0\.0\.1:/)
  assert.ok(!contents.getURL().includes(config.token))
  assert.equal(await contents.executeJavaScript('typeof require'), 'undefined')
  await contents.executeJavaScript(`window.electronAPI.updateWorkspaceSetting(${JSON.stringify(config.workspaceId)}, 'workingDirectory', ${JSON.stringify(work)})`)
  stage = 'desktop bridge'
  const bash = await contents.executeJavaScript('window.electronAPI.checkGitBash()')
  assert.equal(bash.platform, 'win32')
  assert.equal(typeof bash.found, 'boolean')
  await contents.executeJavaScript(`window.electronAPI.openWorkspace(${JSON.stringify(config.workspaceId)})`)
  await until(() => BrowserWindow.getAllWindows().length === 2)
  const second = BrowserWindow.getAllWindows().find(win => win.webContents !== contents)
  await until(() => second.webContents.executeJavaScript('Boolean(window.electronAPI)'))
  assert.equal(await second.webContents.executeJavaScript('window.electronAPI.getWindowWorkspace()'), config.workspaceId)
  await second.webContents.executeJavaScript('void window.electronAPI.confirmCloseWindow(); true')
  await until(() => BrowserWindow.getAllWindows().length === 1)
  await contents.executeJavaScript(`window.__settingsMenuHit = false; window.electronAPI.onMenuOpenSettings(() => window.__settingsMenuHit = true); true`)
  await contents.executeJavaScript('window.TokenBirdRemote.configureServer()')
  await until(() => contents.executeJavaScript('window.__settingsMenuHit'))
  assert.ok(!contents.getURL().includes('settings.html'))
  const unsupported = await contents.executeJavaScript('window.electronAPI.startClaudeOAuth()')
  assert.equal(unsupported.success, false)
  assert.match(unsupported.error, /Win7/)
  // Ensure IPC dispatcher cannot call inherited object methods.
  assert.equal(await contents.executeJavaScript(`window.TokenBirdDesktop.invoke('toString').then(() => false, () => true)`), true)
  stage = 'create session'
  await contents.executeJavaScript(`window.__smokeEvents = []; window.electronAPI.onSessionEvent(event => {
    window.__smokeEvents.push(event);
    if (event.type === 'permission_request') window.electronAPI.respondToPermission(event.sessionId, event.request.requestId, true, false);
  }); true;`)
  localSession = await contents.executeJavaScript(`window.electronAPI.createSession(${JSON.stringify(config.workspaceId)}, { name: 'Win7 local smoke', permissionMode: 'ask' })`)
  stage = 'model and tools'
  await contents.executeJavaScript(`window.electronAPI.sendMessage(${JSON.stringify(localSession.id)}, 'WIN7_LOCAL_SMOKE: write the test fixture then read it back')`)
  await until(async () => {
    const latest = await contents.executeJavaScript('window.__smokeEvents')
    events.splice(0, events.length, ...latest)
    return events.some(event => event.type === 'complete' && event.sessionId === localSession.id)
  }, 70000)
  assert.ok(!events.some(event => event.type === 'error' || event.type === 'typed_error'), JSON.stringify(events))
  assert.equal(fs.readFileSync(path.join(work, 'local.txt'), 'utf8'), editedFixture)
  assert.ok(events.some(event => event.type === 'text_delta'), 'No streamed text events')
  assert.ok(events.some(event => event.type === 'tool_result'), 'No tool result events')
  permissionCount = events.filter(event => event.type === 'permission_request').length
  const session = await contents.executeJavaScript(`window.electronAPI.getSessionMessages(${JSON.stringify(localSession.id)})`)
  assert.ok(session.messages.some(message => message.role === 'assistant' && message.content.includes('WIN7_LOCAL_OK')), JSON.stringify(session.messages))
  const denied = await contents.executeJavaScript(`window.electronAPI.createSession(${JSON.stringify(config.workspaceId)}, { name: 'Win7 safe-mode smoke', permissionMode: 'safe' })`)
  await contents.executeJavaScript(`window.electronAPI.sendMessage(${JSON.stringify(denied.id)}, 'WIN7_LOCAL_SMOKE_DENY: try writing the denied file')`)
  await until(async () => (await contents.executeJavaScript('window.__smokeEvents')).some(event => event.type === 'complete' && event.sessionId === denied.id), 70000)
  assert.ok(!fs.existsSync(path.join(work, 'denied.txt')), 'Safe-mode write escaped permission checks')
  const dataRoot = path.join(temp, 'TokenBird-Win7-Local')
  assert.ok(!fs.readFileSync(path.join(dataRoot, 'config.json'), 'utf8').includes(fakeKey))
  const vault = fs.readFileSync(path.join(dataRoot, 'credentials.enc'))
  assert.equal(vault.subarray(0, 8).toString(), 'TBVAULT2', 'Vault is not OS-protected')
  assert.ok(!vault.includes(Buffer.from(fakeKey)), 'Plaintext API key on disk')
  assert.equal(errors.length, 0, JSON.stringify(errors))
  console.log(JSON.stringify({ success: true, protocol: anthropic ? 'anthropic-messages' : 'openai-completions', node: process.versions.node, electron: process.versions.electron, originalOnboarding: true, originalSettingsMenu: true, nativeMultiWindow: true, sessionId: localSession.id, permissionCount, modelRequests: requests.length, toolNames: events.filter(event => event.type === 'tool_result').map(event => event.toolName), safeModeBlockedWrite: true, encryptedCredentials: true, rendererErrors: errors, temp }, null, 2))
  const screenshot = await contents.capturePage()
  fs.writeFileSync(path.resolve(__dirname, '../../.toolchains/win7-local-smoke.png'), screenshot.toPNG())
  mock.close()
  app.quit()
}).catch(error => {
  console.error('Failed stage:', stage, 'Renderer errors:', JSON.stringify(errors))
  console.error(error.stack)
  console.error('Model requests:', JSON.stringify(requests))
  console.error('Session events:', JSON.stringify(events))
  mock.close()
  process.exitCode = 1
  app.quit()
})
setTimeout(() => { console.error('Integration test deadline exceeded'); app.exit(1) }, 210000).unref()
