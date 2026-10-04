import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'shell-quote';
import { authorizeSessionPolicyTool, checkSessionExecutionPolicy, clearSessionExecutionPolicy, clearSessionPolicyGrants, getSessionExecutionPolicy, getSessionPolicyGrantTarget, getSessionProgramExecutor, hasSessionFullControl, isSessionPolicyShellAutoAllowed, normalizeSessionPolicyInput, setSessionExecutionPolicy, setSessionPolicyPermissionHandler, setSessionProgramExecutor, setSessionReferenceFiles, wrapSessionProgramInput, type SessionExecutionPolicy, type SessionPolicyPermissionRequest } from '../session-execution-policy.ts';
import { PermissionManager } from '../permission-manager.ts';
import { runPreToolUseChecks, runPreToolUseChecksWithPermissions } from '../pre-tool-use.ts';
import { setPermissionMode, cleanupModeState } from '../../mode-manager.ts';
import { writeSessionJsonl, readSessionJsonl } from '../../../sessions/jsonl.ts';
import type { StoredSession } from '../../../sessions/types.ts';

const sessionId = 'super-agent-policy-test';
let temp: string;
let root: string;
let outside: string;
let policy: SessionExecutionPolicy;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'super-agent-policy-'));
  root = join(temp, 'environment');
  outside = join(temp, 'outside');
  mkdirSync(root); mkdirSync(outside);
  writeFileSync(join(root, 'allowed.txt'), 'allowed');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  policy = { nodeId: 'worker', role: 'worker', rootPath: root, readFiles: true, writeFiles: true, runPrograms: true, browser: false, allowSources: ['assigned'], allowSubagents: false };
  setSessionExecutionPolicy(sessionId, policy);
  setPermissionMode(sessionId, 'allow-all');
});

afterEach(() => { clearSessionExecutionPolicy(sessionId); cleanupModeState(sessionId); rmSync(temp, { recursive: true, force: true }); });

describe('Super Agent permission ceiling', () => {
  test('allows team messaging in both control modes without allowing extra model processes', async () => {
    for (const fullControl of [false, true]) {
      setSessionExecutionPolicy(sessionId, { ...policy, fullControl });
      let requests = 0;
      setSessionPolicyPermissionHandler(sessionId, async () => { requests++; return false; });
      const input = { sessionId: 'existing-team-session', message: 'Verified progress' };
      expect((await authorizeSessionPolicyTool(sessionId, 'mcp__session__send_agent_message', input)).allowed).toBe(true);
      const checked = await runPreToolUseChecksWithPermissions({ toolName: 'mcp__session__send_agent_message', input, sessionId,
        permissionMode: 'allow-all', workspaceRootPath: root, workspaceId: 'workspace', workingDirectory: root,
        activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false,
        permissionManager: new PermissionManager({ sessionId, workspaceId: 'workspace', workingDirectory: root }) });
      expect(checked.type).toBe('allow');
      for (const invalid of [{ message: 'Missing recipient' }, { ...input, message: '' }, { ...input, targetMemberId: 'remote' }, { ...input, attachments: [{ path: outside }] }]) {
        expect((await authorizeSessionPolicyTool(sessionId, 'mcp__session__send_agent_message', invalid)).allowed).toBe(false);
      }
      expect(checkSessionExecutionPolicy(sessionId, 'mcp__assigned__send_agent_message', input).allowed).toBe(false);
      for (const tool of ['Task', 'Agent', 'spawn_agent', 'mcp__session__spawn_session', 'mcp__session__call_llm', 'mcp__session__create_task']) {
        expect((await authorizeSessionPolicyTool(sessionId, tool, input)).allowed).toBe(false);
      }
      expect(requests).toBe(0);
    }
  });

  test('full control bypasses folder, capability, source and mode approvals while retaining model serialization', async () => {
    const ceilings = { ...policy, role: 'coordinator' as const, readFiles: false, writeFiles: false, runPrograms: false, browser: false, fullControl: true };
    setSessionExecutionPolicy(sessionId, ceilings);
    setPermissionMode(sessionId, 'safe');
    let requests = 0;
    setSessionPolicyPermissionHandler(sessionId, async () => { requests++; return false; });
    const manager = new PermissionManager({ sessionId, workspaceId: 'workspace', workingDirectory: root });
    const operations = [
      ['Read', { file_path: `${root}/../outside/secret.txt` }],
      ['Write', { file_path: join(outside, 'new.txt'), content: 'new' }],
      ['Bash', { command: 'echo unrestricted', run_in_background: true }],
      ['mcp__session__localbash', { command: 'Remove-Item anything', cwd: outside }],
      ['mcp__session__browser_tool', { command: ['evaluate', 'document.title'] }],
      ['mcp__session__browser_tool', { command: ['navigate', 'file:///tmp/example.txt'] }],
      ['mcp__session__browser_tool', { command: ['upload', '@e1', join(outside, 'secret.txt')] }],
      ['mcp__unassigned__write', { path: outside, content: 'x' }],
      ['mcp__assigned__execute_code', { code: 'run code' }],
    ] as const;
    for (const [toolName, input] of operations) {
      expect(checkSessionExecutionPolicy(sessionId, toolName, input).allowed).toBe(true);
      expect((await authorizeSessionPolicyTool(sessionId, toolName, input)).allowed).toBe(true);
      expect(manager.evaluateToolCall(toolName, input)).toEqual({ allowed: true });
      const checked = await runPreToolUseChecksWithPermissions({ toolName, input, sessionId, permissionMode: 'safe', workspaceRootPath: root,
        workspaceId: 'workspace', workingDirectory: root, activeSourceSlugs: ['assigned', 'unassigned'], allSourceSlugs: ['assigned', 'unassigned'], hasSourceActivation: true, permissionManager: manager });
      expect(['allow', 'modify']).toContain(checked.type);
    }
    expect(manager.requiresBashPermission('sudo rm anywhere')).toBe(false);
    for (const tool of ['Task', 'Agent', 'mcp__session__spawn_session', 'mcp__session__call_llm', 'spawn_agent', 'mcp__session__create_task', 'WebFetch']) {
      expect((await authorizeSessionPolicyTool(sessionId, tool, { prompt: 'another model' })).allowed).toBe(false);
    }
    expect(checkSessionExecutionPolicy(sessionId, 'Bash', { command: '\0' }).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'Read', undefined as never).allowed).toBe(false);
    expect(requests).toBe(0);
  });

  test('turning full control off restores original ceilings without needing or retaining operation grants', async () => {
    setSessionExecutionPolicy(sessionId, { ...policy, readFiles: false, writeFiles: false, runPrograms: false, browser: false, fullControl: true });
    const full = getSessionExecutionPolicy(sessionId)!;
    expect(hasSessionFullControl(sessionId)).toBe(true);
    expect(full.writeFiles).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'Write', { file_path: join(outside, 'new.txt') }).allowed).toBe(true);
    setSessionExecutionPolicy(sessionId, { ...full, fullControl: false });
    expect(hasSessionFullControl(sessionId)).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'Read', { file_path: join(root, 'allowed.txt') }).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'Write', { file_path: join(outside, 'new.txt') }).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'Bash', { command: 'echo unrestricted' }).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'mcp__session__browser_tool', { command: ['evaluate', 'document.title'] }).allowed).toBe(false);
    expect(() => setSessionExecutionPolicy(sessionId, { ...policy, fullControl: 'true' } as never)).toThrow();
    expect(hasSessionFullControl(sessionId)).toBe(false);
  });

  test('enabling full control resumes a suspended original operation, but a later disable cannot install a stale approval', async () => {
    const input = { file_path: join(outside, 'secret.txt') };
    let approve!: (allowed: boolean) => void;
    setSessionPolicyPermissionHandler(sessionId, () => new Promise(resolve => { approve = resolve; }));
    const first = authorizeSessionPolicyTool(sessionId, 'Read', input);
    setSessionExecutionPolicy(sessionId, { ...policy, fullControl: true });
    approve(true);
    expect((await first).allowed).toBe(true);
    expect(getSessionPolicyGrantTarget(sessionId, 'Read', input)).toBeUndefined();
    setSessionExecutionPolicy(sessionId, policy);
    const second = authorizeSessionPolicyTool(sessionId, 'Read', input);
    setSessionExecutionPolicy(sessionId, { ...policy, fullControl: true });
    setSessionExecutionPolicy(sessionId, { ...policy, fullControl: false });
    approve(true);
    expect((await second).allowed).toBe(false);
  });

  test('full control host programs need no exact grant and verified sandbox programs stay in the chosen container', () => {
    setSessionExecutionPolicy(sessionId, { ...policy, fullControl: true });
    const command = `printf '%s' "$(touch marker)"; echo 'quoted'\nfalse`;
    const wrapped = wrapSessionProgramInput(sessionId, 'Bash', { command })!;
    expect(parse(wrapped.command as string)).toEqual(['cd', '--', root.replace(/\\/g, '/'), { op: '&&' }, '/bin/bash', '-c', command]);
    const executable = join(temp, process.platform === 'win32' ? 'docker.exe' : 'docker');
    writeFileSync(executable, 'test runtime');
    setSessionProgramExecutor(sessionId, { runtimePath: executable, containerId: 'tokenbird-super-test', workingDirectory: '/workspace' });
    expect(getSessionProgramExecutor(sessionId)?.containerId).toBe('tokenbird-super-test');
    const isolated = wrapSessionProgramInput(sessionId, 'Bash', { command, run_in_background: true })!;
    const environment = process.platform === 'win32' ? ['MSYS_NO_PATHCONV=1', 'MSYS2_ARG_CONV_EXCL=*'] : [];
    expect(parse(isolated.command as string)).toEqual([...environment, executable.replace(/\\/g, '/'), 'exec', '--workdir', '/workspace', 'tokenbird-super-test', '/bin/sh', '-lc', command]);
  });

  test('limited nodes auto-run AST-verified system metadata but not filesystem reads, mutations, injections or background jobs', async () => {
    let requests = 0;
    setSessionPolicyPermissionHandler(sessionId, async () => { requests++; return false; });
    for (const tool of ['Bash', 'mcp__session__localbash', 'mcp__session__runshell']) {
      expect(isSessionPolicyShellAutoAllowed(sessionId, tool, { command: 'uname -a && df -h' })).toBe(true);
      expect((await authorizeSessionPolicyTool(sessionId, tool, { command: 'uname -a && df -h' })).allowed).toBe(true);
      for (const input of [{ command: 'cat /etc/passwd' }, { command: 'hostname new-name' }, { command: 'df -h; rm -rf somewhere' },
        { command: 'df -h > file' }, { command: 'df $(touch file)' }, { command: 'df -h', run_in_background: true }, { command: '' }, { command: 'df -h', cwd: outside }]) {
        expect(isSessionPolicyShellAutoAllowed(sessionId, tool, input)).toBe(false);
      }
    }
    expect(requests).toBe(0);
    setSessionExecutionPolicy(sessionId, { ...policy, readFiles: false });
    expect(isSessionPolicyShellAutoAllowed(sessionId, 'Bash', { command: 'df -h' })).toBe(false);
  });

  test('full control lets both node roles use built-in tools without requesting approval', async () => {
    let requests = 0;
    for (const role of ['coordinator', 'worker'] as const) {
      setSessionExecutionPolicy(sessionId, { ...policy, role, fullControl: true, readFiles: false, writeFiles: false, runPrograms: false, browser: false });
      setSessionPolicyPermissionHandler(sessionId, async () => { requests++; return false; });
      for (const [tool, input] of [
        ['Read', { file_path: join(outside, 'secret.txt') }],
        ['Write', { file_path: join(outside, 'new.txt'), content: 'test' }],
        ['Bash', { command: 'echo test' }],
        ['mcp__session__localbash', { command: 'echo test', cwd: outside }],
        ['mcp__session__runshell', { command: 'echo test' }],
        ['mcp__session__browser_tool', { command: ['navigate', 'https://example.com'] }],
        ['mcp__session__canvas', { action: 'inspect' }],
      ] as const) expect((await authorizeSessionPolicyTool(sessionId, tool, input)).allowed).toBe(true);
      const manager = new PermissionManager({ sessionId, workspaceId: 'workspace', workingDirectory: root });
      const result = await runPreToolUseChecksWithPermissions({ toolName: 'Bash', input: { command: 'echo test' }, sessionId,
        permissionMode: 'allow-all', workingDirectory: root, workspaceRootPath: root, workspaceId: 'workspace',
        activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager: manager });
      expect(result.type).toBe('modify');
      expect(manager.evaluateToolCall('Write', { file_path: join(outside, 'new.txt'), content: 'test' }).allowed).toBe(true);
    }
    expect(requests).toBe(0);
    expect(getSessionExecutionPolicy(sessionId)?.fullControl).toBe(true);
    setSessionExecutionPolicy(sessionId, { ...policy, fullControl: false });
    expect(checkSessionExecutionPolicy(sessionId, 'Read', { file_path: join(outside, 'secret.txt') }).allowed).toBe(false);
  });

  test('pauses an outside read for approval and grants only its exact operation in the current turn', async () => {
    const input = { file_path: join(outside, 'secret.txt'), offset: 1 };
    let request: SessionPolicyPermissionRequest | undefined;
    let approve!: (allowed: boolean) => void;
    setSessionPolicyPermissionHandler(sessionId, pending => {
      request = pending;
      return new Promise(resolve => { approve = resolve; });
    });
    const manager = new PermissionManager({ sessionId, workspaceId: 'workspace', workingDirectory: root });
    const pending = runPreToolUseChecksWithPermissions({ toolName: 'Read', input, sessionId, permissionMode: 'allow-all', workingDirectory: root,
      workspaceRootPath: root, workspaceId: 'workspace', activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager: manager });
    expect(request?.scope.kind).toBe('file_read');
    expect(request?.scope.boundary).toBe('outside-environment');
    expect(request?.scope.target).toBe(input.file_path);
    expect(checkSessionExecutionPolicy(sessionId, 'Read', input).allowed).toBe(false);
    approve(true);
    expect((await pending).type).toBe('modify');
    expect(checkSessionExecutionPolicy(sessionId, 'Read', input).allowed).toBe(true);
    expect(checkSessionExecutionPolicy(sessionId, 'Read', { ...input, offset: 2 }).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'Write', { ...input, content: 'changed' }).allowed).toBe(false);
    clearSessionPolicyGrants(sessionId);
    expect(checkSessionExecutionPolicy(sessionId, 'Read', input).allowed).toBe(false);
  });

  test('approved local command retains exact cwd, timeout, command and pinned execution target', async () => {
    const input = { command: 'Get-ChildItem', timeoutMs: 1000, _intent: 'list files' };
    setSessionPolicyPermissionHandler(sessionId, async request => {
      expect(JSON.parse(request.scope.operation)).toEqual({ command: input.command, cwd: root, timeoutMs: 1000 });
      request.scope.target = 'client:desktop-a';
      return true;
    });
    expect((await authorizeSessionPolicyTool(sessionId, 'mcp__session__localbash', input)).allowed).toBe(true);
    const normalized = normalizeSessionPolicyInput(sessionId, 'mcp__session__localbash', input)!;
    expect(normalized.cwd).toBe(root);
    expect(getSessionPolicyGrantTarget(sessionId, 'mcp__session__localbash', normalized)).toBe('client:desktop-a');
    expect(checkSessionExecutionPolicy(sessionId, 'mcp__session__localbash', { ...normalized, command: 'Remove-Item anything' }).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'mcp__session__localbash', { ...normalized, cwd: outside }).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'mcp__session__localbash', { ...normalized, timeoutMs: 2000 }).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'mcp__session__runshell', normalized).allowed).toBe(false);
    setSessionExecutionPolicy(sessionId, policy);
    expect(getSessionPolicyGrantTarget(sessionId, 'mcp__session__localbash', normalized)).toBeUndefined();
  });

  test('denial, expiry, cancellation and a policy change cannot install grants', async () => {
    const input = { file_path: join(outside, 'secret.txt') };
    setSessionPolicyPermissionHandler(sessionId, async () => false);
    expect((await authorizeSessionPolicyTool(sessionId, 'Read', input)).allowed).toBe(false);
    setSessionPolicyPermissionHandler(sessionId, async request => { request.scope.expiresAt = Date.now() - 1; return true; });
    expect((await authorizeSessionPolicyTool(sessionId, 'Read', input)).allowed).toBe(false);
    for (const change of [() => clearSessionPolicyGrants(sessionId), () => setSessionExecutionPolicy(sessionId, policy)]) {
      let approve!: (allowed: boolean) => void;
      setSessionPolicyPermissionHandler(sessionId, () => new Promise(resolve => { approve = resolve; }));
      const pending = authorizeSessionPolicyTool(sessionId, 'Read', input);
      change(); approve(true);
      expect((await pending).allowed).toBe(false);
      expect(checkSessionExecutionPolicy(sessionId, 'Read', input).allowed).toBe(false);
    }
  });

  test('structural restrictions are never converted into approval exceptions', async () => {
    let calls = 0;
    setSessionPolicyPermissionHandler(sessionId, async () => { calls++; return true; });
    for (const [tool, input] of [
      ['mcp__unassigned__read', { path: outside }],
      ['mcp__unassigned__write', { path: outside, content: 'x' }],
      ['mcp__assigned__execute_code', { code: 'run code' }],
      ['mcp__session__call_llm', { prompt: 'delegate' }],
      ['mcp__session__spawn_session', {}],
      ['mcp__session__sftp_transfer', { direction: 'download' }],
      ['mcp__session__browser_tool', { command: ['navigate', 'file:///etc/passwd'] }],
      ['Read', { file_path: `${root}/../outside/secret.txt` }],
      ['Bash', { command: 'echo x', run_in_background: true }],
    ] as const) expect((await authorizeSessionPolicyTool(sessionId, tool, input)).allowed).toBe(false);
    setSessionExecutionPolicy(sessionId, { ...policy, role: 'coordinator' });
    expect((await authorizeSessionPolicyTool(sessionId, 'Write', { file_path: join(root, 'allowed.txt'), content: 'x' })).allowed).toBe(false);
    expect((await authorizeSessionPolicyTool(sessionId, 'mcp__session__localbash', { command: 'echo x' })).allowed).toBe(false);
    expect(calls).toBe(0);
  });

  test('a host Bash exception quotes the entire command as one argument behind a successful cwd change', async () => {
    const command = `printf '%s' "$(touch marker)"; echo 'quoted'\nfalse`;
    expect(() => wrapSessionProgramInput(sessionId, 'Bash', { command })).toThrow();
    setSessionPolicyPermissionHandler(sessionId, async () => true);
    expect((await authorizeSessionPolicyTool(sessionId, 'Bash', { command })).allowed).toBe(true);
    const wrapped = wrapSessionProgramInput(sessionId, 'Bash', { command })!;
    expect(parse(wrapped.command as string)).toEqual(['cd', '--', root.replace(/\\/g, '/'), { op: '&&' }, '/bin/bash', '-c', command]);
    expect(checkSessionExecutionPolicy(sessionId, 'Bash', { command: `${command}\necho another` }).allowed).toBe(false);
  });

  test('safe-mode operations use an exact approval instead of blocking again or asking twice', async () => {
    setPermissionMode(sessionId, 'safe');
    let calls = 0;
    setSessionPolicyPermissionHandler(sessionId, async () => { calls++; return true; });
    const manager = new PermissionManager({ sessionId, workspaceId: 'workspace', workingDirectory: root });
    const input = { file_path: join(root, 'new.txt'), content: 'new file' };
    const result = await runPreToolUseChecksWithPermissions({ toolName: 'Write', input, sessionId, permissionMode: 'safe', workingDirectory: root,
      workspaceRootPath: root, workspaceId: 'workspace', activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager: manager });
    expect(result.type).toBe('modify');
    expect(calls).toBe(1);
    expect(manager.evaluateToolCall('Write', input).allowed).toBe(true);
    expect(manager.evaluateToolCall('Write', { ...input, content: 'other content' }).allowed).toBe(false);
  });

  test('contains reads, new writes, searches and traversal despite Allow All', () => {
    expect(checkSessionExecutionPolicy(sessionId, 'Read', { file_path: join(root, 'allowed.txt') }).allowed).toBe(true);
    expect(checkSessionExecutionPolicy(sessionId, 'Write', { file_path: join(root, 'new', 'file.txt') }).allowed).toBe(true);
    for (const [tool, input] of [
      ['Read', { file_path: join(outside, 'secret.txt') }],
      ['Write', { file_path: join(outside, 'new.txt') }],
      ['Grep', { path: outside }],
      ['Glob', { pattern: '../outside/*' }],
      ['Read', { file_path: `${root}/../outside/secret.txt` }],
      ['Read', { file_path: join(root, 'allowed.txt'), path: join(outside, 'secret.txt') }],
    ] as const) expect(checkSessionExecutionPolicy(sessionId, tool, input).allowed).toBe(false);
    const manager = new PermissionManager({ sessionId, workspaceId: 'workspace', workingDirectory: root });
    expect(manager.evaluateToolCall('Read', { file_path: join(outside, 'secret.txt') }).allowed).toBe(false);
    expect(normalizeSessionPolicyInput(sessionId, 'Read', { file_path: 'allowed.txt' })?.file_path).toBe(join(root, 'allowed.txt'));
  });

  test('blocks symlink/junction escapes, missing write targets beneath links, and linked recursive searches', () => {
    symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(checkSessionExecutionPolicy(sessionId, 'Read', { file_path: join(root, 'escape', 'secret.txt') }).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'Write', { file_path: join(root, 'escape', 'new', 'file.txt') }).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'Grep', { path: root }).allowed).toBe(false);
  });

  test('coordinator cannot gain file writes or programs from flags or permission modes', () => {
    setSessionExecutionPolicy(sessionId, { ...policy, role: 'coordinator', browser: true });
    expect(checkSessionExecutionPolicy(sessionId, 'Write', { file_path: join(root, 'allowed.txt') }).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'Bash', { command: 'echo x' }).allowed).toBe(false);
    expect(getSessionExecutionPolicy(sessionId)?.writeFiles).toBe(false);
  });

  test('assigned source and browser guides receive exact read-only grants without general host file access', () => {
    const guide = join(outside, 'guide.md');
    writeFileSync(guide, 'Source instructions');
    setSessionExecutionPolicy(sessionId, { ...policy, readFiles: false });
    setSessionReferenceFiles(sessionId, [guide]);
    expect(checkSessionExecutionPolicy(sessionId, 'Read', { file_path: guide }).allowed).toBe(true);
    expect(checkSessionExecutionPolicy(sessionId, 'Read', { file_path: join(outside, 'secret.txt') }).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'Write', { file_path: guide }).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'Grep', { path: outside }).allowed).toBe(false);
    expect(checkSessionExecutionPolicy(sessionId, 'Read', undefined as never).allowed).toBe(false);
  });

  test('source allowlist and one model process cannot be bypassed by interceptors or aliases', () => {
    expect(checkSessionExecutionPolicy(sessionId, 'mcp__assigned__query', {}).allowed).toBe(true);
    for (const tool of ['mcp__other__query', 'mcp__assigned__execute_code', 'mcp__assigned__bash', 'mcp__assigned__browser_snapshot', 'mcp__session__call_llm', 'mcp__session__spawn_session', 'Task', 'Agent', 'spawn_agent', 'mcp__session__create_task', 'mcp__session__localbash', 'mcp__session__script_sandbox']) {
      expect(checkSessionExecutionPolicy(sessionId, tool, {}).allowed).toBe(false);
    }
    const manager = new PermissionManager({ sessionId, workspaceId: 'workspace', workingDirectory: root });
    const result = runPreToolUseChecks({ toolName: 'mcp__session__call_llm', input: { prompt: 'nested query' }, sessionId, permissionMode: 'allow-all', workspaceRootPath: root, workspaceId: 'workspace', activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: true, permissionManager: manager });
    expect(result.type).toBe('block');
  });

  test('browser disabled flag blocks all aliases; permitted browser cannot navigate host files or evaluate arbitrary code', () => {
    for (const tool of ['mcp__session__browser_tool', 'WebFetch', 'browser_open']) expect(checkSessionExecutionPolicy(sessionId, tool, { command: 'open' }).allowed).toBe(false);
    setSessionExecutionPolicy(sessionId, { ...policy, browser: true });
    expect(checkSessionExecutionPolicy(sessionId, 'mcp__session__browser_tool', { command: ['navigate', 'https://example.com'] }).allowed).toBe(true);
    for (const command of [['navigate', 'file:///etc/passwd'], ['evaluate', 'location.href="file:///etc/passwd"'], ['upload', '@e1', join(outside, 'secret.txt')], 'open; evaluate 1']) expect(checkSessionExecutionPolicy(sessionId, 'mcp__session__browser_tool', { command }).allowed).toBe(false);
  });

  test('requires a verified executor and quotes adversarial commands as one container argument', () => {
    const command = `printf '%s' "$(touch host-marker)"; echo 'quoted'\nfalse`;
    expect(checkSessionExecutionPolicy(sessionId, 'Bash', { command }).allowed).toBe(false);
    const executable = join(temp, process.platform === 'win32' ? 'docker.exe' : 'docker');
    writeFileSync(executable, 'test runtime');
    expect(() => setSessionProgramExecutor(sessionId, { runtimePath: executable, containerId: 'good;evil', workingDirectory: '/workspace' })).toThrow();
    setSessionProgramExecutor(sessionId, { runtimePath: executable, containerId: 'tokenbird-super-test', workingDirectory: '/workspace' });
    expect(checkSessionExecutionPolicy(sessionId, 'Bash', { command }).allowed).toBe(true);
    const wrapped = wrapSessionProgramInput(sessionId, 'Bash', { command })!;
    const environment = process.platform === 'win32' ? ['MSYS_NO_PATHCONV=1', 'MSYS2_ARG_CONV_EXCL=*'] : [];
    expect(parse(wrapped.command as string)).toEqual([...environment, executable.replace(/\\/g, '/'), 'exec', '--workdir', '/workspace', 'tokenbird-super-test', '/bin/sh', '-lc', command]);
    setPermissionMode(sessionId, 'ask');
    const manager = new PermissionManager({ sessionId, workspaceId: 'workspace', workingDirectory: root });
    const checked = runPreToolUseChecks({ toolName: 'Bash', input: { command }, sessionId, permissionMode: 'ask', workspaceRootPath: root, workspaceId: 'workspace', activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager: manager });
    expect(checked.type).toBe('prompt');
    if (checked.type !== 'prompt') throw new Error('Expected permission prompt');
    expect(checked.promptType).toBe('bash');
    expect(parse(checked.modifiedInput!.command as string)).toEqual(parse(wrapped.command as string));
    expect(checkSessionExecutionPolicy(sessionId, 'Bash', { command, run_in_background: true }).allowed).toBe(false);
    setSessionExecutionPolicy(sessionId, { ...policy, writeFiles: false });
    expect(checkSessionExecutionPolicy(sessionId, 'Bash', { command }).allowed).toBe(false);
  });

  test('persists the permission ceiling without any executor; malformed policies fail closed', () => {
    const file = join(temp, 'session.jsonl');
    const session: StoredSession = { id: sessionId, workspaceRootPath: root, createdAt: 1, lastUsedAt: 1, executionPolicy: policy, agentSystemPrompt: 'You are the coordinator. Use super_agent_actions.', messages: [], tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } };
    writeSessionJsonl(file, session);
    const restored = readSessionJsonl(file)!;
    expect(restored.agentSystemPrompt).toBe(session.agentSystemPrompt);
    expect({ ...restored.executionPolicy, rootPath: resolve(restored.executionPolicy!.rootPath) }).toEqual(policy);
    clearSessionExecutionPolicy(sessionId);
    setSessionExecutionPolicy(sessionId, restored.executionPolicy!);
    expect(checkSessionExecutionPolicy(sessionId, 'Bash', { command: 'echo x' }).allowed).toBe(false);
    expect(() => setSessionExecutionPolicy(sessionId, { ...policy, allowSubagents: true } as never)).toThrow();
    expect(checkSessionExecutionPolicy(sessionId, 'Read', { file_path: join(root, 'allowed.txt') }).allowed).toBe(false);
  });
});
