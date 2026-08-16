/**
 * Tests for data migration export (跨系统迁移数据):
 * archive structure, whitelisting, credential exclusion.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { unzipSync, strFromU8 } from 'fflate';
import { exportAllData } from '../src/migration/export.ts';

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function write(filePath: string, content: string) {
  writeFileSync(filePath, content, 'utf-8');
}

describe('exportAllData', () => {
  test('bundles global settings and workspace app data; excludes project files', async () => {
    const configDir = makeDir();
    const wsRoot = makeDir();

    // Global config with one workspace
    write(
      join(configDir, 'config.json'),
      JSON.stringify({
        workspaces: [
          { id: 'ws1', name: 'WS One', slug: 'ws-one', rootPath: wsRoot, createdAt: 1 },
        ],
        activeWorkspaceId: 'ws1',
      }),
    );
    write(join(configDir, 'preferences.json'), JSON.stringify({ name: 'Ada' }));
    write(join(configDir, 'credentials.enc'), 'ENCRYPTED-SECRET');
    mkdirSync(join(configDir, 'permissions'), { recursive: true });
    write(join(configDir, 'permissions', 'default.json'), '{}');

    // Workspace app data
    write(
      join(wsRoot, 'config.json'),
      JSON.stringify({
        id: 'ws1',
        name: 'WS One',
        createdAt: 1,
        updatedAt: 1,
        prompts: [
          {
            id: 'p1',
            title: 'Code style',
            content: 'Always use tabs.',
            enabled: true,
            source: 'manual',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    mkdirSync(join(wsRoot, 'statuses'), { recursive: true });
    write(join(wsRoot, 'statuses', 'config.json'), '{"statuses":[]}');
    mkdirSync(join(wsRoot, 'sessions'), { recursive: true });
    write(join(wsRoot, 'sessions', 's1.json'), '{}');

    // Project files that must NOT be exported
    write(join(wsRoot, 'README.md'), 'project readme');
    mkdirSync(join(wsRoot, 'node_modules'), { recursive: true });
    write(join(wsRoot, 'node_modules', 'big.js'), 'heavy');

    const destPath = join(makeDir(), 'backup.zip');
    const result = await exportAllData({ destPath, configDir });

    expect(result.workspaceCount).toBe(1);
    expect(result.fileCount).toBeGreaterThanOrEqual(7);
    expect(existsSync(destPath)).toBe(true);
    expect(result.warnings.some((w) => w.includes('credentials.enc'))).toBe(true);

    const files = unzipSync(new Uint8Array(readFileSync(destPath)));
    const names = Object.keys(files);
    expect(names).toContain('manifest.json');
    expect(names).toContain('config/config.json');
    expect(names).toContain('config/preferences.json');
    expect(names).toContain('config/permissions/default.json');
    expect(names).toContain('workspaces/ws-one/config.json');
    expect(names).toContain('workspaces/ws-one/statuses/config.json');
    expect(names).toContain('workspaces/ws-one/sessions/s1.json');
    expect(names.some((n) => n.includes('node_modules'))).toBe(false);
    expect(names.some((n) => n.includes('README'))).toBe(false);
    expect(names.some((n) => n.includes('credentials'))).toBe(false);

    const manifest = JSON.parse(strFromU8(files['manifest.json'])) as {
      format: string;
      formatVersion: number;
      appVersion: string;
      workspaces: unknown[];
    };
    expect(manifest.format).toBe('craft-agent-data-export');
    expect(manifest.formatVersion).toBe(2);
    expect(typeof manifest.appVersion).toBe('string');
    expect(manifest.workspaces).toHaveLength(1);
    expect((manifest.workspaces[0] as { rootPath?: string }).rootPath).toBe(wsRoot);
  });

  test('includes credentials.enc when explicitly requested', async () => {
    const configDir = makeDir();
    write(
      join(configDir, 'config.json'),
      JSON.stringify({ workspaces: [], activeWorkspaceId: null }),
    );
    write(join(configDir, 'credentials.enc'), 'ENCRYPTED-SECRET');

    const destPath = join(makeDir(), 'with-creds.zip');
    const result = await exportAllData({ destPath, configDir, includeCredentials: true });

    expect(result.warnings.some((w) => w.includes('credentials'))).toBe(false);
    const files = unzipSync(new Uint8Array(readFileSync(destPath)));
    expect(Object.keys(files)).toContain('config/credentials.enc');
  });

  test('skips workspaces without rootPath and records a warning', async () => {
    const configDir = makeDir();
    write(
      join(configDir, 'config.json'),
      JSON.stringify({
        workspaces: [{ id: 'orphan', name: 'Orphan', slug: 'orphan', createdAt: 1 }],
        activeWorkspaceId: null,
      }),
    );

    const destPath = join(makeDir(), 'orphan.zip');
    const result = await exportAllData({ destPath, configDir });

    expect(result.workspaceCount).toBe(0);
    expect(result.warnings.some((w) => w.includes('rootPath'))).toBe(true);
  });

  test('throws when config.json is missing', async () => {
    const configDir = makeDir();
    const destPath = join(makeDir(), 'missing.zip');
    await expect(exportAllData({ destPath, configDir })).rejects.toThrow(/not found/);
  });
});
