import type { AgentPluginDescriptor, AgentPluginManifest } from './types.ts';

export type BundledAgentBackend = 'hermes' | 'dsh';
export const BUNDLED_AGENT_PLUGIN_PRESETS: readonly AgentPluginDescriptor[] = [
  { id: 'plugin:hermes', name: 'Hermes', description: 'Hermes native agent with TokenBird sources and tools',
    version: '2.0.0', builtin: false, enabled: false, setupRequired: true,
    capabilities: ['resume', 'steering', 'nativeTools', 'hostTools', 'toolApproval'],
    compatibility: { providerTypes: ['pi', 'pi_compat'], piAuthProviders: ['openai', 'deepseek'],
      authTypes: ['api_key', 'api_key_with_endpoint', 'bearer_token', 'oauth', 'none'] } },
  { id: 'plugin:dsh', name: 'DeepSeek Harness', description: 'DeepSeek Harness native agent with TokenBird sources and tools',
    version: '2.0.0', builtin: false, enabled: false, setupRequired: true,
    capabilities: ['nativeTools', 'hostTools', 'toolApproval'],
    compatibility: { providerTypes: ['pi', 'pi_compat'], piAuthProviders: ['openai', 'deepseek'],
      authTypes: ['api_key', 'api_key_with_endpoint', 'bearer_token', 'oauth', 'none'] } },
];

/** Browser-safe configuration. The server resolves the bundled bridge path. */
export function createBundledAgentManifest(input: {
  backend: BundledAgentBackend; pythonPath: string; hermesRoot?: string;
}): AgentPluginManifest {
  const preset = BUNDLED_AGENT_PLUGIN_PRESETS.find(value => value.id === `plugin:${input.backend}`);
  if (!preset) throw new Error('Unknown bundled agent backend');
  if (!input.pythonPath.trim()) throw new Error('Specify the native agent Python executable');
  if (input.backend === 'hermes' && !input.hermesRoot?.trim()) throw new Error('Specify the Hermes checkout directory');
  return {
    schemaVersion: 1, id: preset.id as `plugin:${string}`, name: preset.name, description: preset.description,
    version: preset.version, enabled: true, capabilities: [...preset.capabilities],
    compatibility: { ...preset.compatibility }, useConnectionCredentials: true,
    transport: { type: 'stdio', command: input.pythonPath.trim(),
      args: [`tokenbird:bridge:${input.backend}`, ...(input.backend === 'hermes' ? ['--hermes-root', input.hermesRoot!.trim()] : [])],
      requestTimeoutMs: 120_000 },
  };
}
