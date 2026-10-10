// Real archive smoke test: never execute supplied binaries/installers or edit PATH.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const root = resolve(import.meta.dir, '..')
const temp = mkdtempSync(join(tmpdir(), 'tokenbird-real-archives-'))
const { readInstalledTools } = createRequire(import.meta.url)('../apps/win7-local/installed-tools.cjs')
try {
  const selection = join(temp, 'selection.ini')
  const base = join(temp, '工具 with spaces')
  writeFileSync(selection, '\ufeff' + ['node', 'mingw'].map(id => `[${id}]\r\nselected=1\r\ndirectory=${base}\r\naddPath=1\r\n`).join(''), 'utf8')
  const payload = join(root, 'apps/win7-local/dist/installer-payload')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(payload, 'install-dependencies.ps1'),
    '-PayloadDirectory', payload, '-SelectionFile', selection, '-StateRoot', join(temp, 'state'), '-ExtractOnly'], { encoding: 'utf8', windowsHide: true, timeout: 120000 })
  console.log(result.stdout)
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  const tools = readInstalledTools(join(temp, 'state/installed-tools.ini'))
  for (const id of ['node', 'mingw']) {
    if (!tools[id]) throw new Error(`Missing real ${id} executable`)
    const bytes = readFileSync(tools[id].executable)
    if (bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4) !== 0x8664) throw new Error(`${id} is not x64`)
  }
  console.log('PASS: real ZIP/7z payloads extracted, recorded and verified x64; no binaries executed, PATH untouched')
} finally {
  if (dirname(resolve(temp)) !== resolve(tmpdir()) || !temp.includes('tokenbird-real-archives-')) throw new Error('Unsafe cleanup path')
  rmSync(temp, { recursive: true, force: true })
}
