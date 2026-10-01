import { describe, expect, test } from 'bun:test'
import type { LoadedSource } from '../../../shared/types'
import { mcpReauthMode, serializeMcpCredential } from '../mcp-reauth'

const source = (mcp: LoadedSource['config']['mcp']) => ({ config: { type: 'mcp', mcp } }) as LoadedSource

describe('MCP manual reauthentication', () => {
  test('selects OAuth and bearer flows', () => {
    expect(mcpReauthMode(source({ authType: 'oauth' }))).toBe('oauth')
    expect(mcpReauthMode(source({ authType: 'bearer' }))).toBe('credential')
  })
  test('does not offer credential editing for public or stdio sources', () => {
    expect(mcpReauthMode(source({ authType: 'none' }))).toBeNull()
    expect(mcpReauthMode(source({ authType: 'bearer', transport: 'stdio' }))).toBeNull()
  })
  test('header credentials override the OAuth label', () => {
    expect(mcpReauthMode(source({ authType: 'oauth', headerNames: ['X-Key'] }))).toBe('credential')
  })
  test('serializes even one header as an object and omits unrelated fields', () => {
    expect(serializeMcpCredential(['X-Key'], { 'X-Key': ' secret ', token: 'ignored' })).toBe('{"X-Key":"secret"}')
    expect(serializeMcpCredential(['X-Key', 'X-Account'], { 'X-Key': 'a', 'X-Account': 'b' })).toBe('{"X-Key":"a","X-Account":"b"}')
    expect(serializeMcpCredential([], { token: ' token ' })).toBe('token')
  })
})