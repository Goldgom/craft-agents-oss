import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorizeSessionPolicyTool, checkSessionExecutionPolicy, clearSessionExecutionPolicy, setSessionActionReviewer, setSessionExecutionPolicy, setSessionPolicyPermissionHandler, setSessionProgramExecutor, type SessionExecutionPolicy, type SessionPolicyPermissionRequest } from '../session-execution-policy'
import { classifyActionGate } from '../action-gates'

const sid = 'video-permissions'
const tool = 'mcp__session__video_tool'
let temp: string, root: string, policy: SessionExecutionPolicy
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'tokenbird-video-policy-')); root = join(temp, 'work'); mkdirSync(root)
  policy = { nodeId: 'video-worker', role: 'worker', rootPath: root, readFiles: false, writeFiles: false, runPrograms: false, browser: false, allowSources: [], allowSubagents: false }
  setSessionExecutionPolicy(sid, policy)
})
afterEach(() => { clearSessionExecutionPolicy(sid); rmSync(temp, { recursive: true, force: true }) })

describe('Video Studio permissions', () => {
  test('missing capabilities suspend the exact operation and approval resumes it', async () => {
    const requests: SessionPolicyPermissionRequest[] = []
    setSessionPolicyPermissionHandler(sid, async request => { requests.push(request); return true })
    const input = { action: 'generate_shot', args: { projectId: 'project', shotId: 'shot' } }
    expect(checkSessionExecutionPolicy(sid, tool, input).allowed).toBe(false)
    expect((await authorizeSessionPolicyTool(sid, tool, input, root)).allowed).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.input).toEqual(input)
    expect(checkSessionExecutionPolicy(sid, tool, input).allowed).toBe(true)
    expect(checkSessionExecutionPolicy(sid, tool, { ...input, args: { ...input.args, shotId: 'other' } }).allowed).toBe(false)
  })
  test('full control bypasses switches, source allowlists, rules, gates and auto-review', async () => {
    setSessionExecutionPolicy(sid, { ...policy, fullControl: true, actionGates: true, safety: { autoReview: true, customRules: [{ toolName: tool, effect: 'deny', reason: 'restricted' }] } })
    setSessionPolicyPermissionHandler(sid, async () => { throw new Error('Must not request approval') })
    setSessionActionReviewer(sid, async () => { throw new Error('Must not review') })
    for (const action of ['state', 'import_asset', 'edit', 'generate_shot', 'generate_project', 'render_project']) {
      expect((await authorizeSessionPolicyTool(sid, tool, { action, args: {} }, root)).allowed).toBe(true)
    }
    setSessionExecutionPolicy(sid, policy)
    expect(checkSessionExecutionPolicy(sid, tool, { action: 'edit' }).allowed).toBe(false)
  })
  test('roles, one model process and selected container stay architectural boundaries', async () => {
    for (const role of ['coordinator', 'planner', 'orchestrator'] as const) {
      setSessionExecutionPolicy(sid, { ...policy, role, architecture: 'dynamic', fullControl: true })
      expect(checkSessionExecutionPolicy(sid, tool, { action: 'edit' }).allowed).toBe(false)
    }
    setSessionExecutionPolicy(sid, { ...policy, fullControl: true })
    expect(checkSessionExecutionPolicy(sid, tool, { action: 'analyze' }).allowed).toBe(false)
    expect(checkSessionExecutionPolicy(sid, tool, { action: 'generate_project', args: { analyzeFirst: true } }).allowed).toBe(false)
    const runtimePath = join(temp, 'docker.exe'); writeFileSync(runtimePath, 'verified test runtime')
    setSessionProgramExecutor(sid, { runtimePath, containerId: 'video-worker', workingDirectory: '/workspace' })
    expect(checkSessionExecutionPolicy(sid, tool, { action: 'edit' }).allowed).toBe(false)
    expect(checkSessionExecutionPolicy(sid, tool, { action: 'generate_shot' }).allowed).toBe(false)
    expect(checkSessionExecutionPolicy(sid, tool, { action: 'state' }).allowed).toBe(true)
  })
  test('file import approvals bind the canonical nested path and cannot be replayed for another path', async () => {
    const source = join(temp, 'clip.mp4'); writeFileSync(source, 'clip')
    const input = { action: 'import_asset', args: { path: source } }
    setSessionPolicyPermissionHandler(sid, async () => true)
    expect((await authorizeSessionPolicyTool(sid, tool, input, root)).allowed).toBe(true)
    expect(checkSessionExecutionPolicy(sid, tool, { action: 'import_asset', args: { path: join(temp, 'other.mp4') } }, root).allowed).toBe(false)
  })
  test('paid generation uses financial action gates; reads remain read-only', () => {
    expect(classifyActionGate(tool, { action: 'generate_shot' })).toBe('financial')
    expect(classifyActionGate(tool, { action: 'edit' })).toBe('state-change')
    expect(classifyActionGate(tool, { action: 'state' })).toBeUndefined()
  })
})
