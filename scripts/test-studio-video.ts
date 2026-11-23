import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dir, '..')
const directory = await mkdtemp(join(tmpdir(), 'tokenbird-video-ui-'))
const build = await Bun.build({
  entrypoints: [join(root, 'apps/electron/src/renderer/pages/video/video-studio.browser.tsx')],
  outdir: directory, target: 'browser', tsconfig: join(root, 'apps/electron/tsconfig.json'),
  plugins: [{ name: 'video-host-boundaries', setup(builder) {
    builder.onResolve({ filter: /\/AppShellContext$|\/PageSidebar$|\/PageSidebarContext$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents:
      args.path.endsWith('AppShellContext') ? 'export function useAppShellContext(){return window.videoStudioContext}' :
      args.path.endsWith('PageSidebarContext') ? 'export function usePageSidebar(){return null}' :
      `import React from 'react'; export function PageSidebar({children}){return <aside>{children}</aside>}`, loader: 'tsx' }))
  } }],
})
if (!build.success) throw new AggregateError(build.logs, 'Failed to bundle Video Studio UI checks')
const styles = (await readdir(join(root, 'apps/electron/dist/renderer/assets'))).find(name => /^index-.*\.css$/.test(name))
await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${styles ? `<link rel="stylesheet" href="${pathToFileURL(join(root, 'apps/electron/dist/renderer/assets', styles)).href}">` : ''}<style>html,body{margin:0;height:100%;overflow:hidden}</style></head><body><script>window.keepVideoStudioForScreenshot=true</script><script type="module" src="video-studio.browser.js"></script></body></html>`)
await writeFile(join(directory, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');
app.disableHardwareAcceleration();
app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,offscreen:true}});
  await win.loadFile(${JSON.stringify(join(directory, 'index.html'))});
  console.log('Video Studio fixture loaded');
  const result=await win.webContents.executeJavaScript('window.runVideoStudioChecks().then(checks=>({checks}),error=>({error:error.stack||String(error)}))');
  if(result.error)throw new Error(result.error);
  console.log(JSON.stringify({passed:result.checks.length,checks:result.checks}));
  await new Promise(resolve=>setTimeout(resolve,500));
  const screenshot=await win.webContents.capturePage();require('fs').writeFileSync(${JSON.stringify(join(root, 'reports/video-studio-ui.png'))},screenshot.toPNG());
  console.log('Video Studio screenshot saved');app.exit(0);
}).catch(error=>{console.error(error.stack||error);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executable = join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
const child = spawn(executable, [join(directory, 'main.cjs')], { env, windowsHide: true, stdio: 'inherit' })
const timeout = setTimeout(() => { child.kill(); console.error('Video Studio UI checks timed out') }, 60_000)
process.exitCode = await new Promise<number>((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => resolveExit(code ?? 1)) }).finally(() => clearTimeout(timeout))
