import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { getConfigDir } from '../config/paths.ts';
import { getAgentPluginCatalog, getAgentPluginDescriptor } from './catalog.ts';
import { loadAgentPluginManifests, saveAgentPluginManifest, refreshAgentPluginCatalog, getAgentPluginFingerprint } from './storage.ts';
import { createBundledAgentManifest } from './presets.ts';
import { defaultFrameworkConfiguration, FRAMEWORK_FEATURES, frameworkFeatureOptions,
  type BackendFrameworkConfiguration, type BackendFrameworkCatalog } from './frameworks.ts';
import type { AgentPluginRuntime } from './types.ts';

const pathText = z.string().trim().max(20_000);
const implementation = z.enum(['native', 'host', 'disabled']);
const schema = z.object({ id: z.string().regex(/^(pi|codex|claude-code|plugin:[a-z0-9][a-z0-9-]{0,63})$/),
  executablePath: pathText, entrypointPath: pathText, projectPath: pathText,
  features: z.object({ history: implementation, utility: implementation, steering: implementation, files: implementation,
    sources: implementation, sessionTools: implementation, browser: implementation }).strict(),
  downloadSource: z.enum(['official', 'mirror']).optional(),
  nativeOptions: z.object({ projectInstructions: z.boolean(), skills: z.boolean(), memory: z.boolean(),
    toolsets: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100)).max(100),
    profile: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100) }).strict().optional() }).strict();

const detected = new Map<AgentPluginRuntime, { executablePath?: string; entrypointPath?: string }>();
export function setDetectedFrameworkLocation(id: AgentPluginRuntime, location: { executablePath?: string; entrypointPath?: string }): void {
  detected.set(id, location);
}

function readSettings(): BackendFrameworkConfiguration[] {
  const path = join(getConfigDir(), 'agent-frameworks.json');
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data?.version !== 1 || !Array.isArray(data.frameworks)) throw new Error('Invalid backend framework settings');
  return data.frameworks.map((item: unknown) => schema.parse(item)) as BackendFrameworkConfiguration[];
}

export function loadBackendFrameworkConfiguration(id: AgentPluginRuntime): BackendFrameworkConfiguration | undefined {
  return readSettings().find(item => item.id === id);
}

export function validateBackendFrameworkConfiguration(value: unknown): BackendFrameworkConfiguration {
  const configuration = schema.parse(value) as BackendFrameworkConfiguration;
  refreshAgentPluginCatalog();
  const framework = getAgentPluginDescriptor(configuration.id);
  if (!framework) throw new Error('Unsupported backend framework');
  for (const feature of FRAMEWORK_FEATURES) {
    if (!frameworkFeatureOptions(framework, feature).includes(configuration.features[feature])) {
      throw new Error(`Unsupported implementation for ${feature}`);
    }
  }
  if (configuration.id.startsWith('plugin:') && !configuration.executablePath) throw new Error('Specify the agent Python or bridge executable');
  if (configuration.id === 'plugin:hermes' && !configuration.projectPath) throw new Error('Specify the Hermes project directory');
  if (configuration.id !== 'pi' && configuration.entrypointPath) throw new Error('This framework does not use a Pi service entrypoint');
  if (configuration.id !== 'plugin:hermes' && configuration.projectPath) throw new Error('This framework does not use a Hermes project directory');
  if ((configuration.executablePath.includes('/') || configuration.executablePath.includes('\\')) && !isAbsolute(configuration.executablePath)) throw new Error('Use an absolute executable path or a program name from PATH');
  if (configuration.entrypointPath && !isAbsolute(configuration.entrypointPath)) throw new Error('Use an absolute Pi service entrypoint path');
  if (configuration.projectPath && !isAbsolute(configuration.projectPath)) throw new Error('Use an absolute Hermes project directory');
  return configuration;
}

export function getBackendFrameworkCatalog(): BackendFrameworkCatalog {
  const catalog = refreshAgentPluginCatalog();
  let settings: BackendFrameworkConfiguration[] = [];
  try { settings = readSettings(); } catch (error) { catalog.errors.push(String(error)); }
  const manifests = loadAgentPluginManifests().manifests;
  return { frameworks: getAgentPluginCatalog().map(framework => {
    const configuration = settings.find(item => item.id === framework.id) ?? defaultFrameworkConfiguration(framework);
    const manifest = manifests.find(item => item.id === framework.id);
    // Upgrade existing bridge manifests without exporting arbitrary environment variables.
    if (manifest && !settings.some(item => item.id === framework.id)) {
      configuration.executablePath = manifest.transport.command;
      if (framework.id === 'plugin:hermes') {
        const index = manifest.transport.args.indexOf('--hermes-root');
        configuration.projectPath = index < 0 ? '' : manifest.transport.args[index + 1] ?? '';
      }
    }
    return { ...framework, configuration, detectedLocation: detected.get(framework.id) };
  }), errors: catalog.errors };
}

export function saveBackendFrameworkConfiguration(value: unknown): BackendFrameworkConfiguration {
  const configuration = validateBackendFrameworkConfiguration(value);
  const settings = readSettings(); // Validate storage before updating either store.
  if (configuration.id.startsWith('plugin:')) {
    const existing = loadAgentPluginManifests().manifests.find(item => item.id === configuration.id);
    if (configuration.id === 'plugin:hermes' || configuration.id === 'plugin:dsh') {
      const manifest = createBundledAgentManifest({ backend: configuration.id === 'plugin:hermes' ? 'hermes' : 'dsh',
        pythonPath: configuration.executablePath, hermesRoot: configuration.projectPath });
      saveAgentPluginManifest({ ...manifest, ...(existing ? { enabled: existing.enabled,
        useConnectionCredentials: existing.useConnectionCredentials,
        transport: { ...existing.transport, command: manifest.transport.command, args: manifest.transport.args } } : {}) });
    } else {
      if (!existing) throw new Error('Backend adapter is not installed');
      saveAgentPluginManifest({ ...existing, transport: { ...existing.transport, command: configuration.executablePath } });
    }
  }
  mkdirSync(getConfigDir(), { recursive: true });
  const path = join(getConfigDir(), 'agent-frameworks.json');
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, frameworks: [...settings.filter(item => item.id !== configuration.id), configuration] }, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
  return configuration;
}

export function getBackendFrameworkFingerprint(id: AgentPluginRuntime): string | undefined {
  const settings = loadBackendFrameworkConfiguration(id);
  const plugin = getAgentPluginFingerprint(id);
  return settings ? createHash('sha256').update(JSON.stringify([settings, plugin])).digest('hex') : plugin;
}
