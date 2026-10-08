import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = resolve(import.meta.dir, '..')
const screenshots = process.argv.includes('--screenshots')
const directory = await mkdtemp(join(tmpdir(), 'tokenbird-canvas-mobile-'))
const build = await Bun.build({ entrypoints: [join(root, 'apps/electron/src/renderer/pages/studio/canvas-mobile.browser.tsx')], outdir: directory, target: 'browser', tsconfig: join(root, 'apps/electron/tsconfig.json'), plugins: [{ name: 'native-billing-boundary', setup(builder) {
  builder.onResolve({ filter: /tokennest-recharge$/ }, () => ({ path: 'billing', namespace: 'mobile-fixture' }))
  builder.onResolve({ filter: /\?url$/ }, () => ({ path: 'unused-pdf-worker', namespace: 'mobile-fixture' }))
  builder.onLoad({ filter: /.*/, namespace: 'mobile-fixture' }, args => ({ contents: args.path === 'billing' ? 'export async function rechargeOnInsufficientBalance() { return false }' : 'export default ""', loader: 'js' }))
} }] })
if (!build.success) throw new AggregateError(build.logs, 'Failed to bundle canvas mobile test')
const assets = join(root, 'apps/electron/dist/renderer/assets')
const baseCss = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
if (!baseCss) throw new Error('Build the renderer before running the mobile UI checks')
await writeFile(join(directory, 'base.css'), await readFile(join(assets, baseCss)))
await writeFile(join(directory, 'android.css'), await readFile(join(root, 'apps/webui/src/android-ui.css')))
await writeFile(join(directory, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="base.css"><link rel="stylesheet" href="android.css"><link rel="stylesheet" href="canvas-mobile.browser.css"><style>body{margin:0;overflow:hidden}</style></head><body><script type="module" src="canvas-mobile.browser.js"></script></body></html>')
await writeFile(join(directory, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  win.webContents.on('console-message', event => { if(event.level === 'error') console.error(event.message); });
  let snapshotPrefix = '';
  win.webContents.on('console-message', async event => {
    if(!event.message.startsWith('__CANVAS_CAPTURE:')) return;
    try {
      const bitmap = await win.webContents.capturePage();
      require('fs').writeFileSync(snapshotPrefix + '-' + event.message.split(':')[1] + '.png', bitmap.toPNG());
      await win.webContents.executeJavaScript('window.mobileCaptureDone()');
    } catch(error) { console.error(error); app.exit(1); }
  });
  const checks = [];
  for(const [width,height,android] of [[320,568,false],[390,844,false],[844,390,false],[390,844,true],[1280,800,false]]) {
    win.setContentSize(width,height);
    await win.loadFile(${JSON.stringify(join(directory, 'index.html'))});
    win.webContents.enableDeviceEmulation({screenPosition:'mobile',screenSize:{width,height},viewSize:{width,height},deviceScaleFactor:1,scale:1});
    snapshotPrefix = ${JSON.stringify(join(root, '.tmp/canvas-mobile-'))} + width + 'x' + height + (android ? '-android' : '');
    if (${screenshots} && width < 1000) await win.webContents.executeJavaScript('window.mobileCapture = phase => new Promise(resolve => { window.mobileCaptureDone = resolve; console.info("__CANVAS_CAPTURE:" + phase) }); void 0');
    const result = await win.webContents.executeJavaScript('window.runMobileChecks(' + width + ',' + height + ',' + android + ').then(checks => ({ checks }), error => ({ error: error.stack || String(error) }))');
    if(result.error) throw new Error(result.error);
    checks.push(...result.checks.map(check => width+'x'+height+(android?' Android':'')+': '+check));
  }
  console.log(JSON.stringify({passed:checks.length,checks})); app.exit(0);
}).catch(error => { console.error(error.stack || error); app.exit(1); });
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executable = join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
const child = spawn(executable, [join(directory, 'main.cjs')], { env, windowsHide: true, stdio: 'inherit' })
const timeout = setTimeout(() => { child.kill(); console.error('Canvas mobile test timed out') }, 60_000)
process.exitCode = await new Promise<number>((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => resolveExit(code ?? 1)) }).finally(() => clearTimeout(timeout))
