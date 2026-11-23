import { afterEach, expect, test } from 'bun:test'
import { authorizeSessionPolicyTool, checkSessionExecutionPolicy, clearSessionExecutionPolicy, setSessionActionReviewer,
  setSessionExecutionPolicy, setSessionPolicyPermissionHandler, type SessionExecutionPolicy } from '../session-execution-policy'

const sid = 'canvas-gif-policy', tool = 'mcp__session__canvas_tool'
const policy: SessionExecutionPolicy = { nodeId: 'gif-worker', role: 'worker', rootPath: process.cwd(),
  readFiles: false, writeFiles: false, runPrograms: false, browser: false, allowSources: [], allowSubagents: false }
afterEach(() => clearSessionExecutionPolicy(sid))

test('restricted GIF export waits for approval of the original parameters', async () => {
  setSessionExecutionPolicy(sid, policy)
  const input = { action: 'generate_gif', outputPath: 'C:\\exports\\selection.gif', gifMode: 'zoom' }
  let approve: ((value: boolean) => void) | undefined, received: unknown
  setSessionPolicyPermissionHandler(sid, request => { received = request.input; return new Promise(resolve => { approve = resolve }) })
  expect(checkSessionExecutionPolicy(sid, tool, input).allowed).toBe(false)
  const result = authorizeSessionPolicyTool(sid, tool, input)
  await Promise.resolve()
  expect(received).toEqual(input)
  approve!(true)
  expect((await result).allowed).toBe(true)
  expect(checkSessionExecutionPolicy(sid, tool, input).allowed).toBe(true)
  expect(checkSessionExecutionPolicy(sid, tool, { ...input, outputPath: 'C:\\exports\\other.gif' }).allowed).toBe(false)
})

test('full control skips GIF capability restrictions, custom denies and review; switching off restores them', async () => {
  setSessionExecutionPolicy(sid, { ...policy, fullControl: true, actionGates: true,
    safety: { autoReview: true, customRules: [{ toolName: tool, effect: 'deny', reason: 'restricted' }] } })
  setSessionPolicyPermissionHandler(sid, async () => { throw new Error('Unexpected approval') })
  setSessionActionReviewer(sid, async () => { throw new Error('Unexpected review') })
  expect((await authorizeSessionPolicyTool(sid, tool, { action: 'generate_gif' })).allowed).toBe(true)
  setSessionExecutionPolicy(sid, policy)
  expect(checkSessionExecutionPolicy(sid, tool, { action: 'generate_gif' }).allowed).toBe(false)
})
