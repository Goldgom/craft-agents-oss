/**
 * Tests for data migration import (跨系统迁移数据导入):
 * round-trip restore, path remapping across platforms, traversal safety.
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
import { zipSync, strToU8 } from 'fflate';
import { exportAllData } from '../src/migration/export.ts';
import { importAllData, validateArchivePath } from '../src/migration/import.ts';
import { toPortablePath } from '../src/utils/paths.ts';

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-import-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function write(path: string, content: string) {
  writeFileSync(path, content, 'utf-8');
}

describe('validateArchivePath', () => {
  test('accepts normal relative paths and backslash variants', () => {
    expect(validateArchivePath('config/config.json')).toEqual(['config', 'config.json']);
    expect(validateArchivePath('workspaces/a/sessions/s1.json')).not.toBeNull();
    expect(validateArchivePath('workspaces\\a\\x.json')).toEqual(['workspaces', 'a', 'x.json']);
  });

  test('rejects traversal, absolute and drive paths', () => {
    expect(validateArchivePath('../evil.txt')).toBeNull();
    expect(validateArchivePath('workspaces/x/../../evil')).toBeNull();
    expect(validateArchivePath('/abs/evil')).toBeNull();
    expect(validateArchivePath('C:/evil')).toBeNull();
    expect(validateArchivePath('workspaces//x')).toBeNull();
    expect(validateArchivePath('')).toBeNull();
  });
});

describe('importAllData round-trip', () => {
  test('restores workspaces with remapped rootPath and workingDirectory', async () => {
    // --- Source machine (old paths) ---
    const sourceConfigDir = makeDir();
    const oldWsRoot = makeDir();
    const oldWorkingDir = join(oldWsRoot, 'sub');
    mkdirSync(oldWorkingDir, { recursive: true });

    write(
      join(sourceConfigDir, 'config.json'),
      JSON.stringify({
        workspaces: [
          { id: 'ws1', name: 'WS One', slug: 'ws-one', rootPath: oldWsRoot, createdAt: 1 },
        ],
        activeWorkspaceId: 'ws1',
        llmConnections: [{ slug: 'c1', name: 'Conn', providerType: 'anthropic', authType: 'oauth', createdAt: 1 }],
        defaultLlmConnection: 'c1',
      }),
    );
    write(join(sourceConfigDir, 'preferences.json'), JSON.stringify({ name: 'Ada' }));
    write(
      join(oldWsRoot, 'config.json'),
      JSON.stringify({
        id: 'ws1',
        name: 'WS One',
        createdAt: 1,
        updatedAt: 1,
        defaults: { workingDirectory: toPortablePath(oldWorkingDir) },
      }),
    );
    // Session whose header references the old workspace paths
    mkdirSync(join(oldWsRoot, 'sessions', 's1'), { recursive: true });
    write(
      join(oldWsRoot, 'sessions', 's1', 'session.jsonl'),
      JSON.stringify({ id: 's1', workingDirectory: toPortablePath(oldWorkingDir), sdkCwd: toPortablePath(oldWorkingDir) }) +
        '\n' +
        JSON.stringify({ type: 'user', message: 'hi' }) +
        '\n',
    );

    const backupPath = join(makeDir(), 'backup.zip');
    await exportAllData({ destPath: backupPath, configDir: sourceConfigDir });

    // --- Target machine (fresh dirs, different absolute paths) ---
    const targetConfigDir = makeDir();
    const targetBase = makeDir();
    const result = await importAllData({
      sourcePath: backupPath,
      configDir: targetConfigDir,
      workspacesBaseDir: targetBase,
    });

    expect(result.importedWorkspaces).toHaveLength(1);
    expect(result.warnings).toEqual([]);
    const imported = result.importedWorkspaces[0];
    expect(imported.id).toBe('ws1');
    expect(imported.rootPath).toBe(join(targetBase, 'ws-one'));

    // Global config merged with new rootPath
    const global = JSON.parse(readFileSync(join(targetConfigDir, 'config.json'), 'utf-8')) as {
      workspaces: Array<{ id: string; rootPath: string }>;
      activeWorkspaceId: string | null;
      llmConnections: unknown[];
      defaultLlmConnection: string;
    };
    expect(global.workspaces[0].rootPath).toBe(join(targetBase, 'ws-one'));
    expect(global.activeWorkspaceId).toBe('ws1');
    expect(global.llmConnections).toHaveLength(1);
    expect(global.defaultLlmConnection).toBe('c1');

    // Workspace config restored with remapped workingDirectory
    const wsConfig = JSON.parse(
      readFileSync(join(targetBase, 'ws-one', 'config.json'), 'utf-8'),
    ) as { defaults?: { workingDirectory?: string } };
    expect(wsConfig.defaults?.workingDirectory).toBe(
      toPortablePath(join(targetBase, 'ws-one', 'sub')),
    );

    // Session header remapped
    const jsonl = readFileSync(join(targetBase, 'ws-one', 'sessions', 's1', 'session.jsonl'), 'utf-8');
    const header = JSON.parse(jsonl.split('\n')[0]) as {
      workingDirectory?: string;
      sdkCwd?: string;
    };
    expect(header.workingDirectory).toBe(toPortablePath(join(targetBase, 'ws-one', 'sub')));
    expect(header.sdkCwd).toBe(toPortablePath(join(targetBase, 'ws-one', 'sub')));

    // Preferences restored
    expect(existsSync(join(targetConfigDir, 'preferences.json'))).toBe(true);
  });

  test('skips workspaces that already exist locally', async () => {
    const sourceConfigDir = makeDir();
    const oldWsRoot = makeDir();
    write(
      join(sourceConfigDir, 'config.json'),
      JSON.stringify({
        workspaces: [{ id: 'ws1', name: 'WS One', slug: 'ws-one', rootPath: oldWsRoot, createdAt: 1 }],
        activeWorkspaceId: null,
      }),
    );
    write(join(oldWsRoot, 'config.json'), JSON.stringify({ id: 'ws1', name: 'WS One', createdAt: 1, updatedAt: 1 }));
    const backupPath = join(makeDir(), 'backup.zip');
    await exportAllData({ destPath: backupPath, configDir: sourceConfigDir });

    const targetConfigDir = makeDir();
    const targetBase = makeDir();
    const existingRoot = join(targetBase, 'already-there');
    mkdirSync(existingRoot, { recursive: true });
    write(
      join(targetConfigDir, 'config.json'),
      JSON.stringify({
        workspaces: [{ id: 'ws1', name: 'Local WS', slug: 'ws-one', rootPath: existingRoot, createdAt: 2 }],
        activeWorkspaceId: 'ws1',
      }),
    );

    const result = await importAllData({
      sourcePath: backupPath,
      configDir: targetConfigDir,
      workspacesBaseDir: targetBase,
    });

    expect(result.importedWorkspaces).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('already exists'))).toBe(true);
    const global = JSON.parse(readFileSync(join(targetConfigDir, 'config.json'), 'utf-8')) as {
      workspaces: Array<{ id: string; rootPath: string }>;
    };
    expect(global.workspaces).toHaveLength(1);
    expect(global.workspaces[0].rootPath).toBe(existingRoot);
  });

  test('rejects archives without a manifest', async () => {
    const badZip = zipSync({ 'config/config.json': strToU8('{}') });
    const zipPath = join(makeDir(), 'bad.zip');
    writeFileSync(zipPath, Buffer.from(badZip));
    await expect(
      importAllData({ sourcePath: zipPath, configDir: makeDir(), workspacesBaseDir: makeDir() }),
    ).rejects.toThrow(/manifest/);
  });

  test('skips unsafe entries and writes nothing outside the target dirs', async () => {
    const configDir = makeDir();
    const baseDir = makeDir();
    const parent = makeDir();

    const manifest = {
      format: 'craft-agent-data-export',
      formatVersion: 2,
      appVersion: '0.0.0-test',
      exportedAt: new Date().toISOString(),
      platform: 'linux',
      includeCredentials: false,
      workspaces: [],
    };
    const evilZip = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'config/config.json': strToU8(JSON.stringify({ workspaces: [], activeWorkspaceId: null })),
      '../evil.txt': strToU8('evil'),
      'workspaces/x/../../evil2.txt': strToU8('evil2'),
    });
    const zipPath = join(parent, 'evil.zip');
    writeFileSync(zipPath, Buffer.from(evilZip));

    const result = await importAllData({ sourcePath: zipPath, configDir, workspacesBaseDir: baseDir });

    expect(result.importedWorkspaces).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('unsafe'))).toBe(true);
    // Nothing escaped into the parent of the target dirs
    expect(existsSync(join(parent, 'evil.txt'))).toBe(false);
    expect(existsSync(join(parent, 'evil2.txt'))).toBe(false);
    expect(existsSync(join(configDir, 'evil.txt'))).toBe(false);
  });

  test('round-trip preserves the archive from an import of an import (idempotent-ish)', async () => {
    // Import once, re-export from the target, import again into a third dir.
    const sourceConfigDir = makeDir();
    const oldWsRoot = makeDir();
    write(
      join(sourceConfigDir, 'config.json'),
      JSON.stringify({
        workspaces: [{ id: 'w2', name: 'W2', slug: 'w-two', rootPath: oldWsRoot, createdAt: 1 }],
        activeWorkspaceId: null,
      }),
    );
    write(join(oldWsRoot, 'config.json'), JSON.stringify({ id: 'w2', name: 'W2', createdAt: 1, updatedAt: 1 }));
    const backup1 = join(makeDir(), 'b1.zip');
    await exportAllData({ destPath: backup1, configDir: sourceConfigDir });

    const midConfigDir = makeDir();
    const midBase = makeDir();
    const first = await importAllData({ sourcePath: backup1, configDir: midConfigDir, workspacesBaseDir: midBase });
    expect(first.importedWorkspaces).toHaveLength(1);

    const backup2 = join(makeDir(), 'b2.zip');
    await exportAllData({ destPath: backup2, configDir: midConfigDir });

    const finalConfigDir = makeDir();
    const finalBase = makeDir();
    const second = await importAllData({ sourcePath: backup2, configDir: finalConfigDir, workspacesBaseDir: finalBase });
    expect(second.importedWorkspaces).toHaveLength(1);
    expect(second.importedWorkspaces[0].rootPath).toBe(join(finalBase, 'w-two'));
    const wsConfig = JSON.parse(
      readFileSync(join(finalBase, 'w-two', 'config.json'), 'utf-8'),
    ) as { id: string };
    expect(wsConfig.id).toBe('w2');
  });
});
