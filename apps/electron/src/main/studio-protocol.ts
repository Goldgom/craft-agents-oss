import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { resolveStudioAsset } from './studio-protocol-path'

const SCHEME = 'tokenbird-studio'
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
}

export function registerStudioScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  }])
}

export function registerStudioHandler(): void {
  const root = join(__dirname, 'renderer', 'drawio')
  protocol.handle(SCHEME, async request => {
    let url: URL
    try { url = new URL(request.url) } catch { return new Response(null, { status: 400 }) }
    if (url.hostname !== 'drawio') return new Response(null, { status: 404 })
    const file = resolveStudioAsset(root, url.pathname)
    if (!file) return new Response(null, { status: 404 })
    try {
      const bytes = await readFile(file)
      return new Response(bytes, { headers: { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' } })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}
