/**
 * Tests for remote server profile storage (remote-servers.json).
 *
 * CONFIG_DIR is captured at module load from CRAFT_CONFIG_DIR, so each test
 * points the env at a fresh temp dir and re-imports the module.
 */

import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type RemoteServersModule = typeof import('../remote-servers.ts');

// CONFIG_DIR is captured at module load from CRAFT_CONFIG_DIR. Import the
// module ONCE against a single temp dir and share it for the whole file —
// bun caches modules, so re-importing after swapping env would still point at
// the first (deleted) temp dir.
let tempDir = '';
let mod: RemoteServersModule;
const originalConfigDir = process.env.CRAFT_CONFIG_DIR;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'remote-servers-'));
  process.env.CRAFT_CONFIG_DIR = tempDir;
  mod = await import('../remote-servers.ts');
});

afterAll(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  if (originalConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR;
  else process.env.CRAFT_CONFIG_DIR = originalConfigDir;
});

describe('normalizeServerUrl', () => {
  it('accepts ws/wss URLs and strips trailing slashes', () => {
    expect(mod.normalizeServerUrl('ws://1.2.3.4:50003/')).toBe('ws://1.2.3.4:50003');
    expect(mod.normalizeServerUrl('wss://example.com/ws')).toBe('wss://example.com/ws');
  });

  it('rejects non-ws URLs', () => {
    expect(() => mod.normalizeServerUrl('http://example.com')).toThrow();
    expect(() => mod.normalizeServerUrl('not a url')).toThrow();
  });
});

describe('profile CRUD', () => {
  it('creates, lists, updates and deletes profiles', () => {
    expect(mod.loadRemoteServerProfiles()).toEqual([]);

    const created = mod.upsertRemoteServerProfile({
      name: 'My Server',
      url: 'ws://1.2.3.4:50003',
      token: 'secret-token',
    });
    expect(created.id).toBeTruthy();
    expect(created.token).toBe('secret-token');

    const listed = mod.loadRemoteServerProfiles();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe('My Server');

    // Info DTO strips the token but reports its presence.
    const info = mod.toProfileInfo(created);
    expect(info.hasToken).toBe(true);
    expect('token' in info).toBe(false);

    // Update with a blank token keeps the existing token.
    const updated = mod.upsertRemoteServerProfile({
      id: created.id,
      name: 'Renamed',
      url: 'wss://example.com:50003',
    });
    expect(updated.name).toBe('Renamed');
    expect(updated.url).toBe('wss://example.com:50003');
    expect(updated.token).toBe('secret-token');
    expect(mod.loadRemoteServerProfiles()).toHaveLength(1);

    mod.markRemoteServerConnected(created.id);
    expect(mod.getRemoteServerProfile(created.id)?.lastConnectedAt).toBeGreaterThan(0);

    expect(mod.deleteRemoteServerProfile(created.id)).toBe(true);
    expect(mod.loadRemoteServerProfiles()).toEqual([]);
    expect(mod.deleteRemoteServerProfile(created.id)).toBe(false);
  });

  it('persists to <config-dir>/remote-servers.json', () => {
    mod.upsertRemoteServerProfile({ name: 'P', url: 'ws://h:1' });
    expect(existsSync(join(tempDir, 'remote-servers.json'))).toBe(true);
    const raw = JSON.parse(readFileSync(join(tempDir, 'remote-servers.json'), 'utf-8'));
    expect(Array.isArray(raw)).toBe(true);
    expect(raw[0].name).toBe('P');
  });

  it('stores SFTP secrets locally but strips them from renderer DTOs', () => {
    const created = mod.upsertRemoteServerProfile({
      name: 'SFTP Server',
      url: 'wss://sftp.example.com:50003',
      sftp: {
        enabled: true,
        username: 'deploy',
        password: 'sftp-secret',
        remoteRoot: '/srv/craft',
      },
    });

    expect(created.sftp?.host).toBe('sftp.example.com');
    expect(created.sftp?.port).toBe(22);
    expect(created.sftp?.password).toBe('sftp-secret');

    const info = mod.toProfileInfo(created);
    expect(info.sftp?.hasPassword).toBe(true);
    expect('password' in (info.sftp ?? {})).toBe(false);

    const updated = mod.upsertRemoteServerProfile({
      id: created.id,
      name: created.name,
      url: created.url,
      sftp: {
        enabled: true,
        username: 'deploy',
        authMethod: 'password',
      },
    });
    expect(updated.sftp?.password).toBe('sftp-secret');
    mod.deleteRemoteServerProfile(created.id);
  });

  it('tolerates corrupt files', () => {
    const file = join(tempDir, 'remote-servers.json');
    mod.upsertRemoteServerProfile({ name: 'P', url: 'ws://h:1' });
    // Corrupt the file.
    writeFileSync(file, '{not json', 'utf-8');
    expect(mod.loadRemoteServerProfiles()).toEqual([]);
  });
});
