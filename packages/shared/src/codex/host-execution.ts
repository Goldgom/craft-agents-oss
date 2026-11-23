import type { JsonValue } from './native-protocol.ts';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Never import config.toml: empty TOML tables merge with inherited MCP servers. */
export async function createCodexHostHome(parent: string, workDir: string, loginHome?: string): Promise<string> {
  await mkdir(parent, { recursive: true });
  const home = await mkdtemp(join(parent, 'host-'));
  await writeFile(join(home, 'config.toml'),
    `cli_auth_credentials_store = "file"\n[projects.${JSON.stringify(workDir)}]\ntrust_level = "untrusted"\n`, { mode: 0o600 });
  if (loginHome) {
    try { await copyFile(join(loginHome, 'auth.json'), join(home, 'auth.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return home;
}

/** Reviewed against codex-cli 0.171.0. No native environment is attached in host execution mode. */
export const CODEX_HOST_EXECUTION_CONFIG: Record<string, JsonValue> = {
  'features.shell_tool': false,
  'features.view_image': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.apps': false,
  'features.plugins': false,
  'features.hooks': false,
  'features.memories': false,
  'features.image_generation': false,
  'features.browser_use': false,
  'features.computer_use': false,
  'features.code_mode': false,
  'features.goals': false,
  'web_search': 'disabled',
  'mcp_servers': {},
  'project_doc_max_bytes': 0,
  'skills.include_instructions': false,
};

/** Config overrides are TOML, not JSON. Dotted keys are passed as individual arguments. */
export function codexHostExecutionArgs(): string[] {
  return Object.entries(CODEX_HOST_EXECUTION_CONFIG).flatMap(([key, value]) =>
    ['-c', `${key}=${typeof value === 'object' ? '{}' : JSON.stringify(value)}`]);
}
