import type { McpSourceConfig } from '@craft-agent/shared/sources'

export interface McpImportEntry {
  name: string
  mcp: McpSourceConfig
  credential?: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const object = record(value)
  if (!object || !Object.values(object).every(item => typeof item === 'string')) return undefined
  return object as Record<string, string>
}

export function parseMcpImport(text: string): McpImportEntry[] {
  let root: unknown
  try { root = JSON.parse(text) } catch { throw new Error('Invalid MCP JSON') }
  const data = record(root)
  const servers = data?.mcpServers ?? root
  const entries: Array<[string, unknown]> = Array.isArray(servers)
    ? servers.map((value, index) => [String(record(value)?.name ?? `MCP ${index + 1}`), value])
    : Object.entries(record(servers) ?? {})
  if (entries.length === 0) throw new Error('No MCP servers found')
  if (entries.length > 100) throw new Error('Import at most 100 MCP servers at a time')

  return entries.map(([name, value]): McpImportEntry => {
    const config = record(value)
    if (!config || !name.trim()) throw new Error(`Invalid MCP server: ${name}`)
    const url = typeof config.url === 'string' ? config.url.trim() : ''
    const command = typeof config.command === 'string' ? config.command.trim() : ''
    const transport = config.transport === 'sse' || config.type === 'sse' ? 'sse' : 'http'
    const headers = config.headers === undefined ? undefined : stringMap(config.headers)
    const env = config.env === undefined ? undefined : stringMap(config.env)
    if (config.headers !== undefined && !headers) throw new Error(`Invalid headers: ${name}`)
    if (config.env !== undefined && !env) throw new Error(`Invalid env: ${name}`)
    if (command) {
      if (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every(arg => typeof arg === 'string'))) {
        throw new Error(`Invalid args: ${name}`)
      }
      return { name: name.trim(), mcp: { transport: 'stdio', command, args: config.args as string[] | undefined, env } }
    }
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error()
    } catch { throw new Error(`Invalid URL: ${name}`) }
    if (config.authType !== undefined && !['none', 'bearer', 'oauth'].includes(String(config.authType))) throw new Error('Unsupported MCP authentication type')
    let authType: McpSourceConfig['authType'] = config.authType === 'bearer' || config.authType === 'oauth' ? config.authType : 'none'
    let credential: string | undefined
    const importedHeaders = { ...headers }
    const names = Object.keys(importedHeaders)
    if (new Set(names.map(key => key.toLowerCase())).size !== names.length) throw new Error('Duplicate MCP header names')
    if (names.some(key => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || !importedHeaders[key]?.trim() || /[\x00-\x1f\x7f\u0100-\uffff]/.test(importedHeaders[key]!))) throw new Error('Invalid MCP header')
    const authorization = names.find(key => key.toLowerCase() === 'authorization')
    if (config.credential !== undefined) {
      if (typeof config.credential !== 'string' || !config.credential.trim() || /[\x00-\x1f\x7f\u0100-\uffff]/.test(config.credential)) throw new Error('Invalid MCP credential')
      credential = config.credential.trim()
      if (authorization && importedHeaders[authorization] !== `Bearer ${credential}`) throw new Error('Conflicting MCP credentials')
      authType = 'bearer'
    }
    if (new URL(url).username || new URL(url).password) throw new Error('Put credentials in the credential field, not the URL')
    if (names.length) {
      // Custom HTTP headers may contain passwords/API keys, including Basic
      // Authorization. Store all their values in the vault, never config.json.
      if (authType === 'oauth') throw new Error('Import OAuth sources without custom headers, then configure headers separately')
      if (credential && !authorization) importedHeaders.Authorization = `Bearer ${credential}`
      if (authType === 'bearer' && !credential && !authorization) throw new Error('Bearer MCP servers require a valid credential')
      return { name: name.trim(), mcp: { transport, url, authType: 'none', headerNames: Object.keys(importedHeaders) }, credential: JSON.stringify(importedHeaders) }
    }
    if (authType === 'bearer' && !credential) throw new Error('Bearer MCP servers require a valid credential')
    return { name: name.trim(), mcp: { transport, url, authType }, ...(credential ? { credential } : {}) }
  })
}
