import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

const PREFS_MODULE = pathToFileURL(join(import.meta.dir, '..', 'preferences.ts')).href;

function runScript(configDir: string, script: string) {
  return Bun.spawnSync([process.execPath, '--eval', script], {
    env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('one-shot workspace selection preference', () => {
  it('is false by default', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'preferences-workspace-selection-'));
    try {
      const result = runScript(configDir, `
        import { consumeWorkspaceSelectionOnNextLaunch } from '${PREFS_MODULE}';
        console.log(consumeWorkspaceSelectionOnNextLaunch());
      `);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe('false');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('is consumed once and preserves unrelated preferences', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'preferences-workspace-selection-'));
    const prefsFile = join(configDir, 'preferences.json');
    try {
      writeFileSync(prefsFile, JSON.stringify({ name: 'Alice', startupServerLocation: 'remote-1' }), 'utf-8');
      const result = runScript(configDir, `
        import {
          requestWorkspaceSelectionOnNextLaunch,
          consumeWorkspaceSelectionOnNextLaunch,
        } from '${PREFS_MODULE}';
        requestWorkspaceSelectionOnNextLaunch();
        console.log(JSON.stringify({
          first: consumeWorkspaceSelectionOnNextLaunch(),
          second: consumeWorkspaceSelectionOnNextLaunch(),
        }));
      `);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({ first: true, second: false });

      const persisted = JSON.parse(readFileSync(prefsFile, 'utf-8'));
      expect(persisted.name).toBe('Alice');
      expect(persisted.startupServerLocation).toBe('remote-1');
      expect(persisted).not.toHaveProperty('selectWorkspaceOnNextLaunch');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
