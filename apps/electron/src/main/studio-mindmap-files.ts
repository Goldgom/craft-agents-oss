import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

const idPattern = /^(?:[0-9a-f-]{36}|studio-mindmap-first)$/i
const skipped = new Set(['.git', '.tokenbird', 'node_modules', 'dist', 'build', '.next', 'coverage', 'vendor'])
const textFile = /^(?:README|AGENTS|package\.json|tsconfig\.json|pyproject\.toml|Cargo\.toml|go\.mod)$|\.(?:md|txt|ts|tsx|js|jsx|py|json|yaml|yml|toml|go|rs|java|cs|c|h|cpp|hpp|sql)$/i

async function root(directory: string): Promise<string> {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('请先选择工作目录')
  const resolved = await realpath(directory)
  if (!(await stat(resolved)).isDirectory()) throw new Error('工作目录不存在')
  return resolved
}

async function sessionPath(directory: string, id: string): Promise<string> {
  if (!idPattern.test(id)) throw new Error('无效的导图会话 ID')
  return join(await root(directory), '.tokenbird', 'mindmaps', `${id}.json`)
}

export async function readMindMapSession(directory: string, id: string): Promise<string> {
  try { return await readFile(await sessionPath(directory, id), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
}

export async function writeMindMapSession(directory: string, id: string, data: string): Promise<void> {
  const path = await sessionPath(directory, id)
  await mkdir(join(await root(directory), '.tokenbird', 'mindmaps'), { recursive: true })
  await writeFile(path, data, 'utf8')
}

export async function deleteMindMapSession(directory: string, id: string): Promise<void> {
  await rm(await sessionPath(directory, id), { force: true })
}

export async function mindMapWorkspaceContext(directory: string): Promise<string> {
  const base = await root(directory)
  const files: string[] = []
  async function visit(folder: string, depth: number) {
    if (depth > 2 || files.length >= 30) return
    let entries: Dirent[]
    try { entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)) }
    catch { return }
    for (const entry of entries) {
      if (files.length >= 30) break
      if (entry.isSymbolicLink() || skipped.has(entry.name) || entry.name.startsWith('.')) continue
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await visit(path, depth + 1)
      else if (entry.isFile() && textFile.test(entry.name)) {
        try { if ((await stat(path)).size <= 64_000) files.push(path) } catch { /* Skip unreadable files. */ }
      }
    }
  }
  await visit(base, 0)
  let result = `工作目录：${base}\n以下是工作目录中可读取的部分文本文件（最多 30 个，总计约 30 KB）：\n`
  for (const file of files) {
    if (result.length >= 30_000) break
    try {
      const content = await readFile(file, 'utf8')
      result += `\n--- ${file.slice(base.length + 1)} ---\n${content.slice(0, Math.min(4000, 30_000 - result.length))}\n`
    } catch { /* The file may have been removed after scanning. */ }
  }
  return result.slice(0, 32_000)
}
