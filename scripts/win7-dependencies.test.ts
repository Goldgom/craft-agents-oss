import { describe, expect, test, beforeAll, afterAll, setDefaultTimeout } from 'bun:test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const { readInstalledTools, applyInstalledToolEnvironment } = createRequire(import.meta.url)('../apps/win7-local/installed-tools.cjs')
setDefaultTimeout(60000)
const root = resolve(import.meta.dir, '..')
const helper = join(root, 'apps/win7-local/installer/install-dependencies.ps1')
const extractor = join(root, 'node_modules/7zip-bin/win/x64/7za.exe')
const suite = process.platform === 'win32' ? describe : describe.skip
const scratch = mkdtempSync(join(tmpdir(), 'tokenbird-dependency-test-'))
const payload = join(scratch, 'payload')
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
const ini = (data: Record<string, Record<string, string>>) => Object.entries(data).map(([id, values]) => `[${id}]\r\n` + Object.entries(values).map(([key, value]) => `${key}=${value}\r\n`).join('')).join('')
let counter = 0
let manifest: Record<string, Record<string, string>>

beforeAll(() => {
  mkdirSync(payload)
  copyFileSync(extractor, join(payload, '7za.exe'))
  manifest = { extractor: { sha256: hash(extractor) } }
  for (const id of ['node', 'mingw']) {
    const dir = join(scratch, 'fixture-' + id)
    mkdirSync(join(dir, id, 'bin'), { recursive: true })
    // Inert text files: tests never launch an external runtime or installer.
    const exe = id === 'node' ? 'node.exe' : 'bin/gcc.exe'
    writeFileSync(join(dir, id, exe), 'not an executable')
    const archive = join(payload, id + '.zip')
    const archived = spawnSync(extractor, ['a', '-tzip', archive, id], { cwd: dir, encoding: 'utf8', windowsHide: true })
    if (archived.status !== 0) throw new Error(archived.stdout + archived.stderr)
    manifest[id] = { file: id + '.zip', kind: 'archive', root: id, executable: exe, path: id === 'node' ? '' : 'bin', sha256: hash(archive) }
  }
  for (const id of ['git', 'python', 'java', 'update']) {
    writeFileSync(join(payload, id + '.exe'), 'never execute this fixture')
    manifest[id] = { file: id + '.exe', kind: id === 'update' ? 'update' : 'installer', sha256: hash(join(payload, id + '.exe')) }
  }
  writeFileSync(join(payload, 'manifest.ini'), '\ufeff' + ini(manifest))
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function run(choices: Record<string, Record<string, string>>, dryRun = false) {
  const temp = join(scratch, 'case-' + counter++)
  mkdirSync(temp)
  const selection = join(temp, 'selection.ini')
  writeFileSync(selection, '\ufeff' + ini(choices))
  const state = join(temp, 'state')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-PayloadDirectory', payload, '-SelectionFile', selection, '-StateRoot', state, dryRun ? '-DryRun' : '-ExtractOnly'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  if (result.error) throw result.error
  return { ...result, state }
}

suite('Win7 optional dependency orchestration', () => {
  test('skips all packages without launching anything', () => {
    const result = run({})
    expect(result.status).toBe(0)
    expect(existsSync(join(result.state, 'installed-tools.ini'))).toBe(false)
  })
  test('dry-run plans every installer without installs, PATH edits or state writes', () => {
    const choices: Record<string, Record<string, string>> = {}
    for (const id of ['git', 'python', 'java', 'update', 'node', 'mingw']) choices[id] = { selected: '1', directory: join(scratch, 'dry-run-dir'), addPath: '1' }
    const result = run(choices, true)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Would open native installer')
    expect(result.stdout).toContain('WindowStyle=Normal; Verb=Open')
    expect(result.stdout).toContain('Arguments=/log "')
    expect(result.stdout).toContain('python-setup.log"')
    expect(result.stdout).not.toMatch(/Arguments=.*\/(quiet|passive|silent|verysilent)\b/i)
    expect(result.stdout).toContain('Would extract')
    expect(existsSync(result.state)).toBe(false)
    expect(existsSync(join(scratch, 'dry-run-dir'))).toBe(false)
  })
  test('extracts selected archives to Unicode/space paths and records executable/bin paths', () => {
    const directory = join(scratch, '工具 with spaces')
    const result = run({ node: { selected: '1', directory, addPath: '1' }, mingw: { selected: '1', directory, addPath: '1' } })
    if (result.status !== 0) throw new Error(result.stdout + result.stderr)
    expect(result.status).toBe(0)
    const tools = readInstalledTools(join(result.state, 'installed-tools.ini'))
    expect(tools.node.executable).toBe(join(directory, 'node', 'node.exe'))
    expect(tools.node.path).toBe(join(directory, 'node'))
    expect(tools.mingw.path).toBe(join(directory, 'mingw', 'bin'))
    const env = { PATH: 'C:\\existing' }
    applyInstalledToolEnvironment(tools, env)
    applyInstalledToolEnvironment(tools, env)
    expect(env.PATH.split(';').filter(part => part === tools.node.path)).toHaveLength(1)
    expect(env.PATH).toContain('C:\\existing')
  })
  test('refuses overwrite and preserves existing files', () => {
    const directory = join(scratch, '工具 with spaces')
    const result = run({ node: { selected: '1', directory, addPath: '0' } })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Target already exists')
    expect(readFileSync(join(directory, 'node/node.exe'), 'utf8')).toBe('not an executable')
  })
  test('rejects unsafe directory but continues another selected archive', () => {
    const directory = join(scratch, 'partial-success')
    const result = run({ node: { selected: '1', directory: 'C:\\bad;path' }, mingw: { selected: '1', directory } })
    expect(result.status).toBe(1)
    expect(existsSync(join(directory, 'mingw/bin/gcc.exe'))).toBe(true)
    expect(existsSync('C:\\bad;path')).toBe(false)
  })
  test('refuses tampered payloads before extracting or executing', () => {
    const original = readFileSync(join(payload, 'node.zip'))
    try {
      writeFileSync(join(payload, 'node.zip'), 'tampered')
      const directory = join(scratch, 'tamper-target')
      const result = run({ node: { selected: '1', directory } })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('SHA-256 mismatch')
      expect(existsSync(directory)).toBe(false)
    } finally { writeFileSync(join(payload, 'node.zip'), original) }
  })
  test('ignores missing, escaping and unknown installed-tool records', () => {
    const file = join(scratch, 'invalid-tools.ini')
    writeFileSync(file, ini({ node: { root: scratch, executable: 'C:\\missing.exe', path: scratch }, evil: { executable: 'C:\\evil.exe' } }))
    expect(Object.keys(readInstalledTools(file))).toHaveLength(0)
  })
})
