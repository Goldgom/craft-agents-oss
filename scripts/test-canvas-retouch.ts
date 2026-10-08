import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = resolve(import.meta.dir, '..')
const directory = await mkdtemp(join(tmpdir(), 'tokenbird-retouch-'))
const build = await Bun.build({ entrypoints: [join(root, 'apps/electron/src/renderer/pages/studio/canvas-retouch.browser.ts')], outdir: directory, target: 'browser' })
if (!build.success) throw new AggregateError(build.logs, 'Failed to bundle canvas smoke test')
await writeFile(join(directory, 'index.html'), '<!doctype html><html><body><script type="module" src="canvas-retouch.browser.js"></script></body></html>')
await writeFile(join(directory, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
  await win.loadFile(${JSON.stringify(join(directory, 'index.html'))});
  const result = await win.webContents.executeJavaScript('Promise.resolve().then(() => window.runRetouchChecks()).then(checks => ({ checks }), error => ({ error: error.stack || String(error) }))');
  if (result.error) throw new Error(result.error);
  const checks = result.checks;
  console.log(JSON.stringify({ passed: checks.length, checks }));
  app.exit(0);
}).catch(error => { console.error(error.stack || error); app.exit(1); });
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executable = join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
const child = spawn(executable, [join(directory, 'main.cjs')], { env, windowsHide: true, stdio: 'inherit' })
const timeout = setTimeout(() => { child.kill(); console.error('Canvas smoke test timed out') }, 45_000)
const code = await new Promise<number>((resolveExit, reject) => { child.once('error', reject); child.once('exit', value => resolveExit(value ?? 1)) }).finally(() => clearTimeout(timeout))
process.exitCode = code
