import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getConfigDir } from '../config/paths.ts';
import { getAgentPluginCatalog, setAgentPluginCatalog } from './catalog.ts';
import type { AgentPluginCatalog, AgentPluginManifest, AgentPluginRuntime } from './types.ts';
import { BUNDLED_AGENT_PLUGIN_PRESETS } from './presets.ts';

const boundedText = z.string().min(1).max(20_000);
export const agentPluginManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^plugin:[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(100), description: z.string().max(2_000),
  version: z.string().min(1).max(100), enabled: z.boolean(),
  capabilities: z.array(z.enum(['resume', 'steering', 'utilityCompletion', 'hostTools', 'toolApproval', 'nativeTools'])).max(6),
  compatibility: z.object({
    providerTypes: z.array(z.enum(['anthropic', 'pi', 'pi_compat'])).min(1).max(3),
    piAuthProviders: z.array(z.string().min(1).max(100)).max(100).optional(),
    authTypes: z.array(z.enum(['api_key', 'api_key_with_endpoint', 'oauth', 'bearer_token', 'iam_credentials', 'service_account_file', 'none', 'environment'])).max(8).optional(),
  }).strict(),
  transport: z.object({
    type: z.literal('stdio'), command: boundedText,
    args: z.array(z.string().max(20_000)).max(100), cwd: boundedText.optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(20_000)).optional(),
    requestTimeoutMs: z.number().int().min(1_000).max(300_000).optional(),
    turnTimeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
  }).strict(),
  useConnectionCredentials: z.boolean().optional(),
}).strict();

export function validateAgentPluginManifest(value: unknown): AgentPluginManifest {
  return agentPluginManifestSchema.parse(value) as AgentPluginManifest;
}

function configPath(): string { return join(getConfigDir(), 'agent-plugins.json'); }

export function loadAgentPluginManifests(): { manifests: AgentPluginManifest[]; errors: string[] } {
  const path = configPath();
  if (!existsSync(path)) return { manifests: [], errors: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (raw?.version !== 1 || !Array.isArray(raw.plugins)) throw new Error('Invalid agent plugin catalog');
    const manifests: AgentPluginManifest[] = [];
    const errors: string[] = [];
    const ids = new Set<string>();
    for (const [index, value] of raw.plugins.entries()) {
      try {
        const plugin = validateAgentPluginManifest(value);
        const preset = BUNDLED_AGENT_PLUGIN_PRESETS.find(item => item.id === plugin.id);
        if (preset && plugin.transport.args[0] === `tokenbird:bridge:${plugin.id.slice(7)}`) {
          plugin.version = preset.version; plugin.capabilities = [...preset.capabilities];
        }
        if (ids.has(plugin.id)) throw new Error(`Duplicate plugin: ${plugin.id}`);
        ids.add(plugin.id); manifests.push(plugin);
      } catch (error) { errors.push(`Plugin ${index + 1}: ${String(error)}`); }
    }
    return { manifests, errors };
  } catch (error) { return { manifests: [], errors: [String(error)] }; }
}

export function refreshAgentPluginCatalog(): AgentPluginCatalog {
  const { manifests, errors } = loadAgentPluginManifests();
  const plugins = manifests.map(({ transport: _transport, useConnectionCredentials: _credentials, schemaVersion: _schema, ...descriptor }) => ({ ...descriptor, builtin: false }));
  setAgentPluginCatalog(plugins);
  return { plugins: getAgentPluginCatalog(), errors };
}

function saveManifests(manifests: AgentPluginManifest[]): void {
  const path = configPath();
  mkdirSync(getConfigDir(), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, plugins: manifests }, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
  refreshAgentPluginCatalog();
}

export function saveAgentPluginManifest(value: unknown): AgentPluginManifest {
  const plugin = validateAgentPluginManifest(value);
  const { manifests, errors } = loadAgentPluginManifests();
  if (errors.length) throw new Error(errors.join('\n'));
  saveManifests([...manifests.filter(item => item.id !== plugin.id), plugin]);
  return plugin;
}

export function deleteAgentPluginManifest(id: AgentPluginRuntime): void {
  if (!id.startsWith('plugin:')) throw new Error('Built-in agents cannot be removed');
  const { manifests, errors } = loadAgentPluginManifests();
  if (errors.length) throw new Error(errors.join('\n'));
  saveManifests(manifests.filter(item => item.id !== id));
}

export function setAgentPluginEnabled(id: AgentPluginRuntime, enabled: boolean): void {
  const plugin = loadAgentPluginManifests().manifests.find(item => item.id === id);
  if (!plugin) throw new Error(`Agent plugin not found: ${id}`);
  saveAgentPluginManifest({ ...plugin, enabled });
}

export function getAgentPluginManifest(id: AgentPluginRuntime): AgentPluginManifest {
  const plugin = loadAgentPluginManifests().manifests.find(item => item.id === id);
  if (!plugin?.enabled) throw new Error(`Agent plugin is missing or disabled: ${id}`);
  return plugin;
}

/** Opaque runtime revision; includes executable/config changes without exposing their values. */
export function getAgentPluginFingerprint(id: AgentPluginRuntime): string | undefined {
  if (!id.startsWith('plugin:')) return undefined;
  const { manifests, errors } = loadAgentPluginManifests();
  const plugin = manifests.find(item => item.id === id);
  return plugin ? createHash('sha256').update(JSON.stringify(plugin)).digest('hex') : errors.length ? 'invalid' : 'missing';
}
