#!/usr/bin/env bun
/** Build the separate 云服务器端 distribution, with a bundled Bun executable. */
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dir, '..')
const arch = process.argv.includes('--arch=arm64') ? 'arm64' : 'x64'
const output = resolve(root, 'dist', 'cloud-server', `linux-${arch}`)
mkdirSync(output, { recursive: true })
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
  if (await child.exited !== 0) throw new Error(`Cloud server build failed: ${args[0]}`)
}
await run(['run', 'webui:build'])
await run(['build', 'packages/cloud-server/src/index.ts', '--compile', `--target=bun-linux-${arch}`, `--outfile=${join(output, 'tokenbird-cloud')}`])
cpSync(join(root, 'apps/webui/dist'), join(output, 'webui'), { recursive: true })
// Local deployment credentials must never be bundled, including in reused output folders.
cpSync(join(root, 'deploy/cloud'), join(output, 'deploy'), { recursive: true, filter: source => basename(source) !== 'cloud.env' })
rmSync(join(output, 'deploy', 'cloud.env'), { force: true })
cpSync(join(root, 'docs/cloud-server.md'), join(output, 'README.md'))
writeFileSync(join(output, 'start.sh'), '#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\nset -a\n. ./deploy/cloud.env\nset +a\nexec ./tokenbird-cloud\n', { mode: 0o755 })
const version = (await Bun.file(join(root, 'package.json')).json()).version
const archive = join(root, 'dist', 'cloud-server', `tokenbird-cloud-server-${version}-linux-${arch}.tar.gz`)
// The cloud executable is at the archive root, so explicitly set its mode.
const tar = await import('tar')
await tar.c({ cwd: output, file: archive, gzip: true, portable: true, onWriteEntry(entry) { if (entry.stat && (entry.path.endsWith('/tokenbird-cloud') || entry.path === 'tokenbird-cloud' || entry.path.endsWith('start.sh'))) entry.stat.mode = 0o755 } }, ['.'])
const bytes = await Bun.file(archive).arrayBuffer()
writeFileSync(archive + '.sha256', createHash('sha256').update(Buffer.from(bytes)).digest('hex') + '\n')
console.log(`云服务器端: ${archive}`)
