import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { getSessionScopedTools, cleanupSessionScopedTools } from './session-scoped-tools'
import { setSessionExecutionPolicy, clearSessionExecutionPolicy } from './core/session-execution-policy'

test.each([undefined, 'dynamic'] as const)('Claude MCP exposes live role schemas across cached session changes (%s)', async architecture => {
  const sessionId = 'node-tools-mcp'
  try {
    for (const role of ['coordinator', 'orchestrator', 'worker'] as const) {
      setSessionExecutionPolicy(sessionId, { architecture, nodeId: role, role, rootPath: process.cwd(), readFiles: true, writeFiles: true, runPrograms: true, browser: true, allowSources: [], allowSubagents: false })
      const sdk = getSessionScopedTools(sessionId, process.cwd())
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: 'node-schema-check', version: '1' })
      try {
        await sdk.instance.connect(serverTransport)
        await client.connect(clientTransport)
        const { tools } = await client.listTools()
        const names = tools.map(tool => tool.name)
        if (role === 'coordinator') {
          expect(names).toContain('super_agent_intent')
          expect(names).toContain('super_agent_deliver')
          expect(names).not.toContain('super_agent_dispatch')
          if (architecture === 'dynamic') {
            for (const name of ['super_agent_work_list', 'super_agent_reports', 'super_agent_health', 'super_agent_settings']) expect(names).toContain(name)
            for (const name of ['get_session_info', 'collaboration_board', 'saved_credentials', 'super_agent_message']) expect(names).not.toContain(name)
          }
        } else if (role === 'orchestrator') {
          for (const name of ['super_agent_dispatch', 'super_agent_plan', 'super_agent_accept', 'super_agent_resources']) expect(names).toContain(name)
          expect(names).not.toContain('super_agent_deliver')
        } else {
          expect(names).toContain('super_agent_task')
          expect(names).toContain('super_agent_resources')
          if (process.platform === 'win32') expect(names).toContain('computer_use')
          expect(names).not.toContain('call_llm')
        }
      } finally { await client.close(); await sdk.instance.close() }
    }
  } finally { clearSessionExecutionPolicy(sessionId); cleanupSessionScopedTools(sessionId) }
}, 30_000)
