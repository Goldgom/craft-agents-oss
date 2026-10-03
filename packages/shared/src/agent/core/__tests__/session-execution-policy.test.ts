import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'shell-quote';
import { checkSessionExecutionPolicy, clearSessionExecutionPolicy, getSessionExecutionPolicy, normalizeSessionPolicyInput, setSessionExecutionPolicy, setSessionProgramExecutor, setSessionReferenceFiles, wrapSessionProgramInput, type SessionExecutionPolicy } from '../session-execution-policy.ts';
import { PermissionManager } from '../permission-manager.ts';
import { runPreToolUseChecks } from '../pre-tool-use.ts';
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
