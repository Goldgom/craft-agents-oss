import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBashShellPath } from './bash-shell-path.ts';

/**
 * Regression contract for the built-in bash tool's shell resolution (#935).
 *
 * The globally configured Git Bash path (config.json `gitBashPath`) must be
 * honored by the Pi SDK's built-in bash tool. Without it, the SDK only
 * searches hardcoded Program Files locations + PATH, which misses per-user
 * Git installs (e.g. %LOCALAPPDATA%\Programs\Git) → "No bash shell found".
 */

describe('resolveBashShellPath', () => {
  it('returns undefined on non-Windows platforms', () => {
    expect(resolveBashShellPath('C:\\Git\\bin\\bash.exe', undefined, 'darwin')).toBeUndefined();
    expect(resolveBashShellPath(undefined, 'C:\\Git\\bin\\bash.exe', 'linux')).toBeUndefined();
  });

  it('returns undefined when no candidate exists on disk', () => {
    expect(
      resolveBashShellPath('C:\\definitely-missing\\bash.exe', undefined, 'win32'),
    ).toBeUndefined();
  });

  it('falls back to the env path when the configured path is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-shell-path-'));
    try {
      const bashExe = join(dir, 'bash.exe');
      writeFileSync(bashExe, '');
      expect(resolveBashShellPath('C:\\missing\\bash.exe', bashExe, 'win32')).toBe(bashExe);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the configured path when it exists, ignoring the env fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-shell-path-'));
    try {
      const configured = join(dir, 'configured-bash.exe');
      const envPath = join(dir, 'env-bash.exe');
      writeFileSync(configured, '');
      writeFileSync(envPath, '');
      expect(resolveBashShellPath(configured, envPath, 'win32')).toBe(configured);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('trims whitespace and ignores blank candidates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bash-shell-path-'));
    try {
      const bashExe = join(dir, 'bash.exe');
      writeFileSync(bashExe, '');
      expect(resolveBashShellPath(`  ${bashExe}  `, '   ', 'win32')).toBe(bashExe);
      expect(resolveBashShellPath('   ', undefined, 'win32')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
