import { afterEach, expect, test } from 'bun:test'
import { SUPER_AGENT_ACTION_TOOLS } from '@tokenbird/session-tools-core/super-agent-tools'
import { classifyActionGate } from '../action-gates'
import { checkSessionExecutionPolicy, clearSessionExecutionPolicy, setSessionExecutionPolicy } from '../session-execution-policy'

const sessionId = 'registered-collaboration-policy'
afterEach(() => clearSessionExecutionPolicy(sessionId))
test('internal collaboration tools respect node roles and reject lookalike source tools', () => {
  for (const fullControl of [false, true]) {
    setSessionExecutionPolicy(sessionId, { nodeId: 'worker', role: 'worker', rootPath: process.cwd(), readFiles: false, writeFiles: false, runPrograms: false, browser: false, allowSources: [], allowSubagents: false, actionGates: true, fullControl })
    for (const name of ['super_agent_dispatch', 'super_agent_plan', 'super_agent_accept', 'super_agent_intent', 'super_agent_deliver']) {
      expect(checkSessionExecutionPolicy(sessionId, `mcp__session__${name}`, {}).allowed).toBe(false)
    }
    for (const name of ['super_agent_board', 'super_agent_message', 'super_agent_resources']) {
      expect(checkSessionExecutionPolicy(sessionId, `mcp__session__${name}`, {}).allowed).toBe(true)
      expect(checkSessionExecutionPolicy(sessionId, `mcp__other__${name}`, {}).allowed).toBe(false)
    }
  }
  for (const tool of SUPER_AGENT_ACTION_TOOLS) {
    expect(classifyActionGate(`mcp__session__${tool.name}`, {})).toBe(tool.name === 'super_agent_manage_resources' ? 'state-change' : undefined)
    expect(classifyActionGate(`mcp__unassigned__${tool.name}`, {})).toBeDefined()
  }
})
