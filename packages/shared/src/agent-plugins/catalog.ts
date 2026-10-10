import type { LlmConnection } from '../config/llm-connections.ts';
import type { AgentPluginDescriptor, AgentPluginRuntime } from './types.ts';
import { BUNDLED_AGENT_PLUGIN_PRESETS } from './presets.ts';

export const BUILTIN_AGENT_PLUGINS: readonly AgentPluginDescriptor[] = [
  { id: 'pi', name: 'Pi', description: 'Pi agent runtime', version: '1', builtin: true, enabled: true,
    capabilities: ['resume', 'steering', 'utilityCompletion', 'hostTools', 'toolApproval'], compatibility: { providerTypes: ['anthropic', 'pi', 'pi_compat'] } },
  { id: 'claude-code', name: 'Claude Code', description: 'Claude Agent SDK', version: '1', builtin: true, enabled: true,
    capabilities: ['resume', 'utilityCompletion', 'hostTools', 'toolApproval'], compatibility: { providerTypes: ['anthropic'] } },
  { id: 'codex', name: 'Codex', description: 'Native app-server when eligible; explicit Pi compatibility fallback', version: '1', builtin: true, enabled: true,
    capabilities: ['resume', 'utilityCompletion', 'hostTools', 'toolApproval'], compatibility: { providerTypes: ['pi', 'pi_compat'] } },
];

let externalPlugins: AgentPluginDescriptor[] = [];

/** Renderer catalog is refreshed from the server hosting the agent processes. */
export function setAgentPluginCatalog(plugins: AgentPluginDescriptor[]): void {
  externalPlugins = plugins.filter(plugin => !plugin.builtin && plugin.id.startsWith('plugin:'));
}

export function getAgentPluginCatalog(): AgentPluginDescriptor[] {
  return [...BUILTIN_AGENT_PLUGINS,
    ...BUNDLED_AGENT_PLUGIN_PRESETS.filter(preset => !externalPlugins.some(plugin => plugin.id === preset.id)),
    ...externalPlugins];
}

export function getAgentPluginDescriptor(id: AgentPluginRuntime): AgentPluginDescriptor | undefined {
  return getAgentPluginCatalog().find(plugin => plugin.id === id);
}

export function isAgentPluginCompatible(plugin: AgentPluginDescriptor,
  connection: Pick<LlmConnection, 'providerType' | 'piAuthProvider'> & Partial<Pick<LlmConnection, 'authType'>>): boolean {
  const match = plugin.compatibility;
  return plugin.enabled && match.providerTypes.includes(connection.providerType)
    && (!match.piAuthProviders || match.piAuthProviders.includes(connection.piAuthProvider ?? (connection.providerType === 'pi_compat' ? 'openai' : '')))
    && (!match.authTypes || (connection.authType != null && match.authTypes.includes(connection.authType)));
}

/** Capability attribution stays visible; missing native features are never claimed as native. */
export function describeAgentPluginCapabilities(plugin: AgentPluginDescriptor) {
  return {
    native: [...plugin.capabilities],
    host: ['preferences', 'workspaceInstructions', 'skills', 'history', 'taskScheduling',
      ...(plugin.capabilities.includes('hostTools') ? ['sessionTools', 'mcpTools'] : [])],
    hostFallbacks: plugin.capabilities.includes('utilityCompletion') ? [] : ['utilityInference'],
    unavailable: (['resume', 'steering', 'utilityCompletion', 'hostTools', 'toolApproval'] as const)
      .filter(capability => !plugin.capabilities.includes(capability)),
  };
}
