/**
 * Unit tests for the host-side shell executor used by `runshell` / `localbash`.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeShell } from './shell.ts';

describe('executeShell', () => {
  it('captures stdout and exit code 0', async () => {
    const result = await executeShell({
      command: `node -e "console.log('shell-test-out')"`,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('shell-test-out');
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('captures stderr and non-zero exit codes', async () => {
    const result = await executeShell({
      command: `node -e "console.error('shell-test-err');process.exit(7)"`,
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain('shell-test-err');
    expect(result.timedOut).toBe(false);
  });

  it('runs in the provided cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shell-cwd-'));
    try {
      const result = await executeShell({
        command: `node -e "console.log(process.cwd())"`,
        cwd: dir,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(dir);
      expect(result.cwd).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when the cwd does not exist', async () => {
    const missing = join(tmpdir(), 'definitely-missing-dir-123456');
    await expect(
      executeShell({ command: 'echo x', cwd: missing }),
    ).rejects.toThrow(/Working directory not found/);
  });

  it('throws on an empty command', async () => {
    await expect(executeShell({ command: '   ' })).rejects.toThrow(/required/);
  });

  it('kills the process and reports timedOut when the timeout elapses', async () => {
    const result = await executeShell({
      command: `node -e "setTimeout(()=>{}, 60000)"`,
      timeoutMs: 1_000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('truncates oversized output at the 200k cap', async () => {
    const result = await executeShell({
      command: `node -e "console.log('x'.repeat(400000))"`,
    });
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(200_000);
  });
});
