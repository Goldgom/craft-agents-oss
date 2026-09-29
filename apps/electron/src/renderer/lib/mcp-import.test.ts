import { describe, expect, it } from 'bun:test'
import { parseMcpImport } from './mcp-import'

describe('parseMcpImport', () => {
  it('imports standard mcpServers JSON with HTTP and stdio entries', () => {
    const entries = parseMcpImport(JSON.stringify({ mcpServers: {
      remote: { url: 'https://example.com/mcp', headers: { 'X-Client': 'test' } },
      local: { command: 'npx', args: ['-y', 'sample-server'], env: { MODE: 'test' } },
    } }))
    expect(entries).toEqual([
      { name: 'remote', mcp: { transport: 'http', url: 'https://example.com/mcp', headers: { 'X-Client': 'test' }, authType: 'none' } },
      { name: 'local', mcp: { transport: 'stdio', command: 'npx', args: ['-y', 'sample-server'], env: { MODE: 'test' } } },
    ])
  })

  it('rejects malformed server entries before any import starts', () => {
    expect(() => parseMcpImport('{"mcpServers":{"broken":{"args":["-y"]}}}')).toThrow('Invalid URL')
    expect(() => parseMcpImport('{"mcpServers":{"broken":{"command":"npx","args":"-y"}}}')).toThrow('Invalid args')
  })
})
