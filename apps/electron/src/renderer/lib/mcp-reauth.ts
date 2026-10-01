import type { LoadedSource } from '../../shared/types'

export function mcpReauthMode(source: LoadedSource): 'oauth' | 'credential' | null {
  const { type, mcp } = source.config
  if (type !== 'mcp' || !mcp || mcp.transport === 'stdio') return null
  // Header credentials take precedence, including legacy OAuth-labelled sources.
  if (mcp.headerNames?.length) return 'credential'
  if (mcp.authType === 'oauth') return 'oauth'
  return mcp.authType === 'bearer' ? 'credential' : null
}

export function serializeMcpCredential(headerNames: string[], values: Record<string, string>): string {
  return headerNames.length
    ? JSON.stringify(Object.fromEntries(headerNames.map(name => [name, values[name]?.trim() ?? ''])))
    : (values.token ?? '').trim()
}