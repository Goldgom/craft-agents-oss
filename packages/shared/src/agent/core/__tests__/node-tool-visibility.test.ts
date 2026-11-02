import { expect, test } from 'bun:test'
import { getSessionToolProxyDefs } from '../../backend/session-tool-defs'
import { assertSuperAgentTools, filterInteractionTools, filterSuperAgentTools } from '../browser-tool-policy'
import { checkSessionExecutionPolicy, clearSessionExecutionPolicy, setSessionExecutionPolicy } from '../session-execution-policy'
import { tmpdir } from 'node:os'

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

test('dynamic interaction advertises only routes permitted by execution policy', () => {
  const sessionId = 'dynamic-interaction-visibility'
  const tools = getSessionToolProxyDefs()
  setSessionExecutionPolicy(sessionId, { architecture: 'dynamic', nodeId: 'main', role: 'coordinator',
    rootPath: tmpdir(), readFiles: false, writeFiles: false, runPrograms: false, browser: false,
    allowSources: [], allowSubagents: false, fullControl: true })
  try {
    const visible = filterSuperAgentTools(tools, 'coordinator', 'dynamic')
    const names = visible.map(tool => tool.name)
    expect(names).toHaveLength(7)
    for (const name of ['super_agent_intent', 'super_agent_deliver', 'super_agent_work_list', 'super_agent_reports',
      'super_agent_health', 'super_agent_resource_catalog', 'super_agent_settings']) {
      expect(names).toContain(`mcp__session__${name}`)
    }
    for (const tool of visible) expect(checkSessionExecutionPolicy(sessionId, tool.name, { action: 'get' }).allowed).toBe(true)
    for (const name of ['get_session_info', 'collaboration_board', 'saved_credentials', 'send_agent_message',
      'super_agent_message', 'super_agent_dispatch', 'super_agent_task', 'super_agent_library']) {
      expect(names).not.toContain(`mcp__session__${name}`)
      expect(checkSessionExecutionPolicy(sessionId, `mcp__session__${name}`, { action: 'get' }).allowed).toBe(false)
    }
    expect(() => assertSuperAgentTools(visible, 'coordinator', 'dynamic')).not.toThrow()
    expect(() => assertSuperAgentTools(visible.filter(tool => !tool.name.endsWith('super_agent_reports')), 'coordinator', 'dynamic')).toThrow('super_agent_reports')
    expect(filterInteractionTools(tools, true, 'coordinator', 'dynamic')).toEqual(visible)
    expect(filterSuperAgentTools(tools, 'coordinator').some(tool => tool.name.endsWith('get_session_info'))).toBe(true)
  } finally { clearSessionExecutionPolicy(sessionId) }
})

test('dynamic planners and workers retain report and health routes without gaining delegation', () => {
  const tools = [...getSessionToolProxyDefs(), { name: 'Read' }, { name: 'Grep' }, { name: 'Write' }, { name: 'Bash' }]
  for (const role of ['orchestrator', 'worker'] as const) {
    const visible = filterSuperAgentTools(tools, role, 'dynamic')
    const names = visible.map(tool => tool.name)
    for (const name of ['super_agent_health', 'super_agent_work_list', 'super_agent_reports', 'super_agent_report', 'super_agent_resource_catalog']) {
      expect(names).toContain(`mcp__session__${name}`)
    }
    expect(names).not.toContain('mcp__session__call_llm')
    expect(names).not.toContain('mcp__session__spawn_session')
    expect(() => assertSuperAgentTools(visible, role, 'dynamic')).not.toThrow()
    if (role === 'orchestrator') {
      expect(names).toContain('Read')
      expect(names).toContain('Grep')
      expect(names).toContain('mcp__session__super_agent_settings')
      expect(names).toContain('mcp__session__super_agent_manage_resources')
      for (const name of ['Write', 'Bash', 'mcp__session__get_session_info', 'mcp__session__super_agent_deliver']) expect(names).not.toContain(name)
    } else {
      expect(names).not.toContain('mcp__session__super_agent_manage_resources')
      expect(names).not.toContain('mcp__session__super_agent_dispatch')
    }
  }
})


test('v2 tools separate raw intake, goal planning, dispatch and execution across visibility and policy', () => {
  const tools = [...getSessionToolProxyDefs(), { name: 'Read' }, { name: 'Write' }, { name: 'Bash' }]
  for (const role of ['coordinator', 'planner', 'orchestrator', 'worker'] as const) {
    const sessionId = `topology-tools-${role}`
    setSessionExecutionPolicy(sessionId, { architecture: 'dynamic', roleTopologyVersion: 2, nodeId: role, role,
      rootPath: tmpdir(), fullControl: true, readFiles: true, writeFiles: true, runPrograms: true, browser: true, allowSources: [], allowSubagents: false })
    try {
      const visible = filterSuperAgentTools(tools, role, 'dynamic', 2)
      expect(() => assertSuperAgentTools(visible, role, 'dynamic', 2)).not.toThrow()
      const names = visible.map(tool => tool.name.replace('mcp__session__', ''))
      if (role !== 'coordinator') {
        const recoveryTool = visible.find(tool => tool.name === 'mcp__session__super_agent_task')!
        expect(recoveryTool).toBeDefined()
        expect(checkSessionExecutionPolicy(sessionId, recoveryTool.name, { action: 'recover', operationId: 'op1', requestId: 'repair1', note: 'Original host receipts' }).allowed).toBe(true)
      }
      const routes = ['super_agent_submit_request', 'super_agent_intent', 'super_agent_plan', 'super_agent_dispatch', 'super_agent_accept', 'super_agent_deliver']
      const allowed = role === 'coordinator' ? ['super_agent_submit_request', 'super_agent_deliver'] : role === 'planner'
        ? ['super_agent_intent', 'super_agent_plan'] : role === 'orchestrator' ? ['super_agent_dispatch', 'super_agent_accept'] : []
      for (const name of routes) {
        expect(names.includes(name)).toBe(allowed.includes(name))
        expect(checkSessionExecutionPolicy(sessionId, `mcp__session__${name}`, {}).allowed).toBe(allowed.includes(name))
      }
      if (role !== 'worker') { expect(names).not.toContain('Write'); expect(names).not.toContain('Bash') }
    } finally { clearSessionExecutionPolicy(sessionId) }
  }
})
