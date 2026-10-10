import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyActionGate, reviewActionGate } from '../action-gates.ts';
import { authorizeSessionPolicyTool, checkSessionExecutionPolicy, claimSessionActionGateDispatch, clearSessionExecutionPolicy, clearSessionPolicyGrants,
  consumeSessionActionGate, wrapSessionProgramInput, setSessionActionReviewer, setSessionExecutionPolicy, setSessionPolicyPermissionHandler, setSessionProgramExecutor, type SessionExecutionPolicy, type SessionPolicyPermissionRequest } from '../session-execution-policy.ts';
import { runPreToolUseChecksWithPermissions } from '../pre-tool-use.ts';
import { PermissionManager } from '../permission-manager.ts';
import { cleanupModeState, setPermissionMode } from '../../mode-manager.ts';
import { canShareSuperAgentPermission } from '../../../super-agent/browser.ts';

const sessionId = 'mandatory-action-gates';
let temp: string, root: string;
let policy: SessionExecutionPolicy;
let requests: SessionPolicyPermissionRequest[];
const authorize = (tool: string, input: Record<string, unknown>, id: string) => authorizeSessionPolicyTool(sessionId, tool, input, root, undefined, id);

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'tokenbird-gate-test-'));
  root = join(temp, 'work'); mkdirSync(root);
  policy = { nodeId: 'worker', role: 'worker', rootPath: root, fullControl: false, actionGates: true,
    readFiles: true, writeFiles: true, runPrograms: true, browser: true, allowSources: ['assigned'], allowSubagents: false };
  setSessionExecutionPolicy(sessionId, policy); setPermissionMode(sessionId, 'allow-all');
  requests = []; setSessionPolicyPermissionHandler(sessionId, async request => { requests.push(request); return true; });
});
afterEach(() => { clearSessionExecutionPolicy(sessionId); cleanupModeState(sessionId); rmSync(temp, { recursive: true, force: true }); });

describe('mandatory Action Gates', () => {
  test('library reads and memory records are autonomous; restoring files requires an exact approval', async () => {
    const tool = 'mcp__session__super_agent_library';
    for (const type of ['library-list', 'library-get', 'memory-upsert', 'memory-delete']) {
      expect((await authorize(tool, { type }, type)).allowed).toBe(true);
    }
    expect(requests).toHaveLength(0);
    const input = { type: 'archive-restore', id: 'archive-test', destination: 'restored' };
    expect(checkSessionExecutionPolicy(sessionId, tool, input).allowed).toBe(false);
    expect((await authorize(tool, input, 'restore-1')).allowed).toBe(true);
    expect(requests[0]?.scope.actionGate?.category).toBe('state-change');
    expect(checkSessionExecutionPolicy(sessionId, tool, { ...input, destination: 'other' }, root, 'restore-1').allowed).toBe(false);
    expect(consumeSessionActionGate(sessionId, tool, input, root, 'restore-1').allowed).toBe(true);
    expect((await authorize(tool, input, 'restore-1')).allowed).toBe(false);
  });
  test('library operations retain role, capability, source and custom deny restrictions', async () => {
    const tool = 'mcp__session__super_agent_library';
    setSessionExecutionPolicy(sessionId, { ...policy, readFiles: false, writeFiles: false });
    expect((await authorize(tool, { type: 'archive-create', item: { title: 'Version', sourcePath: '.' } }, 'copy')).allowed).toBe(false);
    expect((await authorize(tool, { type: 'archive-restore', id: 'x', destination: 'restored' }, 'restore')).allowed).toBe(false);
    expect(requests).toHaveLength(0);
    setSessionExecutionPolicy(sessionId, { ...policy, role: 'coordinator', fullControl: true });
    expect(checkSessionExecutionPolicy(sessionId, tool, { type: 'library-get', library: 'memory', id: 'x' }).allowed).toBe(true);
    expect(checkSessionExecutionPolicy(sessionId, tool, { type: 'memory-delete', id: 'x', expectedRevision: 1 }).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'mcp__unassigned__super_agent_library', { type: 'library-get' }).allowed).toBe(false);
    setSessionExecutionPolicy(sessionId, { ...policy, fullControl: true, safety: { autoReview: false, customRules: [{ toolName: tool, effect: 'deny', reason: 'Library disabled' }] } });
    expect(checkSessionExecutionPolicy(sessionId, tool, { type: 'library-list' }).allowed).toBe(false);
  });
  test('full control skips all approvals and Auto-review at authorization and both dispatch stages', async () => {
    setSessionExecutionPolicy(sessionId, { ...policy, fullControl: true,
      readFiles: false, writeFiles: false, runPrograms: false, browser: false,
      safety: { autoReview: true, customRules: [{ toolName: 'Write', effect: 'require-human', reason: 'Review writes' }] } });
    let reviews = 0;
    setSessionActionReviewer(sessionId, async () => { reviews++; return { verdict: 'deny', reason: 'Must not run' }; });
    const runtime = join(temp, 'docker.exe'); writeFileSync(runtime, 'test runtime');
    setSessionProgramExecutor(sessionId, { runtimePath: runtime, containerId: 'verified-container', workingDirectory: '/workspace' });
    for (const [tool, input] of [
      ['Write', { file_path: join(root, 'file.txt'), content: 'direct' }],
      ['Write', { file_path: join(temp, 'outside.txt'), content: 'direct' }],
      ['Read', { file_path: join(temp, 'outside.txt') }],
      ['mcp__assigned__send_email', { to: 'customer', body: 'direct' }],
      ['mcp__assigned__buy_resource', { resource: 'cloud' }], ['mcp__assigned__merge_pr', { pr: 123 }],
      ['mcp__assigned__unknown', {}], ['mcp__session__browser_tool', { command: ['click', '@e1'] }],
      ['Bash', { command: 'python3 change.py' }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect((await authorizeSessionPolicyTool(sessionId, tool, input, root)).allowed).toBe(true);
      expect(consumeSessionActionGate(sessionId, tool, input, root).allowed).toBe(true);
      expect(claimSessionActionGateDispatch(sessionId, tool, input, root, 'no-lease').allowed).toBe(true);
    }
    expect(reviews).toBe(0); expect(requests).toHaveLength(0);
    setSessionExecutionPolicy(sessionId, policy);
    expect(checkSessionExecutionPolicy(sessionId, 'Write', { file_path: join(root, 'file.txt'), content: 'gated' }).allowed).toBe(false);
  });
  test('full control still enforces deny rules and execution boundaries without prompting', async () => {
    setSessionExecutionPolicy(sessionId, { ...policy, fullControl: true,
      safety: { autoReview: true, customRules: [{ toolName: 'mcp__assigned__send_email', effect: 'deny', reason: 'No external mail' }] } });
    for (const [tool, input] of [
      ['mcp__assigned__send_email', { body: 'forbidden' }],
      ['mcp__unassigned__send', {}], ['Task', { prompt: 'delegate' }],
    ] as Array<[string, Record<string, unknown>]>) expect((await authorize(tool, input, tool)).allowed).toBe(false);
    expect(requests).toHaveLength(0);
  });
  test.each(['human', 'review'] as const)('enabling full control resumes a pending %s check under current policy', async stage => {
    setSessionExecutionPolicy(sessionId, { ...policy, safety: { autoReview: stage === 'review', customRules: [] } });
    let release!: () => void;
    if (stage === 'review') setSessionActionReviewer(sessionId, () => new Promise(resolve => { release = () => resolve({ verdict: 'deny', reason: 'Old policy' }); }));
    else setSessionPolicyPermissionHandler(sessionId, () => new Promise(resolve => { release = () => resolve(true); }));
    const input = { file_path: join(root, 'file.txt'), content: 'direct' };
    const pending = authorize('Write', input, 'pending');
    setSessionExecutionPolicy(sessionId, { ...policy, fullControl: true });
    release();
    expect((await pending).allowed).toBe(true);
    expect(claimSessionActionGateDispatch(sessionId, 'Write', input, root, 'pending').allowed).toBe(true);
    expect(requests).toHaveLength(0);
  });
  test('reads, board retrieval and in-team messages run without human approval', async () => {
    for (const [tool, input] of [
      ['Read', { file_path: join(root, 'report.txt') }], ['Glob', { pattern: '*.txt' }],
      ['mcp__session__collaboration_board', { action: 'get' }],
      ['mcp__session__send_agent_message', { sessionId: 'existing', message: 'Evidence ready' }],
      ['mcp__session__browser_tool', { command: ['navigate', 'https://example.com'] }],
    ] as Array<[string, Record<string, unknown>]>) expect((await authorize(tool, input, tool)).allowed).toBe(true);
    expect(requests).toHaveLength(0);
  });
  test('gated mode cannot share a write approval or replay its invocation', async () => {
    const input = { file_path: join(root, 'file.txt'), content: 'approved content' };
    expect(checkSessionExecutionPolicy(sessionId, 'Write', input).allowed).toBe(false);
    expect((await authorize('Write', input, 'write-1')).allowed).toBe(true);
    expect(canShareSuperAgentPermission(requests[0]!.scope)).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'Write', input, root, 'write-1').allowed).toBe(true);
    expect(consumeSessionActionGate(sessionId, 'Write', input, root, 'write-1').allowed).toBe(true);
    expect((await authorize('Write', input, 'write-1')).allowed).toBe(false);
    expect((await authorize('Write', input, 'write-2')).allowed).toBe(true);
    expect(requests).toHaveLength(2);
  });
  test.each([
    ['mcp__assigned__send_email', 'external-communication'], ['mcp__assigned__buy_resource', 'financial'],
    ['mcp__assigned__merge_pr', 'infrastructure'], ['mcp__assigned__get_balance', 'unknown'],
  ] as const)('gates %s even when the model claims it is read-only', async (tool, category) => {
    expect((await authorize(tool, { readOnlyHint: true, read_only: true, _intent: 'harmless query' }, tool)).allowed).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.scope.actionGate?.category).toBe(category);
  });
  test('browser snapshots are autonomous but clicks and uploads are gated', async () => {
    expect((await authorize('mcp__session__browser_tool', { command: ['snapshot'] }, 'snapshot')).allowed).toBe(true);
    expect((await authorize('mcp__session__browser_tool', { command: ['click', '@e1'] }, 'click')).allowed).toBe(true);
    expect(requests).toHaveLength(1);
    expect((await authorize('mcp__session__browser_tool', { command: ['evaluate', 'fetch("/pay")'] }, 'evaluate')).allowed).toBe(false);
    expect((await authorize('mcp__session__browser_tool', { command: ['navigate', 'file:///private'] }, 'file')).allowed).toBe(false);
  });
  test('source and delegation restrictions remain structural', async () => {
    for (const [tool, input] of [
      ['mcp__unassigned__send', { message: 'x' }], ['Task', { prompt: 'delegate' }],
    ] as Array<[string, Record<string, unknown>]>) expect((await authorize(tool, input, tool)).allowed).toBe(false);
    expect(requests).toHaveLength(0);
  });
  test('host commands wait for user approval, including inspections, and approval cannot be replayed', async () => {
    for (const tool of ['Bash', 'mcp__session__localbash', 'mcp__session__runshell']) {
      const input = { command: 'uname -a', cwd: root };
      let release!: (allowed: boolean) => void;
      setSessionPolicyPermissionHandler(sessionId, request => { requests.push(request); return new Promise(resolve => { release = resolve; }); });
      const id = `host-${tool}`;
      const pending = authorize(tool, input, id);
      expect(requests.at(-1)!.scope.boundary).toBe(tool.includes('localbash') ? 'client' : 'host');
      expect(checkSessionExecutionPolicy(sessionId, tool, input, root, id).allowed).toBe(false);
      if (tool === 'Bash') expect(() => wrapSessionProgramInput(sessionId, tool, input, root, id)).toThrow();
      release(true);
      expect((await pending).allowed).toBe(true);
      expect(checkSessionExecutionPolicy(sessionId, tool, { ...input, command: 'echo changed' }, root, id).allowed).toBe(false);
      if (tool === 'Bash') expect(wrapSessionProgramInput(sessionId, tool, input, root, id)!.command).toContain('/bin/bash -c');
      expect(consumeSessionActionGate(sessionId, tool, input, root, id).allowed).toBe(true);
      expect(consumeSessionActionGate(sessionId, tool, input, root, id).allowed).toBe(false);
      expect(claimSessionActionGateDispatch(sessionId, tool, input, root, id).allowed).toBe(true);
      expect(claimSessionActionGateDispatch(sessionId, tool, input, root, id).allowed).toBe(false);
    }
  });
  test('denied host execution stays blocked and full control needs neither sandbox nor review', async () => {
    const input = { command: 'echo test' };
    setSessionPolicyPermissionHandler(sessionId, async request => { requests.push(request); return false; });
    expect((await authorize('Bash', input, 'denied-host')).allowed).toBe(false);
    expect(() => wrapSessionProgramInput(sessionId, 'Bash', input, root, 'denied-host')).toThrow();
    setSessionExecutionPolicy(sessionId, { ...policy, fullControl: true, runPrograms: false, safety: { autoReview: true, customRules: [] } });
    setSessionActionReviewer(sessionId, async () => { throw new Error('Full control must skip review'); });
    requests = [];
    expect((await authorize('Bash', input, 'full-host')).allowed).toBe(true);
    expect(wrapSessionProgramInput(sessionId, 'Bash', input, root, 'full-host')!.command).toContain('/bin/bash -c');
    expect(requests).toHaveLength(0);
  });
  test.each(['Read', 'Write'] as const)('outside %s waits for approval and executes only the original invocation', async tool => {
    const path = join(temp, 'outside.txt');
    writeFileSync(path, 'original');
    const input = tool === 'Read' ? { file_path: path } : { file_path: path, content: 'approved' };
    let release!: (allowed: boolean) => void;
    setSessionPolicyPermissionHandler(sessionId, request => { requests.push(request); return new Promise(resolve => { release = resolve; }); });
    const pending = authorize(tool, input, 'outside');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.scope.boundary).toBe('outside-environment');
    expect(requests[0]!.scope.target).toBe(path);
    expect(checkSessionExecutionPolicy(sessionId, tool, input, root, 'outside').allowed).toBe(false);
    release(true);
    expect((await pending).allowed).toBe(true);
    expect(consumeSessionActionGate(sessionId, tool, { ...input, file_path: join(temp, 'other.txt') }, root, 'outside').allowed).toBe(false);
    expect(consumeSessionActionGate(sessionId, tool, input, root, 'outside').allowed).toBe(true);
    expect(claimSessionActionGateDispatch(sessionId, tool, input, root, 'outside').allowed).toBe(true);
    expect(claimSessionActionGateDispatch(sessionId, tool, input, root, 'outside').allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, tool, input, root, 'new-invocation').allowed).toBe(false);
  });
  test('disabled file capability requests a one-time permission instead of rejecting', async () => {
    setSessionExecutionPolicy(sessionId, { ...policy, writeFiles: false });
    const input = { file_path: join(temp, 'outside.txt'), content: 'approved' };
    expect((await authorize('Write', input, 'disabled')).allowed).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.scope.kind).toBe('file_write');
    expect(consumeSessionActionGate(sessionId, 'Write', input, root, 'disabled').allowed).toBe(true);
    expect(claimSessionActionGateDispatch(sessionId, 'Write', input, root, 'disabled').allowed).toBe(true);
  });
  test('denied outside permission leaves the file blocked, while full control resumes a pending outside call', async () => {
    const input = { file_path: join(temp, 'outside.txt'), content: 'approved' };
    setSessionPolicyPermissionHandler(sessionId, async request => { requests.push(request); return false; });
    expect((await authorize('Write', input, 'denied')).allowed).toBe(false);
    expect(requests).toHaveLength(1);
    expect(consumeSessionActionGate(sessionId, 'Write', input, root, 'denied').allowed).toBe(false);
    let release!: (allowed: boolean) => void;
    setSessionPolicyPermissionHandler(sessionId, () => new Promise(resolve => { release = resolve; }));
    const pending = authorize('Write', input, 'toggle');
    setSessionExecutionPolicy(sessionId, { ...policy, fullControl: true });
    release(true);
    expect((await pending).allowed).toBe(true);
    expect(consumeSessionActionGate(sessionId, 'Write', input, root, 'toggle').allowed).toBe(true);
  });
  test('sandbox approval is invalidated if its executor changes', async () => {
    const runtime = join(temp, 'docker.exe'); writeFileSync(runtime, 'test runtime');
    setSessionProgramExecutor(sessionId, { runtimePath: runtime, containerId: 'verified-container', workingDirectory: '/workspace' });
    const input = { command: 'python3 change.py' };
    expect((await authorize('mcp__session__localbash', input, 'escape-container')).allowed).toBe(false);
    expect((await authorize('Bash', input, 'program')).allowed).toBe(true);
    expect(requests[0]!.scope.boundary).toBe('environment');
    setSessionProgramExecutor(sessionId, undefined);
    expect(consumeSessionActionGate(sessionId, 'Bash', input, root, 'program').allowed).toBe(false);
  });
  test('the real pre-tool pipeline wraps an approved host command and blocks replay', async () => {
    const input = { command: 'echo approved-host' };
    const manager = new PermissionManager({ sessionId, workspaceId: 'workspace', workingDirectory: root });
    const context = { toolName: 'Bash', input, sessionId, invocationId: 'host-pipeline', permissionMode: 'allow-all' as const,
      workingDirectory: root, workspaceRootPath: root, workspaceId: 'workspace', activeSourceSlugs: [], allSourceSlugs: [],
      hasSourceActivation: false, permissionManager: manager };
    const result = await runPreToolUseChecksWithPermissions(context);
    expect(result.type).toBe('modify');
    if (result.type === 'modify') expect(result.input.command).toContain('/bin/bash -c');
    expect(requests).toHaveLength(1);
    expect((await runPreToolUseChecksWithPermissions(context)).type).toBe('block');
  });
  test('changed payload and cross-invocation dispatches are denied', async () => {
    const tool = 'mcp__assigned__send_email', input = { to: 'customer', body: 'approved' };
    await authorize(tool, input, 'send');
    expect(consumeSessionActionGate(sessionId, tool, { ...input, body: 'changed' }, root, 'send').allowed).toBe(false);
    expect(claimSessionActionGateDispatch(sessionId, tool, input, root, 'send').allowed).toBe(false);
    expect(consumeSessionActionGate(sessionId, tool, input, root, 'send').allowed).toBe(true);
    expect(claimSessionActionGateDispatch(sessionId, tool, input, root, 'other').allowed).toBe(false);
    expect(claimSessionActionGateDispatch(sessionId, tool, input, root, 'send').allowed).toBe(true);
    expect(claimSessionActionGateDispatch(sessionId, tool, input, root, 'send').allowed).toBe(false);
  });
  test.each(['cancel', 'policy', 'payload'])('invalidates approval when %s changes during human review', async mode => {
    let release!: (allowed: boolean) => void;
    setSessionPolicyPermissionHandler(sessionId, () => new Promise(resolve => { release = resolve; }));
    const input = { file_path: join(temp, 'outside.txt'), content: 'approved' };
    const pending = authorize('Write', input, 'pending');
    if (mode === 'cancel') clearSessionPolicyGrants(sessionId);
    if (mode === 'policy') setSessionExecutionPolicy(sessionId, { ...policy, fullControl: false, writeFiles: false });
    if (mode === 'payload') input.content = 'changed';
    release(true);
    expect((await pending).allowed).toBe(false);
  });
  test('custom rules can deny reads or require confirmation, but cannot grant tools', async () => {
    setSessionExecutionPolicy(sessionId, { ...policy, safety: { autoReview: false, customRules: [{ toolName: 'Read', effect: 'require-human', reason: 'Sensitive input' }] } });
    expect((await authorize('Read', { file_path: join(root, 'input') }, 'read')).allowed).toBe(true);
    expect(requests).toHaveLength(1);
    setSessionExecutionPolicy(sessionId, { ...policy, safety: { autoReview: false, customRules: [{ toolName: 'Read', effect: 'deny', reason: 'Forbidden input' }] } });
    expect((await authorize('Read', { file_path: join(root, 'input') }, 'denied')).allowed).toBe(false);
    expect(() => setSessionExecutionPolicy(sessionId, { ...policy, safety: { autoReview: false, customRules: [{ toolName: 'Read', effect: 'allow' as never, reason: 'bypass' }] } })).toThrow();
  });
  test('manager roles cannot acquire worker capabilities by requesting approval', async () => {
    for (const role of ['coordinator', 'orchestrator'] as const) {
      setSessionExecutionPolicy(sessionId, { ...policy, role });
      expect((await authorize('Write', { file_path: join(root, 'x'), content: 'x' }, role)).allowed).toBe(false);
    }
    expect(requests).toHaveLength(0);
  });
  test('control directories cannot be mounted or selected as an execution environment', () => {
    const control = join(temp, 'control'); mkdirSync(control);
    expect(() => setSessionExecutionPolicy(sessionId, { ...policy, rootPath: temp, protectedRoots: [control] })).toThrow('overlaps protected');
    expect(checkSessionExecutionPolicy(sessionId, 'Read', { file_path: join(root, 'file') }).allowed).toBe(false);
    setSessionExecutionPolicy(sessionId, { ...policy, protectedRoots: [control] });
    expect(checkSessionExecutionPolicy(sessionId, 'Read', { file_path: join(root, 'file') }).allowed).toBe(true);
  });
  test('concurrent prechecks cannot request two approvals for one invocation', async () => {
    let release!: (value: boolean) => void;
    setSessionPolicyPermissionHandler(sessionId, request => { requests.push(request); return new Promise(resolve => { release = resolve; }); });
    const input = { body: 'approved email' }, tool = 'mcp__assigned__send_email';
    const first = authorize(tool, input, 'one-id');
    expect((await authorize(tool, input, 'one-id')).allowed).toBe(false);
    release(true);
    expect((await first).allowed).toBe(true);
    expect(requests).toHaveLength(1);
  });
  test('provider pipeline approves normalized input once and blocks invocation replay', async () => {
    const ctx = { invocationId: 'provider-write', toolName: 'Write', input: { file_path: 'file.txt', content: 'ok', _intent: 'Write report' }, sessionId,
      permissionMode: 'allow-all' as const, workspaceRootPath: root, workspaceId: 'workspace', workingDirectory: root,
      activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false,
      permissionManager: new PermissionManager({ sessionId, workspaceId: 'workspace', workingDirectory: root }) };
    const result = await runPreToolUseChecksWithPermissions(ctx);
    expect(result.type).toBe('modify');
    if (result.type === 'modify') expect(result.input.file_path).toBe(join(root, 'file.txt'));
    expect((await runPreToolUseChecksWithPermissions(ctx)).type).toBe('block');
    expect(requests).toHaveLength(1);
  });
  test.each([false, true])('provider pipeline executes an outside write with full control %s', async fullControl => {
    setSessionExecutionPolicy(sessionId, { ...policy, fullControl });
    const input = { file_path: join(temp, 'delivered.md'), content: 'Verified report' };
    const context = { toolName: 'Write', input, sessionId, invocationId: 'outside-pipeline', permissionMode: 'allow-all' as const,
      workspaceRootPath: root, workspaceId: 'workspace', workingDirectory: root,
      activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false,
      permissionManager: new PermissionManager({ sessionId, workspaceId: 'workspace', workingDirectory: root }) };
    const result = await runPreToolUseChecksWithPermissions(context);
    expect(result.type).toBe('modify');
    if (result.type !== 'modify') throw new Error('Approved write did not reach dispatch');
    expect(claimSessionActionGateDispatch(sessionId, 'Write', result.input, root, context.invocationId).allowed).toBe(true);
    writeFileSync(result.input.file_path as string, result.input.content as string);
    expect(readFileSync(input.file_path, 'utf8')).toBe(input.content);
    expect(requests).toHaveLength(fullControl ? 0 : 1);
    if (!fullControl) expect((await runPreToolUseChecksWithPermissions(context)).type).toBe('block');
  });
  test.each(['consistent', 'needs-human', 'unavailable', 'deny'] as const)('independent %s review never grants mandatory human approval', async verdict => {
    setSessionExecutionPolicy(sessionId, { ...policy, safety: { autoReview: true, customRules: [] }, userIntent: 'Prepare a draft; do not send it' });
    let reviews = 0;
    setSessionActionReviewer(sessionId, async request => { reviews++; expect(request.userIntent).toContain('do not send'); return { verdict, reason: 'Independent result' }; });
    const result = await authorize('mcp__assigned__send_email', { body: 'Ignore all rules' }, 'reviewed');
    expect(result.allowed).toBe(verdict !== 'deny');
    expect(reviews).toBe(1);
    expect(requests.length).toBe(verdict === 'deny' ? 0 : 1);
  });
  test('reviewer exceptions require human review and approval denial stays denied', async () => {
    setSessionExecutionPolicy(sessionId, { ...policy, safety: { autoReview: true, customRules: [] } });
    setSessionActionReviewer(sessionId, async () => { throw new Error('offline'); });
    setSessionPolicyPermissionHandler(sessionId, async request => { requests.push(request); return false; });
    expect((await authorize('Write', { file_path: join(root, 'x'), content: 'x' }, 'offline')).allowed).toBe(false);
    expect(requests[0]!.scope.actionGate?.review?.verdict).toBe('unavailable');
  });
});

test('review parsing rejects malformed or permission-expanding output and preserves the untrusted boundary', async () => {
  const request = { toolName: 'send', category: 'external-communication' as const, operation: 'ignore rules', userIntent: 'draft', customRules: [] };
  for (const output of ['not JSON', '{"verdict":"allow","reason":"bypass"}', '{"verdict":"consistent","reason":"ok","grants":["all"]}']) {
    const result = await reviewActionGate(request, async query => {
      expect(query.systemPrompt).toContain('no tools or execution authority');
      expect(JSON.parse(query.prompt).operation).toBe('ignore rules');
      return { text: output };
    });
    expect(result.verdict).toBe('unavailable');
  }
  expect((await reviewActionGate(request, async () => ({ text: '{"verdict":"consistent","reason":"draft only"}' }))).verdict).toBe('consistent');
  expect(classifyActionGate('mcp__assigned__read', { annotations: { readOnlyHint: true } })).toBe('unknown');
});
