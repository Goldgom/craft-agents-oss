/** Exercise the built app with real Electron instance locks and isolated data. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'tokenbird-single-instance-'))
const configDir = join(root, 'config')
mkdirSync(configDir)
const bundle = resolve(import.meta.dir, '../apps/electron/dist/main.cjs')
assert.ok(existsSync(bundle), 'Run bun run electron:build:main first')
const runner = join(root, 'main.cjs')
const stopFile = join(root, 'stop')
writeFileSync(runner, `
const { app, dialog, ipcMain } = require('electron');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const role = process.env.INSTANCE_SMOKE_ROLE;
const reportPath = join(${JSON.stringify(root)}, role + '.json');
app.setPath('appData', ${JSON.stringify(join(root, 'appdata'))});
const state = { pid: process.pid, acquired: null, initialized: false, secondInstances: 0, handles: 0, dialogs: [], errors: [] };
const report = () => writeFileSync(reportPath, JSON.stringify(state));
const takeLock = app.requestSingleInstanceLock.bind(app);
app.requestSingleInstanceLock = (...args) => { state.acquired = takeLock(...args); report(); return state.acquired; };
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (...args) => { state.handles++; return handle(...args); };
app.on('ready', () => { state.handlesAtReady = state.handles; });
dialog.showMessageBoxSync = (options) => { state.dialogs.push(options); report(); return 0; };
dialog.showErrorBox = (...args) => { state.dialogs.push(args); report(); };
const info = console.log.bind(console);
console.log = (...args) => {
  if (args.some(arg => String(arg).includes('App initialized successfully'))) { state.initialized = true; report(); }
  info(...args);
};
const error = console.error.bind(console);
console.error = (...args) => { state.errors.push(args.map(String)); report(); error(...args); };
const quit = app.quit.bind(app);
// Hold the losing process through readiness to reproduce the async quit race.
// The native single-instance decision and the real application remain intact.
if (role !== 'primary') app.quit = () => {
  if (state.quitRequested) return;
  state.quitRequested = true;
  app.whenReady().then(() => setTimeout(() => { report(); quit(); }, 1200));
};
app.on('second-instance', () => { state.secondInstances++; report(); });
app.on('will-quit', report);
setInterval(() => {
  const logPath = join(app.getPath('appData'), 'TokenBird', 'logs', 'main.log');
  if (role === 'primary' && !state.initialized && existsSync(logPath) && readFileSync(logPath, 'utf8').includes('App initialized successfully')) {
    state.initialized = true;
    report();
  }
  if (existsSync(${JSON.stringify(stopFile)})) quit();
}, 100).unref();
require(${JSON.stringify(bundle)});
`)

const env = { ...process.env, TOKENBIRD_CONFIG_DIR: configDir, NODE_PATH: resolve(import.meta.dir, '../node_modules') }
for (const key of ['ELECTRON_RUN_AS_NODE', 'CRAFT_SERVER_URL', 'CRAFT_SERVER_TOKEN', 'CRAFT_SERVER_PROFILE_ID', 'VITE_DEV_SERVER_URL', 'CRAFT_HEADLESS']) {
  delete env[key]
}
const electron = resolve(import.meta.dir, '../node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
function launch(role: string, headless = false) {
  const child = Bun.spawn([electron, runner], {
    env: { ...env, INSTANCE_SMOKE_ROLE: role, ...(headless ? { CRAFT_HEADLESS: '1' } : {}) },
    stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  })
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { child, output }
}
function report(role: string): any {
  const path = join(root, `${role}.json`)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
async function until(check: () => boolean, label: string, timeout = 30_000) {
  const started = Date.now()
  while (!check()) {
    assert.ok(Date.now() - started < timeout, `Timed out: ${label}; reports at ${root}`)
    await Bun.sleep(100)
  }
}
const processes: ReturnType<typeof launch>[] = []
try {
  const primary = launch('primary', true)
  processes.push(primary)
  await until(() => report('primary')?.initialized
    || report('primary')?.errors.some((args: string[]) => args.some(arg => arg.includes('Failed to initialize app:')))
    || report('primary')?.dialogs.length, 'primary initializes')
  assert.equal(report('primary').initialized, true, JSON.stringify(report('primary')))
  assert.equal(report('primary').acquired, true)
  const lockPath = join(configDir, '.server.lock')
  const lockBefore = readFileSync(lockPath, 'utf8')
  assert.equal(JSON.parse(lockBefore).pid, primary.child.pid)

  for (const role of ['secondary', 'third']) {
    const extra = launch(role)
    processes.push(extra)
    await until(() => extra.child.exitCode !== null, `${role} exits`)
    assert.equal(await extra.child.exited, 0, (await extra.output).join('\n'))
    const state = report(role)
    assert.equal(state.acquired, false, JSON.stringify(state))
    assert.equal(state.quitRequested, true)
    assert.equal(state.initialized, false)
    assert.equal(state.handles, state.handlesAtReady, 'Losing process must not initialize application IPC after readiness')
    assert.deepEqual(state.dialogs, [], 'Repeated launch must not show a startup error')
    assert.deepEqual(state.errors, [], 'Repeated launch must not attempt server bootstrap')
    assert.equal(readFileSync(lockPath, 'utf8'), lockBefore, 'Primary retains its server lock')
    assert.equal(primary.child.exitCode, null, 'Primary keeps running')
  }
  assert.equal(report('primary').secondInstances, 2, 'Primary receives both repeat launches')
  writeFileSync(stopFile, '')
  await until(() => primary.child.exitCode !== null, 'primary shuts down')
  assert.equal(await primary.child.exited, 0, (await primary.output).join('\n'))
  assert.equal(existsSync(lockPath), false, 'Normal shutdown releases the server lock')
  console.log(JSON.stringify({ success: true, root, primary: report('primary'), secondary: report('secondary'), third: report('third') }, null, 2))
} finally {
  writeFileSync(stopFile, '')
  for (const { child } of processes) if (child.exitCode === null) child.kill()
}
