import { expect, test } from 'bun:test'
import { getSessionToolProxyDefs } from '../../backend/session-tool-defs'
import { assertSuperAgentTools, filterInteractionTools, filterSuperAgentTools } from '../browser-tool-policy'

test('registered schemas survive role filtering for intent handoff, orchestration and worker execution', () => {
  const tools = [...getSessionToolProxyDefs(), { name: 'Read' }, { name: 'Bash' }, { name: 'mcp__research__search' }, { name: 'mcp__other__super_agent_intent' }]
  const names = (role: 'coordinator' | 'orchestrator' | 'worker') => filterSuperAgentTools(tools, role).map(tool => tool.name)
  for (const name of ['super_agent_intent', 'super_agent_deliver', 'super_agent_message']) expect(names('coordinator')).toContain(`mcp__session__${name}`)
  for (const name of ['super_agent_dispatch', 'super_agent_plan', 'super_agent_accept', 'super_agent_resources', 'super_agent_message']) expect(names('orchestrator')).toContain(`mcp__session__${name}`)
  for (const role of ['coordinator', 'orchestrator'] as const) {
    for (const name of ['Read', 'Bash', 'mcp__session__browser_tool', 'mcp__session__computer_use', 'mcp__research__search', 'mcp__other__super_agent_intent']) expect(names(role)).not.toContain(name)
  }
  for (const name of ['Read', 'Bash', 'mcp__research__search', 'mcp__session__super_agent_task', 'mcp__session__super_agent_resources']) expect(names('worker')).toContain(name)
  for (const name of ['super_agent_intent', 'super_agent_deliver', 'super_agent_dispatch', 'super_agent_accept', 'call_llm', 'spawn_session']) expect(names('worker')).not.toContain(`mcp__session__${name}`)
  if (process.platform === 'win32') expect(names('worker')).toContain('mcp__session__computer_use')
  expect(filterSuperAgentTools(tools)).toBe(tools)
  const legacy = filterInteractionTools(tools, true).map(tool => tool.name)
  expect(legacy).toContain('mcp__session__super_agent_intent')
  expect(legacy).toContain('mcp__session__super_agent_dispatch')
  expect(legacy).not.toContain('Read')
  for (const role of ['coordinator', 'orchestrator', 'worker'] as const) {
    expect(names(role)).toContain('mcp__session__saved_credentials')
    expect(() => assertSuperAgentTools(filterSuperAgentTools(tools, role), role)).not.toThrow()
    expect(() => assertSuperAgentTools([{ name: 'mcp__session__send_agent_message' }], role)).toThrow('tools are unavailable')
  }
})
