/** Real Electron companion, isolated native profile; no model/API calls or desktop input. */
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as esbuild from 'esbuild'
import { build as buildRenderer, loadConfigFromFile } from 'vite'

const root = mkdtempSync(join(tmpdir(), 'tokenbird-bird-companion-'))
const configDir = join(root, 'config')
mkdirSync(configDir)
const dist = resolve(import.meta.dir, '../apps/electron/dist')
assert.ok(existsSync(join(dist, 'bird-companion-preload.cjs')), 'Build the preloads first')
const loadedConfig = await loadConfigFromFile({ command: 'build', mode: 'production' }, resolve(import.meta.dir, '../apps/electron/vite.config.ts'))
assert.ok(loadedConfig)
await buildRenderer({
  ...loadedConfig.config, configFile: false, publicDir: false,
  build: { ...loadedConfig.config.build, outDir: join(root, 'renderer'), sourcemap: false, rollupOptions: {
    ...loadedConfig.config.build?.rollupOptions,
    input: [resolve(import.meta.dir, '../apps/electron/src/renderer/bird-companion.html')],
  } },
})
copyFileSync(join(dist, 'bird-companion-preload.cjs'), join(root, 'bird-companion-preload.cjs'))
const report = join(root, 'result.json')
const entry = join(root, 'main.ts')
const hostHtml = join(root, 'host.html')
const hostPreload = join(root, 'host-preload.cjs')
writeFileSync(hostHtml, '<!doctype html><html><body>Companion smoke host</body></html>')
writeFileSync(hostPreload, `
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('fixture', {
  get: () => ipcRenderer.invoke('bird-companion:get-preferences'),
  set: value => ipcRenderer.invoke('bird-companion:set-preferences', value),
  observe: value => ipcRenderer.invoke('bird-companion:observe', value),
  dismiss: () => ipcRenderer.invoke('bird-companion:dismiss'),
});
`)
writeFileSync(entry, `
import { app, BrowserWindow } from 'electron';
import { writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { BirdCompanionManager } from ${JSON.stringify(resolve(import.meta.dir, '../apps/electron/src/main/bird-companion'))};
import { createNativeWindowAuthority } from ${JSON.stringify(resolve(import.meta.dir, '../apps/electron/src/main/native-window-authority'))};
import { setupI18n, i18n } from '@craft-agent/shared/i18n';
app.setPath('userData', ${JSON.stringify(join(root, 'electron'))});
app.commandLine.appendSwitch('disable-gpu');
const shown = new Set<number>();
const topmost = new Set<number>();
// Keep the checks unobtrusive; still verify showInactive is requested and render
// the real transparent, sandboxed window with capturePage.
BrowserWindow.prototype.showInactive = function() { shown.add(this.webContents.id); };
const setAlwaysOnTop = BrowserWindow.prototype.setAlwaysOnTop;
BrowserWindow.prototype.setAlwaysOnTop = function(value, ...args) {
  if (value) topmost.add(this.webContents.id); else topmost.delete(this.webContents.id);
  return setAlwaysOnTop.call(this, value, ...args);
};
const save = value => writeFileSync(${JSON.stringify(report)}, JSON.stringify(value, null, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, duration = 10000) {
  const end = Date.now() + duration;
  while (!(await predicate())) { if (Date.now() > end) throw new Error('Timeout: ' + label); await sleep(50); }
}
const bird = () => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('bird-companion.html'));
async function screenshot(window, path) {
  await window.webContents.capturePage();
  await sleep(150);
  writeFileSync(path, (await window.webContents.capturePage()).toPNG());
}
let manager;
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_event, _level, message) => { if (/Uncaught|Error|Failed to load/i.test(message)) errors.push(message); });
});
(async () => {
await app.whenReady();
setupI18n();
await i18n.changeLanguage('zh-Hans');
try {
  const host = new BrowserWindow({ show: false, webPreferences: { preload: ${JSON.stringify(hostPreload)}, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const authority = createNativeWindowAuthority({
    getWindowByWebContentsId: id => id === host.webContents.id ? host : null,
    getWorkspaceForWindow: id => id === host.webContents.id ? 'fixture-workspace' : null,
  }, [pathToFileURL(${JSON.stringify(hostHtml)}).href]);
  manager = new BirdCompanionManager(authority);
  await host.loadFile(${JSON.stringify(hostHtml)});
  const invoke = expression => host.webContents.executeJavaScript(expression);
  const observe = event => invoke('window.fixture.observe(' + JSON.stringify(event) + ')');
  const set = updates => invoke('window.fixture.set(' + JSON.stringify(updates) + ')');
  assert.deepEqual(await invoke('window.fixture.get()'), { alwaysVisible: false, autoShowComputerUse: true });
  assert.equal(bird(), undefined, 'No idle renderer by default');
  await observe({ type: 'start', sessionId: 's', startId: 'm' });
  await observe({ type: 'tool', sessionId: 's', toolUseId: 'read', activity: 'reading', computer: false });
  assert.equal(bird(), undefined, 'Regular tools must not auto-show');
  await observe({ type: 'permission', sessionId: 's', requestId: 'p', computer: true });
  await until(() => bird() && shown.has(bird().webContents.id), 'permission window ready');
  const waiting = await bird().webContents.executeJavaScript('document.body.innerText');
  assert.ok(waiting.includes('词元鸟正在等你确认操作'), waiting);
  assert.equal(bird().isFocusable(), false, 'No focus stealing');
  assert.equal(topmost.has(bird().webContents.id), true, 'Desktop overlay requests always-on-top');
  assert.equal(host.isFocused(), false);
  await observe({ type: 'permission_resolved', sessionId: 's', requestId: 'p', allowed: true });
  await observe({ type: 'result', sessionId: 's', toolUseId: 'read', isError: false });
  await observe({ type: 'tool', sessionId: 's', toolUseId: 'click', activity: 'click', computer: true });
  // Native event delivery also covers local sessions when app windows are hidden.
  manager.observeSessionEvent({ type: 'tool_start', sessionId: 's', toolUseId: 'click', toolName: 'computer_use', toolInput: { action: 'click' } }, 'fixture-workspace');
  await until(async () => (await bird().webContents.executeJavaScript('document.body.innerText')).includes('词元鸟正在点击'), 'working bubble');
  await until(async () => await bird().webContents.executeJavaScript('[...document.querySelectorAll("image")].every(image => image.href.baseVal.includes("tokenbird"))'), 'icon layers');
  await sleep(400);
  await screenshot(bird(), ${JSON.stringify(join(root, 'bird-working.png'))});
  const beforeMove = bird().getBounds();
  await bird().webContents.executeJavaScript('window.birdCompanion.move(-100, -30)');
  const afterMove = bird().getBounds();
  assert.ok(afterMove.x <= beforeMove.x && afterMove.y <= beforeMove.y, 'Bird moves within screen bounds');
  const security = await invoke('window.fixture.dismiss().then(() => false, () => true)');
  assert.equal(security, true, 'App host cannot use companion-only controls');
  await observe({ type: 'result', sessionId: 's', toolUseId: 'click', isError: false });
  manager.observeSessionEvent({ type: 'tool_result', sessionId: 's', toolUseId: 'click', toolName: 'computer_use', result: 'private-content' }, 'fixture-workspace');
  await observe({ type: 'finish', sessionId: 's', outcome: 'complete' });
  await until(async () => (await bird().webContents.executeJavaScript('document.body.innerText')).includes('这一轮执行结束啦'), 'completion bubble');
  const completed = await bird().webContents.executeJavaScript('document.body.innerText');
  assert.ok(completed.includes('已完成 2 步'), completed);
  assert.ok(!completed.includes('private-content'));
  await screenshot(bird(), ${JSON.stringify(join(root, 'bird-completed.png'))});
  await until(() => !bird(), 'auto-hide after 10 seconds', 12000);
  await set({ alwaysVisible: true });
  await until(() => bird() && shown.has(bird().webContents.id), 'pinned bird');
  await bird().webContents.executeJavaScript('document.querySelector(".bird-character").click()');
  await until(async () => (await bird().webContents.executeJavaScript('document.body.innerText')).includes('嗨！'), 'greeting');
  await set({ alwaysVisible: false, autoShowComputerUse: false });
  assert.equal(bird(), undefined);
  await observe({ type: 'tool', sessionId: 'disabled', toolUseId: 'off', activity: 'computer', computer: true });
  assert.equal(bird(), undefined, 'Auto-show disabled');
  manager.dispose();
  manager = new BirdCompanionManager(authority);
  assert.deepEqual(await invoke('window.fixture.get()'), { alwaysVisible: false, autoShowComputerUse: false });
  assert.deepEqual(JSON.parse(readFileSync(${JSON.stringify(join(configDir, 'preferences.json'))}, 'utf8')).birdCompanion, { alwaysVisible: false, autoShowComputerUse: false });
  await set({ autoShowComputerUse: true });
  await observe({ type: 'tool', sessionId: 'next', toolUseId: 'n1', activity: 'screenshot', computer: true });
  await until(() => bird() && shown.has(bird().webContents.id), 'new task');
  await bird().webContents.executeJavaScript('document.querySelector(".bird-dismiss").click()');
  await until(() => !bird(), 'dismiss');
  await observe({ type: 'tool', sessionId: 'next', toolUseId: 'n2', activity: 'click', computer: true });
  assert.equal(bird(), undefined, 'Current task stays dismissed');
  await observe({ type: 'start', sessionId: 'next', startId: 'next-message' });
  await observe({ type: 'tool', sessionId: 'next', toolUseId: 'n3', activity: 'type', computer: true });
  await until(() => bird() && shown.has(bird().webContents.id), 'next turn restores bird');
  await observe({ type: 'finish', sessionId: 'next', outcome: 'error' });
  await observe({ type: 'finish', sessionId: 'next', outcome: 'complete' });
  await until(async () => (await bird().webContents.executeJavaScript('document.body.innerText')).includes('执行遇到错误'), 'error bubble');
  assert.equal(await invoke('window.fixture.set({alwaysVisible: "invalid"}).then(() => false, () => true)'), true);
  assert.equal(errors.length, 0, errors.join(' | '));
  save({ success: true, waiting, completed, beforeMove, afterMove, nativeSecurity: security, errors,
    screenshots: [${JSON.stringify(join(root, 'bird-working.png'))}, ${JSON.stringify(join(root, 'bird-completed.png'))}] });
  manager.dispose();
  host.destroy();
  app.exit(0);
} catch (error) {
  save({ success: false, error: String(error), stack: error.stack, errors });
  manager?.dispose();
  app.exit(1);
}
})();
`)
await esbuild.build({
  entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
  outfile: join(root, 'main.cjs'), external: ['electron'],
  plugins: [{ name: 'native-sdk', setup(build) {
    build.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({
      path: Bun.resolveSync('@anthropic-ai/claude-agent-sdk', resolve(import.meta.dir, '..')), external: true,
    }))
  } }],
  // The fixture lives in the OS temp directory; resolve workspace packages here.
  nodePaths: [resolve(import.meta.dir, '../node_modules')],
  define: { 'import.meta.dir': JSON.stringify(root) },
})
const env = { ...process.env, TOKENBIRD_CONFIG_DIR: configDir, NODE_PATH: resolve(import.meta.dir, '../node_modules') }
delete env.ELECTRON_RUN_AS_NODE
const processHandle = Bun.spawn([resolve(import.meta.dir, '../node_modules/electron/dist/electron.exe'), join(root, 'main.cjs')], {
  env, stdout: 'pipe', stderr: 'pipe', windowsHide: true,
})
const timeout = setTimeout(() => processHandle.kill(), 60_000)
const [code, stdout, stderr] = await Promise.all([processHandle.exited, new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text()])
clearTimeout(timeout)
const result = existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : { error: 'No result', stdout, stderr }
console.log(JSON.stringify({ root, code, ...result }, null, 2))
assert.equal(code, 0, `${result.error ?? stderr}`)
assert.equal(result.success, true)
