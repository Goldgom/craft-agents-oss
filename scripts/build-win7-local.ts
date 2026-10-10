import { build as bundle } from 'esbuild'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build as buildUi } from 'vite'
import { prepareWin7Dependencies } from './prepare-win7-dependencies'
const require = createRequire(import.meta.url)
const rewritePattern = require('regexpu-core')
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const local = join(root, 'apps/win7-local')
const output = join(local, 'dist/app')
mkdirSync(join(output, 'runtime'), { recursive: true })
const plugins: import('esbuild').Plugin[] = [{
  name: 'win7-only-node16-compat',
  setup(build) {
    build.onResolve({ filter: /^undici$/ }, () => ({ path: join(local, 'compat-undici.mjs') }))
    build.onResolve({ filter: /^node:crypto$/ }, () => ({ path: join(local, 'compat-crypto.mjs') }))
    build.onResolve({ filter: /^(node:)?child_process$/ }, args => args.importer.endsWith('compat-child-process.mjs')
      ? { path: 'child_process', external: true } : { path: join(local, 'compat-child-process.mjs') })
    build.onLoad({ filter: /pi-tui[\\/]dist[\\/]utils\.js$/ }, args => ({
      contents: readFileSync(args.path, 'utf8').replace(/const (\w+) = \/(.*)\/v;/g, (_match, name, pattern) =>
        `const ${name} = new RegExp(${JSON.stringify(rewritePattern(pattern, 'v', { unicodeSetsFlag: 'transform', unicodePropertyEscapes: 'transform' }))}, 'u');`), loader: 'js',
    }))
    build.onLoad({ filter: /pi-coding-agent[\\/]dist[\\/]core[\\/]package-manager\.js$/ }, args => ({
      contents: readFileSync(args.path, 'utf8').replace('globSync,', '').replace('import { chmodSync',
        `import { globSync } from ${JSON.stringify(join(local, 'compat-glob.mjs'))};\nimport { chmodSync`), loader: 'js',
    }))
    build.onLoad({ filter: /backend[\\/]internal[\\/]runtime-resolver\.ts$/ }, args => ({
      contents: readFileSync(args.path, 'utf8')
        .replace('const bundledRuntimePath = hostRuntime.nodeRuntimePath || resolveBundledRuntimePath(hostRuntime);', 'const bundledRuntimePath = process.execPath;')
        .replace('function resolveServerPath(hostRuntime: BackendHostRuntimeContext, serverName: string): string | undefined {',
          `function resolveServerPath(hostRuntime: BackendHostRuntimeContext, serverName: string): string | undefined {\nreturn join(process.env.TOKENBIRD_WIN7_RUNTIME!, serverName + '.mjs');`)
        .replace('function resolveInterceptorBundlePath(hostRuntime: BackendHostRuntimeContext): string | undefined {',
          `function resolveInterceptorBundlePath(hostRuntime: BackendHostRuntimeContext): string | undefined {\nreturn join(process.env.TOKENBIRD_WIN7_RUNTIME!, 'interceptor.cjs');`), loader: 'ts',
    }))
    build.onLoad({ filter: /agent[\\/]backend[\\/]factory\.ts$/ }, args => {
      const source = readFileSync(args.path, 'utf8')
      const original = 'session: { id: `test-${now}`, workspaceRootPath: cwd, workingDirectory: cwd, createdAt: 0, lastUsedAt: 0 },'
      if (!source.includes(original)) throw new Error('Connection-test compatibility patch needs review')
      return { contents: source.replace('const cwd = homedir();', 'const cwd = process.env.TOKENBIRD_CONFIG_DIR!;'), loader: 'ts' }
    })
    build.onLoad({ filter: /main[\\/]chat-export\.ts$/ }, args => {
      const source = readFileSync(args.path, 'utf8')
      const start = source.indexOf('    return await sharp({')
      const end = source.indexOf('.toBuffer()', start) + '.toBuffer()'.length
      if (start < 0 || end < start) throw new Error('Chat export compatibility patch needs review')
      const composite = `    const png = await win.webContents.executeJavaScript('(' + (function(input) {
        return Promise.all(input.tiles.map(tile => new Promise((resolve, reject) => {
          const image = new Image(); image.onload = () => resolve({ image, top: tile.top }); image.onerror = reject; image.src = tile.data;
        }))).then(images => {
          const canvas = document.createElement('canvas'); canvas.width = input.width; canvas.height = input.height;
          const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas unavailable');
          context.fillStyle = '#ffffff'; context.fillRect(0, 0, input.width, input.height);
          for (const tile of images) context.drawImage(tile.image, 0, tile.top);
          const result = canvas.toDataURL('image/png'); if (result === 'data:,') throw new Error('Conversation exceeds Win7 PNG canvas limits; use PDF'); return result;
        });
      }).toString() + ')(' + JSON.stringify({ width, height, tiles: tiles.map(tile => ({ top: tile.top, data: 'data:image/png;base64,' + tile.input.toString('base64') })) }) + ')');
      return Buffer.from(png.split(',')[1], 'base64')`
      return { contents: (source.slice(0, start) + composite + source.slice(end))
        .replace("import sharp from 'sharp'", '')
        .replace('webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },',
          'webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false },')
        .replace('      const image = await win.webContents.capturePage(', '      win.webContents.invalidate();\n      const image = await win.webContents.capturePage(')
        .replace("        { stayHidden: true, stayAwake: true },\n", ''), loader: 'ts' }
    })
    build.onLoad({ filter: /main[\\/]network-proxy\.ts$/ }, args => ({
      contents: readFileSync(args.path, 'utf8')
        .replace("from '@craft-agent/shared/config/storage'", `from ${JSON.stringify(join(root, 'packages/shared/src/config/storage.ts'))}`)
        .replace("import { BROWSER_PANE_SESSION_PARTITION } from './browser-pane-manager';", "const BROWSER_PANE_SESSION_PARTITION = 'persist:win7-browser';")
        .replace("import log from './logger';", 'const log = { info: () => {}, warn: console.warn, error: console.error };'), loader: 'ts',
    }))
    build.onLoad({ filter: /main[\\/]runtime-toolchains\.ts$/ }, args => ({
      contents: readFileSync(args.path, 'utf8').replace("from '@craft-agent/shared/config/storage'", `from ${JSON.stringify(join(root, 'packages/shared/src/config/storage.ts'))}`), loader: 'ts',
    }))
  },
}]
const common = { bundle: true, platform: 'node' as const, target: 'node16', plugins, external: ['electron', 'sharp', 'koffi', '@craft-agent/messaging-gateway'], logLevel: 'warning' as const }
await bundle({ ...common, entryPoints: [join(local, 'compat.cjs')], outfile: join(output, 'runtime/compat.cjs'), format: 'cjs' })
await bundle({ ...common, entryPoints: [join(local, 'backend.ts')], outfile: join(output, 'backend.cjs'), format: 'cjs',
  define: { 'import.meta.url': '__win7BundleUrl', 'import.meta.dir': '__dirname', 'import.meta.dirname': '__dirname' },
  banner: { js: "const __win7BundleUrl = require('node:url').pathToFileURL(__filename).href;" },
})
await bundle({ ...common, entryPoints: [join(local, 'native-services.ts')], outfile: join(output, 'native-services.cjs'), format: 'cjs',
  define: { 'import.meta.url': '__win7BundleUrl', 'import.meta.dir': '__dirname', 'import.meta.dirname': '__dirname' },
  banner: { js: "const __win7BundleUrl = require('node:url').pathToFileURL(__filename).href;" },
})
for (const name of ['pi-agent-server', 'session-mcp-server', 'bridge-mcp-server']) {
  const entry = name === 'bridge-mcp-server' ? join(resourcesRoot(), 'bridge-mcp-server/index.js') : join(root, `packages/${name}/src/index.ts`)
  await bundle({ ...common, entryPoints: [entry], outfile: join(output, `runtime/${name}.mjs`), format: 'esm',
    banner: { js: "import { createRequire as _win7CreateRequire } from 'node:module'; const require = _win7CreateRequire(import.meta.url);" },
  })
}
await bundle({ ...common, entryPoints: [join(root, 'packages/shared/src/unified-network-interceptor.ts')], outfile: join(output, 'runtime/interceptor.cjs'), format: 'cjs' })
for (const file of ['main.cjs', 'preload.cjs', 'native-host.cjs', 'connection.cjs', 'installed-tools.cjs']) copyFileSync(join(local, file), join(output, file))
const resources = join(root, 'apps/electron/resources')
for (const dir of ['docs', 'themes', 'skills', 'permissions', 'tool-icons']) cpSync(join(resources, dir), join(output, 'resources', dir), { recursive: true })
copyFileSync(join(resources, 'config-defaults.json'), join(output, 'resources/config-defaults.json'))
copyFileSync(join(resources, 'icon.ico'), join(output, 'resources/icon.ico'))
const manifest = JSON.parse(readFileSync(join(local, 'package.json'), 'utf8'))
writeFileSync(join(output, 'package.json'), JSON.stringify({ name: 'tokenbird-win7-local', version: manifest.version, main: 'main.cjs', author: 'TokenNest', license: manifest.license, description: manifest.description }, null, 2))
if (!process.argv.includes('--backend-only')) {
  if (process.argv.includes('--reuse-ui')) {
    if (!existsSync(join(output, 'webui/index.html'))) throw new Error('No existing local UI; run win7:local:build without --reuse-ui first')
  } else await buildUi({ configFile: join(root, 'apps/webui/vite.config.ts'), mode: 'win7-local', logLevel: 'warn' })
}
console.log('Experimental Win7 local app built:', output)
if (process.argv.includes('--installer')) {
  prepareWin7Dependencies(root)
  const electronCache = join(root, '.toolchains/electron-22.3.27')
  const command = [Bun.which('node') || 'node', join(root, 'node_modules/electron-builder/cli.js'), '--config', join(local, 'electron-builder.yml'), '--win', '--x64', '--publish', 'never',
    ...(existsSync(join(electronCache, 'electron.exe')) ? [`--config.electronDist=${electronCache}`] : [])]
  const child = Bun.spawn(command, { cwd: local, stdout: 'inherit', stderr: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } })
  process.exitCode = await child.exited
  if (process.exitCode === 0) await import('./verify-win7-installer')
}
function resourcesRoot() { return join(root, 'apps/electron/resources') }
