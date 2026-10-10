import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

export function prepareWin7Dependencies(root: string) {
  const local = join(root, 'apps/win7-local')
  const source = join(root, 'win7_dependencies')
  const output = join(local, 'dist/installer-payload')
  const specs = JSON.parse(readFileSync(join(local, 'installer/dependencies.json'), 'utf8')) as Array<Record<string, string>>
  const expected = new Set(specs.map(spec => spec.file))
  const files = readdirSync(source, { withFileTypes: true })
  if (files.some(file => !file.isFile() || !expected.has(file.name))) throw new Error('Unconfigured win7_dependencies entry; update installer/dependencies.json and selection page first')
  mkdirSync(output, { recursive: true })
  // Fail on stale staged payloads rather than silently shipping an older package.
  const allowed = new Set([...expected, 'manifest.ini', '7za.exe', '7zip-LICENSE.txt', 'install-dependencies.ps1'])
  if (readdirSync(output).some(file => !allowed.has(file))) throw new Error('Unexpected stale installer-payload entry')
  const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
  const extractor = join(root, 'node_modules/7zip-bin/win/x64/7za.exe')
  let manifest = ''
  for (const spec of specs) {
    const file = join(source, spec.file)
    if (!existsSync(file)) throw new Error(`Missing offline dependency: ${file}`)
    if (spec.kind === 'archive') {
      const listing = execFileSync(extractor, ['l', '-slt', file], { encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024 })
      const entries = listing.slice(listing.indexOf('----------') + 10)
      const paths = [...entries.matchAll(/^Path = (.+)$/gm)].map(match => match[1]!.trim().replaceAll('\\', '/'))
      if (!paths.length || paths.some(path => path !== spec.root && !path.startsWith(spec.root + '/') || /[:\x00]/.test(path) || path.split('/').some(part => part === '..' || part === '.'))
        || /^(Symbolic Link|Hard Link) = /m.test(entries)) throw new Error(`Unsafe archive layout: ${spec.file}`)
      if (!paths.includes(`${spec.root}/${spec.executable}`)) throw new Error(`Missing executable in ${spec.file}`)
    }
    copyFileSync(file, join(output, spec.file))
    manifest += `[${spec.id}]\r\n` + Object.entries(spec).filter(([key]) => key !== 'id').map(([key, value]) => `${key}=${value}\r\n`).join('') + `sha256=${hash(file)}\r\n`
  }
  copyFileSync(extractor, join(output, '7za.exe'))
  copyFileSync(join(root, 'node_modules/7zip-bin/LICENSE.txt'), join(output, '7zip-LICENSE.txt'))
  // BOM lets Windows PowerShell 2 correctly decode non-ASCII script text.
  writeFileSync(join(output, 'install-dependencies.ps1'), '\ufeff' + readFileSync(join(local, 'installer/install-dependencies.ps1'), 'utf8'))
  manifest += `[extractor]\r\nsha256=${hash(extractor)}\r\n`
  writeFileSync(join(output, 'manifest.ini'), '\ufeff' + manifest)
  console.log('Prepared verified offline dependency payload:', output)
}
