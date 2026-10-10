import { build } from 'vite'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const client = join(root, 'apps/win7-client')
const output = join(client, 'dist/app')
mkdirSync(output, { recursive: true })
for (const file of ['main.cjs', 'preload.cjs', 'connection.cjs', 'settings.html', 'settings.js', 'settings.css']) {
  copyFileSync(join(client, file), join(output, file))
}
const manifest = JSON.parse(readFileSync(join(client, 'package.json'), 'utf8'))
writeFileSync(join(output, 'package.json'), JSON.stringify({
  name: 'tokenbird-win7-remote', version: manifest.version, description: manifest.description,
  license: manifest.license, author: 'TokenNest', main: 'main.cjs',
}, null, 2))

if (!process.argv.includes('--shell-only')) {
  await build({ configFile: join(root, 'apps/webui/vite.config.ts'), mode: 'win7' })
}
console.log('Win7 remote-only client built:', output)
if (process.argv.includes('--installer')) {
  // electron-builder and its download stack run under the host Node.js, not Bun.
  const command = [Bun.which('node') || 'node', join(root, 'node_modules/electron-builder/cli.js'),
    '--config', join(client, 'electron-builder.yml'), '--win', '--x64', '--publish', 'never']
  const subprocess = Bun.spawn(command, {
    cwd: client, stdout: 'inherit', stderr: 'inherit',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  })
  const code = await subprocess.exited
  if (code !== 0) process.exit(code)
  console.log('Experimental Win7 x64 installer:', join(client, 'release'))
}
