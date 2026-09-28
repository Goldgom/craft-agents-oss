import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import {
  CRAFT_PI_EPHEMERAL_MAX_BACKOFF_MS,
  CRAFT_PI_EPHEMERAL_QUERY_DEADLINE_MS,
  CRAFT_PI_EPHEMERAL_RETRY_SETTINGS,
  CRAFT_PI_RETRY_SETTINGS,
  createCraftSettingsManager,
} from './session-settings.ts';

describe('createCraftSettingsManager', () => {
  it('pins the agent-level auto-retry policy', () => {
    const settings = createCraftSettingsManager();
    expect(settings.getRetryEnabled()).toBe(true);
    expect(CRAFT_PI_RETRY_SETTINGS.maxRetries).toBe(5);
    expect(settings.getRetrySettings()).toEqual({
      enabled: true,
      maxRetries: CRAFT_PI_RETRY_SETTINGS.maxRetries,
      baseDelayMs: CRAFT_PI_RETRY_SETTINGS.baseDelayMs,
    });
  });

  it('disables provider-level retries so the total main-chat budget stays at five', () => {
    const settings = createCraftSettingsManager();
    expect(settings.getProviderRetrySettings()).toMatchObject({
      maxRetries: 0,
      maxRetryDelayMs: CRAFT_PI_RETRY_SETTINGS.provider.maxRetryDelayMs,
    });
    expect(SettingsManager.inMemory().getProviderRetrySettings().maxRetries).toBeUndefined();
  });

  it('uses a smaller retry policy for bounded ephemeral queries', () => {
    const settings = createCraftSettingsManager('ephemeral');
    expect(settings.getRetrySettings()).toEqual({
      enabled: true,
      maxRetries: CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.maxRetries,
      baseDelayMs: CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.baseDelayMs,
    });
    expect(settings.getProviderRetrySettings()).toMatchObject({
      maxRetries: CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.provider.maxRetries,
      maxRetryDelayMs: CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.provider.maxRetryDelayMs,
    });
    expect(CRAFT_PI_EPHEMERAL_MAX_BACKOFF_MS).toBe(6_000);
    expect(CRAFT_PI_EPHEMERAL_QUERY_DEADLINE_MS).toBe(115_000);
    expect(CRAFT_PI_EPHEMERAL_MAX_BACKOFF_MS).toBeLessThan(
      CRAFT_PI_EPHEMERAL_QUERY_DEADLINE_MS,
    );
  });

  it('keeps auto-compaction enabled', () => {
    expect(createCraftSettingsManager().getCompactionEnabled()).toBe(true);
  });

  it('ignores a .pi/settings.json in the working directory', () => {
    // A repo used as the session's working directory may ship Pi project
    // settings. The SDK's default SettingsManager.create(cwd, agentDir) merges
    // them (project scope is trusted by default) — a repo could silently turn
    // off retries or compaction for Craft sessions. The in-memory manager must
    // not see them.
    const cwd = mkdtempSync(join(tmpdir(), 'craft-pi-settings-'));
    try {
      mkdirSync(join(cwd, '.pi'));
      writeFileSync(
        join(cwd, '.pi', 'settings.json'),
        JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
      );

      // Proves the default path would have honored the repo file…
      const fromDisk = SettingsManager.create(cwd, join(cwd, 'agent-dir'));
      expect(fromDisk.getRetryEnabled()).toBe(false);
      expect(fromDisk.getCompactionEnabled()).toBe(false);

      // …and that Craft's manager does not.
      const settings = createCraftSettingsManager();
      expect(settings.getRetryEnabled()).toBe(true);
      expect(settings.getCompactionEnabled()).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns a fresh manager per call so sessions cannot leak settings into each other', () => {
    const a = createCraftSettingsManager('ephemeral');
    const b = createCraftSettingsManager('ephemeral');
    expect(a).not.toBe(b);
    a.setRetryEnabled(false);
    expect(a.getRetryEnabled()).toBe(false);
    expect(b.getRetryEnabled()).toBe(true);
  });
});
