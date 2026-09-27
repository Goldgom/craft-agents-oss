import type { SessionFile } from '@craft-agent/shared/protocol'

export function workspaceDataRelativePath(linkedPath: string, workspaceRootPath: string): string | null {
  const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')
  const root = normalize(workspaceRootPath)
  const linked = normalize(linkedPath)
  const prefix = `${root}/data/`
  const isWindowsPath = /^[a-z]:\//i.test(root)
  const matchesRoot = isWindowsPath
    ? linked.toLowerCase().startsWith(prefix.toLowerCase())
    : linked.startsWith(prefix)
  if (!matchesRoot) return null

  const parts = linked.slice(prefix.length).split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return null
  return parts.join('/')
}

/** Find a session output when an agent linked to workspace/data instead of sessions/<id>/data. */
export function findSessionDataLink(
  linkedPath: string,
  workspaceRootPath: string,
  sessionFiles: SessionFile[],
): string | null {
  const relativePath = workspaceDataRelativePath(linkedPath, workspaceRootPath)
  if (!relativePath) return null
  const parts = relativePath.split('/')

  let entries = sessionFiles.find(file => file.type === 'directory' && file.name === 'data')?.children
  for (let index = 0; index < parts.length; index++) {
    const entry = entries?.find(file => file.name === parts[index])
    if (!entry) return null
    if (index === parts.length - 1) return entry.type === 'file' ? entry.path : null
    if (entry.type !== 'directory') return null
    entries = entry.children
  }
  return null
}
