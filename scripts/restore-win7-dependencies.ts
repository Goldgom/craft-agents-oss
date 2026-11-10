import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'

export function restoreWin7Dependencies(root: string) {
  const directory = join(root, 'win7_dependencies')
  const manifestPath = join(directory, 'files.json')
  if (!existsSync(manifestPath)) return // Existing test fixtures use original files.
  const entries = JSON.parse(readFileSync(manifestPath, 'utf8')) as Array<{file: string; size: number; sha256: string; parts?: string[]}>
  const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
  for (const entry of entries) {
    for (const name of [entry.file, ...(entry.parts ?? [])]) {
      if (!name || /[\\/:]/.test(name) || name === '.' || name === '..') throw new Error('Unsafe dependency manifest path')
    }
    const target = join(directory, entry.file)
    if (existsSync(target)) {
      const data = readFileSync(target)
      if (data.length !== entry.size || hash(data) !== entry.sha256) throw new Error(`Dependency checksum mismatch: ${entry.file}`)
      continue
    }
    if (!entry.parts?.length) throw new Error(`Missing dependency: ${entry.file}`)
    const data = Buffer.concat(entry.parts.map(part => readFileSync(join(directory, part))))
    if (data.length !== entry.size || hash(data) !== entry.sha256) throw new Error(`Dependency parts checksum mismatch: ${entry.file}`)
    writeFileSync(target + '.restoring', data)
    renameSync(target + '.restoring', target)
  }
}
if (import.meta.main) restoreWin7Dependencies(resolve(import.meta.dir, '..'))
