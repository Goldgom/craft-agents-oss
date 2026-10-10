import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SuperAgentArchive, SuperAgentLibraryCommand, SuperAgentState } from '@craft-agent/shared/super-agent'

const MAX_FILE = 64 * 1024 * 1024
const MAX_TOTAL = 256 * 1024 * 1024
function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
function safeRelative(path: string): string {
  if (isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || path.includes('\0')) {
    throw new Error('Invalid archive member path')
  }
  return path
}
async function removeTemporary(root: string, path: string): Promise<void> {
  // All recursive deletions target a directory exclusively created by this call.
  if (resolve(path) === resolve(root) || !inside(resolve(root), resolve(path))) throw new Error('Unsafe temporary archive path')
  await rm(path, { recursive: true, force: true })
}
async function copyVerified(source: string, destination: string, expected?: SuperAgentArchive['files'][number]) {
  const before = await lstat(source)
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE) throw new Error('Archive files must be regular files up to 64 MB; links are not supported')
  const hash = createHash('sha256'); let size = 0
  await mkdir(dirname(destination), { recursive: true })
  await pipeline(createReadStream(source), new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length
    if (size > MAX_FILE) { callback(new Error('Archive file exceeded 64 MB')); return }
    hash.update(chunk); callback(null, chunk)
  } }), createWriteStream(destination, { flags: 'wx', mode: before.mode & 0o777 }))
  const after = await lstat(source)
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || size !== after.size) {
    throw new Error('Source changed during archiving; stop the writer and retry')
  }
  const sha256 = hash.digest('hex')
  if (expected && (size !== expected.size || sha256 !== expected.sha256)) throw new Error('Archive integrity check failed')
  return { size, sha256 }
}

async function scanTree(source: string) {
  const files: Array<{ path: string; source: string; stamp: string; size: number }> = []
  const directories: string[] = []
  let bytes = 0
  const stamp = (info: Awaited<ReturnType<typeof lstat>>) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
  async function visit(target: string, path: string): Promise<void> {
    const info = await lstat(target)
    if (info.isSymbolicLink()) throw new Error('Archive sources cannot contain symbolic links or junctions')
    if (info.isDirectory()) {
      if (path) directories.push(safeRelative(path))
      if (directories.length + files.length > 2000) throw new Error('Archive exceeds 2000 entries; select a smaller project directory')
      for (const child of (await readdir(target)).sort()) await visit(join(target, child), path ? `${path}/${child}` : child)
    } else if (info.isFile()) {
      bytes += info.size
      if (info.size > MAX_FILE || bytes > MAX_TOTAL) throw new Error('Archive limit: 64 MB per file, 256 MB per snapshot')
      files.push({ path: safeRelative(path || basename(target)), source: target, stamp: stamp(info), size: info.size })
      if (directories.length + files.length > 2000) throw new Error('Archive exceeds 2000 entries; select a smaller project directory')
    } else throw new Error('Archive sources must contain only regular files and directories')
  }
  await visit(source, '')
  return { files, directories }
}

export async function createSuperAgentArchive(workspaceRoot: string, executionRoot: string, input: Extract<SuperAgentLibraryCommand, { type: 'archive-create' }>['item'], actor: string, now: number, taskId?: string): Promise<SuperAgentArchive> {
  const root = await realpath(executionRoot)
  const requested = resolve(root, input.sourcePath)
  if (!inside(root, requested)) throw new Error('Archive source must be inside the execution folder')
  const source = await realpath(requested)
  if (!inside(root, source)) throw new Error('Archive source resolves outside the execution folder')
  // Do not turn a junction into an ordinary source directory by resolving it first.
  let ancestor = requested
  while (ancestor !== root && inside(root, ancestor)) {
    if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('Archive sources cannot contain symbolic links or junctions')
    ancestor = dirname(ancestor)
  }
  const control = await realpath(workspaceRoot)
  if (inside(source, control) || inside(control, source)) throw new Error('Archive source overlaps protected workspace storage')
  const tree = await scanTree(source)
  const directory = join(control, 'super-agent', 'archive')
  await mkdir(directory, { recursive: true })
  const id = `archive_${randomUUID().replace(/-/g, '')}`
  const temporary = join(directory, `${id}.tmp`)
  await mkdir(temporary)
  try {
    const files: SuperAgentArchive['files'] = []
    for (const path of tree.directories) await mkdir(join(temporary, path), { recursive: true })
    for (const file of tree.files) {
      if (!inside(root, await realpath(file.source))) throw new Error('Source escaped the execution folder')
      files.push({ path: file.path, ...await copyVerified(file.source, join(temporary, file.path)) })
    }
    if (JSON.stringify(tree) !== JSON.stringify(await scanTree(source)) || await realpath(requested) !== source) throw new Error('Source tree changed during archiving; stop the writer and retry')
    await rename(temporary, join(directory, id))
    return { ...input, id, sourcePath: source, sourceKind: (await stat(source)).isDirectory() ? 'directory' : 'file',
      createdAt: now, createdBy: actor, taskId, files, directories: tree.directories }
  } catch (error) { await removeTemporary(directory, temporary); throw error }
}

/** Restore into a new directory only. Never replace current project files. */
export async function restoreSuperAgentArchive(workspaceRoot: string, executionRoot: string, archive: SuperAgentArchive, destination: string): Promise<string> {
  const root = await realpath(executionRoot)
  const target = resolve(root, destination)
  if (target === root || !inside(root, target)) throw new Error('Restore into a new directory inside the execution folder')
  const parent = await realpath(dirname(target))
  if (!inside(root, parent)) throw new Error('Restore parent resolves outside the execution folder')
  const control = await realpath(workspaceRoot)
  if (inside(control, target) || inside(target, control)) throw new Error('Restore overlaps protected workspace storage')
  if (await lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) throw new Error('Restore destination already exists; choose a new directory')
  if (!/^archive_[a-f0-9]{32}$/.test(archive.id)) throw new Error('Invalid archive identity')
  const archiveRoot = await realpath(join(control, 'super-agent', 'archive', archive.id))
  if (!inside(control, archiveRoot)) throw new Error('Archive resolves outside workspace storage')
  const temporary = join(parent, `.tokenbird-restore-${randomUUID()}`)
  await mkdir(temporary)
  try {
    for (const path of archive.directories) await mkdir(join(temporary, safeRelative(path)), { recursive: true })
    for (const file of archive.files) {
      const source = join(archiveRoot, safeRelative(file.path))
      if (!inside(archiveRoot, await realpath(source))) throw new Error('Archive member escaped storage')
      await copyVerified(source, join(temporary, file.path), file)
    }
    if (await realpath(dirname(target)) !== parent) throw new Error('Restore parent changed')
    // Exclusive creation reserves the destination, including an empty snapshot.
    await mkdir(target)
    try {
      for (const child of await readdir(temporary)) await rename(join(temporary, child), join(target, child))
    } catch (error) { await removeTemporary(parent, target); throw error }
    await removeTemporary(parent, temporary)
    return target
  } catch (error) { await removeTemporary(parent, temporary); throw error }
}

export function updateSuperAgentMemory(state: SuperAgentState, command: Extract<SuperAgentLibraryCommand, { type: 'memory-upsert' | 'memory-delete' }>, actor: string, now: number) {
  const memories = state.memories ??= []
  const id = command.type === 'memory-delete' ? command.id : command.item.id ?? `memory_${randomUUID().replace(/-/g, '')}`
  const existing = memories.find(item => item.id === id)
  if ((existing?.revision ?? 0) !== command.expectedRevision) throw new Error('Memory changed; retrieve the latest revision before editing')
  if (command.type === 'memory-delete') {
    if (!existing) throw new Error('Memory does not exist')
    state.memories = memories.filter(item => item.id !== id)
    return { deleted: id }
  } else {
    if (!existing && memories.length >= 1000) throw new Error('Memory library is full; remove obsolete entries')
    const item = { ...command.item, id, revision: command.expectedRevision + 1, createdAt: existing?.createdAt ?? now, updatedAt: now, updatedBy: actor }
    if (existing) Object.assign(existing, item); else memories.push(item)
    return item
  }
}
