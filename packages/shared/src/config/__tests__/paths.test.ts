import { afterEach, describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_DIR_ENV,
  CONFIG_DIR_NAME,
  getConfigDir,
} from '../paths.ts';

const originalTokenBirdDir = process.env.TOKENBIRD_CONFIG_DIR;
const originalCraftDir = process.env.CRAFT_CONFIG_DIR;

afterEach(() => {
  if (originalTokenBirdDir === undefined) delete process.env.TOKENBIRD_CONFIG_DIR;
  else process.env.TOKENBIRD_CONFIG_DIR = originalTokenBirdDir;

  if (originalCraftDir === undefined) delete process.env.CRAFT_CONFIG_DIR;
  else process.env.CRAFT_CONFIG_DIR = originalCraftDir;
});

describe('TokenBird config path isolation', () => {
  test('uses a TokenBird-owned default and ignores the legacy Craft override', () => {
    delete process.env.TOKENBIRD_CONFIG_DIR;
    process.env.CRAFT_CONFIG_DIR = join(homedir(), '.craft-agent-test');

    expect(CONFIG_DIR_ENV).toBe('TOKENBIRD_CONFIG_DIR');
    expect(CONFIG_DIR_NAME).toBe('.tokenbird');
    expect(getConfigDir()).toBe(join(homedir(), '.tokenbird'));
  });

  test('supports an explicit TokenBird-only override', () => {
    const isolated = join(homedir(), '.tokenbird-test-instance');
    process.env.TOKENBIRD_CONFIG_DIR = isolated;

    expect(getConfigDir()).toBe(isolated);
  });
});
