import { describe, expect, it } from 'bun:test'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { PoolClient } from '../client.ts'
import { getCachedMcpSourceTools, McpClientPool } from '../mcp-pool.ts'

class TestMcpClientPool extends McpClientPool {
  async discover(sourceSlug: string, tools: Tool[]): Promise<void> {
    const client: PoolClient = {
      listTools: async () => tools,
      callTool: async () => ({ content: [] }),
      close: async () => undefined,
    }
    await this.registerClient(sourceSlug, client)
  }
}

describe('MCP tool catalog cache', () => {
  it('exposes tools discovered by a live pool without reconnecting the source', async () => {
    const workspaceRootPath = `test-workspace-${crypto.randomUUID()}`
    const pool = new TestMcpClientPool({ workspaceRootPath })

    expect(getCachedMcpSourceTools(workspaceRootPath, 'linear')).toBeUndefined()

    await pool.discover('linear', [{
      name: 'create_issue',
      description: 'Create an issue.',
      inputSchema: { type: 'object' },
    }])

    expect(getCachedMcpSourceTools(workspaceRootPath, 'linear')).toEqual([{
      name: 'create_issue',
      description: 'Create an issue.',
    }])
  })

  it('returns a defensive copy of cached metadata', async () => {
    const workspaceRootPath = `test-workspace-${crypto.randomUUID()}`
    const pool = new TestMcpClientPool({ workspaceRootPath })
    await pool.discover('source', [{ name: 'first', inputSchema: { type: 'object' } }])

    const cached = getCachedMcpSourceTools(workspaceRootPath, 'source')
    cached?.push({ name: 'mutated' })

    expect(getCachedMcpSourceTools(workspaceRootPath, 'source')).toEqual([{ name: 'first', description: undefined }])
  })
})
