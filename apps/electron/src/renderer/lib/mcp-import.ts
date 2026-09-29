import type { McpSourceConfig } from '@craft-agent/shared/sources'

export interface McpImportEntry {
  name: string
  mcp: McpSourceConfig
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
  const root = JSON.parse(text) as unknown
  const data = record(root)
  const servers = data?.mcpServers ?? root
  const entries: Array<[string, unknown]> = Array.isArray(servers)
    ? servers.map((value, index) => [String(record(value)?.name ?? `MCP ${index + 1}`), value])
    : Object.entries(record(servers) ?? {})
  if (entries.length === 0) throw new Error('No MCP servers found')

  return entries.map(([name, value]) => {
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
    const authType = config.authType === 'bearer' || config.authType === 'oauth' ? config.authType : 'none'
    return { name: name.trim(), mcp: { transport, url, headers, authType } }
  })
}
