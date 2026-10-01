/** Real Electron saved-server startup, using only a temporary profile and loopback peer.
 * Run after electron:build: bun scripts/tokenbird-native-startup.smoke.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { WsRpcServer } from '../packages/server-core/src/transport/server'
import { RPC_CHANNELS } from '../packages/shared/src/protocol'

const root = mkdtempSync(join(tmpdir(), 'tokenbird-native-startup-'))
const configDir = join(root, 'config')
mkdirSync(configDir)
const token = 'dummy-native-startup-token'
const failure = process.argv.find(arg => arg.startsWith('--failure='))?.split('=')[1]
assert.ok(!failure || ['network', 'protocol', 'unsupported'].includes(failure))
const recovered = join(root, 'recovered')
const server = new WsRpcServer({ host: '127.0.0.1', port: 0, requireAuth: true, validateToken: async value => value === token })
server.handle(RPC_CHANNELS.window.GET_WORKSPACE, async context => context.workspaceId)
server.handle(RPC_CHANNELS.onboarding.GET_AUTH_STATE, async () => ({ setupNeeds: { isFullyConfigured: true } }))
server.handle(RPC_CHANNELS.server.GET_WORKSPACES, async () => {
  if (failure === 'unsupported' && !existsSync(recovered)) {
    throw Object.assign(new Error('Synthetic missing older-server interface'), { code: 'CHANNEL_NOT_FOUND' })
  }
  return [{ id: 'fixture-workspace', name: 'Fixture Workspace' }]
})
const accept = (server as any).onConnection.bind(server)
;(server as any).onConnection = (socket: any, cookie: unknown) => {
  if (!existsSync(recovered) && failure === 'network') { socket.terminate(); return }
  if (!existsSync(recovered) && failure === 'protocol') {
    socket.once('message', (raw: any) => {
      const handshake = JSON.parse(raw.toString())
      socket.send(JSON.stringify({ id: handshake.id, type: 'error', error: {
        code: 'PROTOCOL_VERSION_UNSUPPORTED', message: 'Synthetic incompatible protocol',
      } }))
      socket.close(4004, 'Protocol mismatch')
    })
    return
  }
  accept(socket, cookie)
}
await server.listen()
writeFileSync(join(configDir, 'preferences.json'), JSON.stringify({ startupServerLocation: 'fixture' }))
writeFileSync(join(configDir, 'remote-servers.json'), JSON.stringify([{
  id: 'fixture', name: 'Fixture', url: `ws://127.0.0.1:${server.port}`, token, createdAt: 1, updatedAt: 1,
}]))
const main = process.env.TOKENBIRD_SMOKE_MAIN
  ? resolve(process.env.TOKENBIRD_SMOKE_MAIN)
  : resolve(import.meta.dir, '../apps/electron/dist/main.cjs')
const checkTranslations = process.argv.includes('--check-mcp-zh')
const translationAsset = checkTranslations
  ? readdirSync(join(dirname(main), 'renderer/assets')).find(file => /^i18nextBrowserLanguageDetector-.*\.js$/.test(file))
  : undefined
const expectedTranslations = checkTranslations
  ? Object.fromEntries(Object.entries(JSON.parse(readFileSync(resolve(import.meta.dir, '../packages/shared/src/i18n/locales/zh-Hans.json'), 'utf8')))
    .filter(([key]) => key.startsWith('mcpManage.')))
  : undefined
const wrapper = join(root, 'main.cjs')
const report = join(root, 'result.json')
mkdirSync(join(root, 'electron'))
writeFileSync(wrapper, `
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('lang', 'en-US');
app.setPath('appData', ${JSON.stringify(join(root, 'electron'))});
const report = value => require('fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify(value));
BrowserWindow.prototype.show = function() {};
BrowserWindow.prototype.showInactive = function() {};
app.on('web-contents-created', (_event, contents) => {
  contents.once('did-finish-load', async () => {
    let initial;
    try {
      if (${JSON.stringify(!!failure)}) {
        const error = await contents.executeJavaScript('window.electronAPI.getServerWorkspaces().then(() => null, error => error.message)');
        const deadline = Date.now() + 10000;
        let screen;
        do {
          screen = await contents.executeJavaScript('({ text: document.body.innerText, hasInput: !!document.querySelector("input"), retry: [...document.querySelectorAll("button")].some(button => button.textContent.trim() === "Retry") })');
          if (screen.retry) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        initial = { error, screen };
        if (!screen.retry) throw new Error('Missing retry button: ' + JSON.stringify(screen));
        require('fs').writeFileSync(${JSON.stringify(recovered)}, 'ready');
        await contents.executeJavaScript('[...document.querySelectorAll("button")].find(button => button.textContent.trim() === "Retry").click()');
        const retryDeadline = Date.now() + 10000;
        while (!(await contents.executeJavaScript('document.body.innerText.includes("Fixture Workspace")'))) {
          if (Date.now() > retryDeadline) throw new Error('Retry did not recover workspace discovery');
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      const rows = await contents.executeJavaScript('window.electronAPI.getServerWorkspaces()');
      let translations;
      if (${JSON.stringify(checkTranslations)}) {
        translations = await contents.executeJavaScript(${JSON.stringify(`(async () => {
          const module = await import(new URL('./assets/${translationAsset}', location.href).href);
          const i18n = Object.values(module).find(value => value && typeof value.changeLanguage === 'function' && typeof value.t === 'function');
          if (!i18n) throw new Error('Built translation instance unavailable');
          const t = i18n.getFixedT('zh-Hans');
          return Object.fromEntries(${JSON.stringify(Object.keys(expectedTranslations ?? {}))}.map(key => [key, t(key)]));
        })()`)});
      }
      report({ rows, initial, translations });
      app.exit(0);
    } catch (error) { report({ error: error.message, initial }); app.exit(1); }
  });
});
setTimeout(() => { report({ error: 'Timed out' }); app.exit(2); }, 30000);
require(${JSON.stringify(main)});
`)
const env = { ...process.env, TOKENBIRD_CONFIG_DIR: configDir }
delete env.ELECTRON_RUN_AS_NODE
for (const key of Object.keys(env)) {
  if (key.startsWith('CRAFT_SERVER_') || key === 'CRAFT_WORKSPACE_ID' || key === 'CRAFT_HEADLESS' || key === 'VITE_DEV_SERVER_URL') delete env[key]
}
const electron = (await import('electron')).default as unknown as string
const child = Bun.spawn([electron, wrapper], { env, stdout: 'pipe', stderr: 'pipe' })
try {
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const result = JSON.parse(readFileSync(report, 'utf8'))
  assert.equal(code, 0, JSON.stringify(result) + '\n' + stderr + '\n' + stdout)
  assert.deepEqual(result.rows, [{ id: 'fixture-workspace', name: 'Fixture Workspace' }], JSON.stringify(result))
  if (checkTranslations) {
    assert.deepEqual(result.translations, expectedTranslations)
    console.log('PASS real Electron bundled Simplified Chinese MCP translations')
  }
  if (failure) {
    assert.ok(result.initial.error)
    assert.equal(result.initial.screen.hasInput, false, JSON.stringify(result.initial))
    assert.equal(result.initial.screen.retry, true)
    assert.ok(result.initial.screen.text.includes('Cannot connect to remote server'))
    assert.ok(!result.initial.screen.text.includes('Create your first workspace'))
    if (failure === 'protocol') assert.ok(result.initial.screen.text.includes('Protocol mismatch'))
    if (failure === 'network') assert.ok(result.initial.screen.text.includes('Is the remote server running?'))
    if (failure === 'unsupported') assert.ok(result.initial.screen.text.includes('Update the server'))
  }
  console.log(`PASS real Electron saved-server discovery${failure ? `, ${failure} failure screen and retry recovery` : ''}`)
} finally { child.kill(); await server.close() }
