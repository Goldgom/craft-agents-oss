import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { createRequire } from 'node:module'
const root = resolve(import.meta.dir, '..')
const local = join(root, 'apps/win7-local')
const version = JSON.parse(readFileSync(join(local, 'package.json'), 'utf8')).version
const installer = join(local, 'release', `TokenBird-Win7-Local-OriginalUI-Tools-${version}-x64-Setup.exe`)
const bytes = readFileSync(installer)
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const dependencies = JSON.parse(readFileSync(join(local, 'installer/dependencies.json'), 'utf8'))
// SetCompress off means offline payload files are embedded verbatim. Check the
// final EXE rather than just the staging directory, without running any setup.
for (const file of [...dependencies.map((spec: { file: string }) => spec.file), '7za.exe', '7zip-LICENSE.txt', 'manifest.ini', 'install-dependencies.ps1']) {
  const payload = readFileSync(join(local, 'dist/installer-payload', file))
  const offset = bytes.indexOf(payload)
  if (offset < 0) throw new Error(`Payload absent or altered in final installer: ${file}`)
  console.log(JSON.stringify({ file, bytes: payload.length, offset, sha256: hash(payload) }))
}
const executable = readFileSync(join(local, 'release/win-unpacked/TokenBird-Win7-Local.exe'))
const peOffset = executable.readUInt32LE(0x3c)
if (executable.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error('Application is not x64')
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const archive = join(local, 'release/win-unpacked/resources/app.asar')
const entries: string[] = asar.listPackage(archive).map((entry: string) => entry.replaceAll('\\', '/'))
if (entries.some(entry => entry.includes('win7_dependencies') || /settings\.(js|html)$/.test(entry))) throw new Error('Unexpected legacy UI/duplicate payload in ASAR')
if (!entries.some(entry => entry.endsWith('/installed-tools.cjs'))) throw new Error('Missing installed tool integration')
const digest = hash(bytes)
writeFileSync(installer + '.sha256', `${digest}  ${basename(installer)}\r\n`)
console.log(JSON.stringify({ installer, bytes: bytes.length, MiB: bytes.length / 1024 / 1024, sha256: digest, applicationMachine: '0x8664', offlinePayloads: dependencies.length }, null, 2))
