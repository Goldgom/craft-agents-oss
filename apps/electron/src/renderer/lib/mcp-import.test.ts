import { describe, expect, it } from 'bun:test'
import { parseMcpImport } from './mcp-import'

describe('parseMcpImport', () => {
  it('imports standard mcpServers JSON with HTTP and stdio entries', () => {
    const entries = parseMcpImport(JSON.stringify({ mcpServers: {
      remote: { url: 'https://example.com/mcp', headers: { 'X-Client': 'test' } },
      local: { command: 'npx', args: ['-y', 'sample-server'], env: { MODE: 'test' } },
    } }))
    expect(entries).toEqual([
      { name: 'remote', mcp: { transport: 'http', url: 'https://example.com/mcp', headerNames: ['X-Client'], authType: 'none' }, credential: '{"X-Client":"test"}' },
      { name: 'local', mcp: { transport: 'stdio', command: 'npx', args: ['-y', 'sample-server'], env: { MODE: 'test' } } },
    ])
  })

  it('rejects malformed server entries before any import starts', () => {
    expect(() => parseMcpImport('{"mcpServers":{"broken":{"args":["-y"]}}}')).toThrow('Invalid URL')
    expect(() => parseMcpImport('{"mcpServers":{"broken":{"command":"npx","args":"-y"}}}')).toThrow('Invalid args')
  })
})

describe('MCP credential imports', () => {
  it('extracts bearer authorization into encrypted credential input', () => {
    const result = parseMcpImport('{"remote":{"url":"https://example.invalid/mcp","headers":{"authorization":"Bearer dummy-token","X-Client":"dummy-client"}}}')[0]!
    expect(JSON.parse(result.credential!)).toEqual({ authorization: 'Bearer dummy-token', 'X-Client': 'dummy-client' })
    expect(result.mcp.authType).toBe('none')
    expect(result.mcp.headers).toBeUndefined()
    expect(result.mcp.headerNames).toEqual(['authorization', 'X-Client'])
    expect(JSON.stringify(result.mcp)).not.toContain('dummy-token')
  })
  it('accepts explicit batch credentials and rejects incomplete or ambiguous auth', () => {
    expect(parseMcpImport('{"remote":{"url":"https://example.invalid","authType":"bearer","credential":"dummy-token"}}')[0]!.credential).toBe('dummy-token')
    expect(() => parseMcpImport('{"remote":{"url":"https://example.invalid","authType":"bearer"}}')).toThrow('require a valid credential')
    expect(() => parseMcpImport('{"remote":{"url":"https://user:dummy-secret@example.invalid"}}')).toThrow('not the URL')
    try { parseMcpImport('{"secret":"dummy-secret",}') } catch (error) { expect(String(error)).not.toContain('dummy-secret') }
  })
})

 it('rejects case-insensitive header duplicates and encrypts non-bearer Authorization', () => {
    expect(() => parseMcpImport(JSON.stringify({ remote: { url: 'https://example.invalid', headers: { Authorization: 'Bearer dummy-first', authorization: 'Bearer dummy-second' } } }))).toThrow('Duplicate MCP header names')
    const basic = parseMcpImport(JSON.stringify({ remote: { url: 'https://example.invalid', headers: { Authorization: 'Basic dummy-basic', 'X-API-Key': 'dummy-key' } } }))[0]!
    expect(JSON.stringify(basic.mcp)).not.toContain('dummy-basic')
    expect(JSON.stringify(basic.mcp)).not.toContain('dummy-key')
    expect(JSON.parse(basic.credential!)).toEqual({ Authorization: 'Basic dummy-basic', 'X-API-Key': 'dummy-key' })
  })
