import { isAbsolute, relative, resolve } from 'node:path'

/** Resolve only files inside the packaged draw.io directory. */
export function resolveStudioAsset(root: string, rawPath: string): string | null {
  let pathname: string
  try { pathname = decodeURIComponent(rawPath) } catch { return null }
  if (pathname.includes('\\') || pathname.includes('\0')) return null
  if (pathname.split('/').some(segment => segment === '..' || segment === '.')) return null
  const base = resolve(root)
  const file = resolve(base, pathname.replace(/^\/+/, ''))
  const rel = relative(base, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return file
}
