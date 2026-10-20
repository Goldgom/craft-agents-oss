import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { getModelPromptSettings } from '../../shared/src/config/llm-connections.ts';
import {
  TOKENBIRD_PI_EPHEMERAL_MAX_BACKOFF_MS,
  TOKENBIRD_PI_EPHEMERAL_QUERY_DEADLINE_MS,
  TOKENBIRD_PI_EPHEMERAL_RETRY_SETTINGS,
  TOKENBIRD_PI_RETRY_SETTINGS,
  createTokenBirdSettingsManager,
} from './session-settings.ts';

describe('createTokenBirdSettingsManager', () => {
  it('pins the agent-level auto-retry policy', () => {
    const settings = createTokenBirdSettingsManager();
    expect(settings.getRetryEnabled()).toBe(true);
    expect(TOKENBIRD_PI_RETRY_SETTINGS.maxRetries).toBe(5);
    expect(settings.getRetrySettings()).toEqual({
      enabled: true,
      maxRetries: TOKENBIRD_PI_RETRY_SETTINGS.maxRetries,
      baseDelayMs: TOKENBIRD_PI_RETRY_SETTINGS.baseDelayMs,
    });
  });

  it('disables provider-level retries so the total main-chat budget stays at five', () => {
    const settings = createTokenBirdSettingsManager();
    expect(settings.getProviderRetrySettings()).toMatchObject({
      maxRetries: 0,
      maxRetryDelayMs: TOKENBIRD_PI_RETRY_SETTINGS.provider.maxRetryDelayMs,
    });
    expect(SettingsManager.inMemory().getProviderRetrySettings().maxRetries).toBeUndefined();
  });

  it('uses a smaller retry policy for bounded ephemeral queries', () => {
    const settings = createTokenBirdSettingsManager('ephemeral');
    expect(TOKENBIRD_PI_EPHEMERAL_RETRY_SETTINGS.maxRetries).toBe(3);
    expect(settings.getRetrySettings()).toEqual({
      enabled: true,
      maxRetries: TOKENBIRD_PI_EPHEMERAL_RETRY_SETTINGS.maxRetries,
      baseDelayMs: TOKENBIRD_PI_EPHEMERAL_RETRY_SETTINGS.baseDelayMs,
    });
    expect(settings.getProviderRetrySettings()).toMatchObject({
      maxRetries: TOKENBIRD_PI_EPHEMERAL_RETRY_SETTINGS.provider.maxRetries,
      maxRetryDelayMs: TOKENBIRD_PI_EPHEMERAL_RETRY_SETTINGS.provider.maxRetryDelayMs,
    });
    expect(TOKENBIRD_PI_EPHEMERAL_MAX_BACKOFF_MS).toBe(14_000);
    expect(TOKENBIRD_PI_EPHEMERAL_QUERY_DEADLINE_MS).toBe(115_000);
    expect(TOKENBIRD_PI_EPHEMERAL_MAX_BACKOFF_MS).toBeLessThan(
      TOKENBIRD_PI_EPHEMERAL_QUERY_DEADLINE_MS,
    );
  });

  it('keeps auto-compaction enabled', () => {
    expect(createTokenBirdSettingsManager().getCompactionEnabled()).toBe(true);
    expect(createTokenBirdSettingsManager().getCompactionSettings().keepRecentTokens).toBe(512);
    expect(createTokenBirdSettingsManager('ephemeral').getCompactionSettings().keepRecentTokens).toBe(20_000);
  });

  it('converts a model token limit to the Pi SDK reserve threshold', () => {
    const settings = createTokenBirdSettingsManager('main', { tokenLimit: 80_000, contextWindow: 100_000 });
    expect(settings.getCompactionSettings()).toEqual({ enabled: true, reserveTokens: 20_000, keepRecentTokens: 512 });
    expect(createTokenBirdSettingsManager('ephemeral', { tokenLimit: 80_000, contextWindow: 100_000 })
      .getCompactionReserveTokens()).toBe(16_384);
  });

  it('uses the GPT default to start automatic compaction at 500k tokens', () => {
    const tokenLimit = getModelPromptSettings(undefined, 'gpt-6.1-sol')?.autoCompactionTokenLimit;
    const settings = createTokenBirdSettingsManager('main', { tokenLimit, contextWindow: 1_000_000 });
    expect(settings.getCompactionSettings()).toEqual({ enabled: true, reserveTokens: 500_000, keepRecentTokens: 512 });
  });

  it('ignores a .pi/settings.json in the working directory', () => {
    // A repo used as the session's working directory may ship Pi project
    // settings. The SDK's default SettingsManager.create(cwd, agentDir) merges
    // them (project scope is trusted by default) — a repo could silently turn
    // off retries or compaction for TokenBird sessions. The in-memory manager must
    // not see them.
    const cwd = mkdtempSync(join(tmpdir(), 'tokenbird-pi-settings-'));
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

      // …and that TokenBird's manager does not.
      const settings = createTokenBirdSettingsManager();
      expect(settings.getRetryEnabled()).toBe(true);
      expect(settings.getCompactionEnabled()).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('returns a fresh manager per call so sessions cannot leak settings into each other', () => {
    const a = createTokenBirdSettingsManager('ephemeral');
    const b = createTokenBirdSettingsManager('ephemeral');
    expect(a).not.toBe(b);
    a.setRetryEnabled(false);
    expect(a.getRetryEnabled()).toBe(false);
    expect(b.getRetryEnabled()).toBe(true);
  });
});
