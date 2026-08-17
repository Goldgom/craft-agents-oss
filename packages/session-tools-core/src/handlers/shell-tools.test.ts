/**
 * Unit tests for the runshell / localbash session tool handlers.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import type { ShellExecResult } from '../shell.ts';
import { handleLocalBash, handleRunShell } from './shell-tools.ts';

function makeCtx(overrides: Partial<SessionToolContext> = {}): SessionToolContext {
  const dir = mkdtempSync(join(tmpdir(), 'shell-tools-ctx-'));
  return {
    sessionId: 'test-session',
    workspacePath: dir,
    ...overrides,
  } as SessionToolContext;
}

function bridgeResult(stdout: string, exitCode = 0): ShellExecResult {
  return {
    command: 'test',
    cwd: '/client/home',
    stdout,
    stderr: '',
    exitCode,
    timedOut: false,
    truncated: false,
  };
}

function textOf(result: Awaited<ReturnType<typeof handleRunShell>>): string {
  const block = result.content[0];
  return block && block.type === 'text' ? block.text : '';
}

describe('handleRunShell', () => {
  it('executes on the server and returns success for exit 0', async () => {
    const ctx = makeCtx();
    const result = await handleRunShell(ctx, {
      command: `node -e "console.log('runshell-ok')"`,
    });
    expect(result.isError).toBe(false);
    const text = textOf(result);
    expect(text).toContain('[executed on server]');
    expect(text).toContain('exit code 0');
    expect(text).toContain('runshell-ok');
  });

  it('returns an error result for non-zero exit codes', async () => {
    const ctx = makeCtx();
    const result = await handleRunShell(ctx, {
      command: `node -e "process.exit(3)"`,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('exit code 3');
  });

  it('defaults the cwd to the session workspace path', async () => {
    const ctx = makeCtx();
    const result = await handleRunShell(ctx, {
      command: `node -e "console.log(process.cwd())"`,
    });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain(ctx.workspacePath);
  });
});

describe('handleLocalBash', () => {
  it('delegates to the client bridge when available', async () => {
    const ctx = makeCtx({
      runLocalShellFn: async () => bridgeResult('localbash-client-ok'),
    });
    const result = await handleLocalBash(ctx, { command: 'echo hi' });
    expect(result.isError).toBe(false);
    const text = textOf(result);
    expect(text).toContain('[executed on client]');
    expect(text).toContain('localbash-client-ok');
  });

  it('surfaces bridge failures instead of silently falling back to the server', async () => {
    const ctx = makeCtx({
      runLocalShellFn: async () => {
        throw new Error('client disconnected');
      },
    });
    const result = await handleLocalBash(ctx, { command: 'echo hi' });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('localbash client bridge failed');
    expect(text).toContain('client disconnected');
  });

  it('falls back to the server host with a note when no bridge exists', async () => {
    const ctx = makeCtx();
    const result = await handleLocalBash(ctx, {
      command: `node -e "console.log('localbash-fallback')"`,
    });
    expect(result.isError).toBe(false);
    const text = textOf(result);
    expect(text).toContain('no client shell bridge available');
    expect(text).toContain('[executed on server]');
    expect(text).toContain('localbash-fallback');
  });
});
