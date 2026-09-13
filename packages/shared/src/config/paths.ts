/**
 * Centralized path configuration for TokenBird.
 *
 * Supports multi-instance development via TOKENBIRD_CONFIG_DIR environment variable.
 * When running from a numbered folder, the development launcher sets
 * TOKENBIRD_CONFIG_DIR to ~/.tokenbird-1, allowing multiple instances to run
 * simultaneously with separate configurations.
 *
 * Default (non-numbered folders): ~/.tokenbird/
 * Instance 1 (-1 suffix): ~/.tokenbird-1/
 * Instance 2 (-2 suffix): ~/.tokenbird-2/
 */

import { homedir } from 'os';
import { join } from 'path';

/** TokenBird-owned data must never fall back to Craft Agents' legacy directory. */
export const CONFIG_DIR_ENV = 'TOKENBIRD_CONFIG_DIR';
export const CONFIG_DIR_NAME = '.tokenbird';

/** Resolve dynamically for tests and development launchers that set the env at runtime. */
export function getConfigDir(): string {
  return process.env[CONFIG_DIR_ENV] || join(homedir(), CONFIG_DIR_NAME);
}

// Most consumers capture the directory once at module load.
export const CONFIG_DIR = getConfigDir();
