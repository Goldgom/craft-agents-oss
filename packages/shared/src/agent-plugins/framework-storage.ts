import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { getConfigDir } from '../config/paths.ts';
import { getAgentPluginCatalog, getAgentPluginDescriptor } from './catalog.ts';
import { loadAgentPluginManifests, saveAgentPluginManifest, refreshAgentPluginCatalog, getAgentPluginFingerprint } from './storage.ts';
import { createAntigravityManifest, createBundledAgentManifest } from './presets.ts';
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
    profile: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100),
    claudePlugins: z.array(pathText.min(1)).max(50).optional() }).strict().optional() }).strict();

const detected = new Map<AgentPluginRuntime, { executablePath?: string; entrypointPath?: string }>();
export function setDetectedFrameworkLocation(id: AgentPluginRuntime, location: { executablePath?: string; entrypointPath?: string }): void {
  detected.set(id, location);
}

function detectAntigravity(): string | undefined {
  const name = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const locations = [...(process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(isAbsolute),
    ...(process.platform === 'win32' && process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'agy', 'bin')]
      : [join(homedir(), '.local', 'bin')])];
  return locations.map(root => join(root, name)).find(existsSync);
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
  if (configuration.id === 'plugin:antigravity') {
    if (!configuration.executablePath || /^agy(?:\.exe)?$/i.test(configuration.executablePath)) {
      configuration.executablePath = detectAntigravity() ?? '';
    }
    if (!isAbsolute(configuration.executablePath)) throw new Error('Specify the absolute path to agy, or install the official Antigravity CLI');
  }
  if (configuration.id.startsWith('plugin:') && !configuration.executablePath) throw new Error('Specify the agent Python or bridge executable');
  if (configuration.id === 'plugin:hermes' && !configuration.projectPath) throw new Error('Specify the Hermes project directory');
  if (configuration.id !== 'pi' && configuration.entrypointPath) throw new Error('This framework does not use a Pi service entrypoint');
  if (configuration.id !== 'plugin:hermes' && configuration.projectPath) throw new Error('This framework does not use a Hermes project directory');
  if ((configuration.executablePath.includes('/') || configuration.executablePath.includes('\\')) && !isAbsolute(configuration.executablePath)) throw new Error('Use an absolute executable path or a program name from PATH');
  if (configuration.entrypointPath && !isAbsolute(configuration.entrypointPath)) throw new Error('Use an absolute Pi service entrypoint path');
  if (configuration.projectPath && !isAbsolute(configuration.projectPath)) throw new Error('Use an absolute Hermes project directory');
  const plugins = configuration.nativeOptions?.claudePlugins ?? [];
  if (plugins.length && configuration.id !== 'claude-code') throw new Error('Native Claude plugins require the Claude Code framework');
  if (new Set(plugins).size !== plugins.length) throw new Error('Duplicate Claude plugin directory');
  for (const path of plugins) {
    if (!isAbsolute(path)) throw new Error('Use an absolute Claude plugin directory on the backend host');
    const manifestPath = join(path, '.claude-plugin', 'plugin.json');
    if (!existsSync(manifestPath)) throw new Error('Claude plugin directory must contain .claude-plugin/plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest?.name !== 'string' || !manifest.name.trim()) throw new Error('Claude plugin manifest must include a name');
  }
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
      configuration.executablePath = framework.id === 'plugin:antigravity' && manifest.transport.command === 'tokenbird:python'
        ? manifest.transport.args[1] ?? '' : manifest.transport.command;
      if (framework.id === 'plugin:hermes') {
        const index = manifest.transport.args.indexOf('--hermes-root');
        configuration.projectPath = index < 0 ? '' : manifest.transport.args[index + 1] ?? '';
      }
    }
    return { ...framework, configuration, detectedLocation: framework.id === 'plugin:antigravity'
      ? { executablePath: detectAntigravity() } : detected.get(framework.id) };
  }), errors: catalog.errors };
}

export function saveBackendFrameworkConfiguration(value: unknown): BackendFrameworkConfiguration {
  const configuration = validateBackendFrameworkConfiguration(value);
  const settings = readSettings(); // Validate storage before updating either store.
  if (configuration.id.startsWith('plugin:')) {
    const existing = loadAgentPluginManifests().manifests.find(item => item.id === configuration.id);
    if (configuration.id === 'plugin:antigravity') {
      saveAgentPluginManifest({ ...createAntigravityManifest(configuration.executablePath), enabled: existing?.enabled ?? true });
    } else if (configuration.id === 'plugin:hermes' || configuration.id === 'plugin:dsh') {
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
