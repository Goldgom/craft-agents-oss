import type { AgentPluginDescriptor, AgentPluginRuntime } from './types.ts';
import type { LlmAuthType } from '../config/llm-connections.ts';

export interface AgentFrameworkProfile {
  runtime: AgentPluginRuntime;
  key: string;
  strengths: string[];
  suitableTasks: string[];
  limitations: string[];
}

/** Adapter-backed traits, not model intelligence scores or promises about task duration. */
const profiles: Record<string, Omit<AgentFrameworkProfile, 'runtime'>> = {
  pi: { key: 'pi', strengths: ['Multi-provider model transport', 'Streaming steering', 'Native context compaction and session tree'],
    suitableTasks: ['Tasks requiring different model providers', 'Interactive coding and iteration'],
    limitations: ['MCP tools and approvals are supplied by TokenBird', 'Project extensions are restricted in Super Agent environments'] },
  'claude-code': { key: 'claude', strengths: ['Claude Agent SDK coding loop', 'Project instructions and skills', 'Native session branching and compaction'],
    suitableTasks: ['Repository analysis', 'Code changes and verification', 'Reusable project workflows'],
    limitations: ['Requires an Anthropic connection', 'Super Agent delegation and tool execution follow node policy'] },
  codex: { key: 'codex', strengths: ['Native Codex reasoning and coding loop', 'Streaming steering', 'Native planning and context compaction'],
    suitableTasks: ['Code implementation', 'Debugging and review', 'Long coding sessions'],
    limitations: ['Native execution requires a supported installed CLI and OpenAI or compatible Responses transport', 'Other transports use the explicit Pi compatibility loop', 'Super Agent file and command execution uses TokenBird tools'] },
  'plugin:hermes': { key: 'hermes', strengths: ['Native persistent memory', 'Native skills', 'Configurable toolsets', 'Session database and context compression', 'Streaming steering'],
    suitableTasks: ['Repeated workflows', 'Tasks benefiting from accumulated preferences and reusable skills'],
    limitations: ['Requires the configured Hermes Python runtime', 'Native toolsets still obey TokenBird node permissions', 'Auxiliary inference uses the model connection'] },
  'plugin:dsh': { key: 'dsh', strengths: ['Native plugin-based harness', 'Configurable execution profiles', 'Native context management with TokenBird tools as plugins'],
    suitableTasks: ['Custom tool workflows', 'Profile-based execution pipelines'],
    limitations: ['Requires the pinned DeepSeek Harness SDK', 'Adapter does not support native resume or streaming steering', 'Visible history and auxiliary inference are supplied by TokenBird'] },
};

export function getAgentFrameworkProfile(runtime: AgentPluginRuntime): AgentFrameworkProfile | undefined {
  const profile = profiles[runtime];
  return profile ? { runtime, key: profile.key, strengths: [...profile.strengths],
    suitableTasks: [...profile.suitableTasks], limitations: [...profile.limitations] } : undefined;
}

/** Coordinator-visible strengths reflect configured opt-outs and supervised execution. */
export function getConfiguredAgentFrameworkProfile(runtime: AgentPluginRuntime, configuration?: BackendFrameworkConfiguration,
  supervised = false): AgentFrameworkProfile | undefined {
  const profile = getAgentFrameworkProfile(runtime);
  if (!profile) return undefined;
  profile.strengths = profile.strengths.filter(strength =>
    !(configuration?.features.steering === 'disabled' && strength === 'Streaming steering')
    && !(configuration?.nativeOptions?.memory === false && strength === 'Native persistent memory')
    && !(configuration?.nativeOptions?.skills === false && strength === 'Native skills')
    && !((supervised || configuration?.nativeOptions?.projectInstructions === false) && strength === 'Project instructions and skills'));
  if (configuration?.features.history === 'host') {
    profile.strengths = profile.strengths.map(strength =>
      ['Native context compaction and session tree', 'Native session branching and compaction'].includes(strength)
        ? 'Native context compaction' : strength === 'Session database and context compression' ? 'Native context compression' : strength);
    profile.strengths.push('TokenBird visible history recovery');
  }
  if (supervised && ['pi', 'claude-code', 'codex'].includes(runtime)) {
    profile.limitations.push('Project resources are controlled by TokenBird; use only assigned node skill instructions');
  }
  return profile;
}

/** Shared by factory, coordinator context and selection UI so routing claims stay consistent. */
export function nativeCodexTransportCompatible(input: {
  piAuthProvider?: string; baseUrl?: string; customEndpoint?: unknown; authType?: LlmAuthType; oauthProvider?: string;
}): boolean {
  if (input.baseUrl) {
    const api = (input.customEndpoint as { api?: string } | undefined)?.api;
    const responses = api === 'openai-responses'
      || (input.oauthProvider === 'tokennest' && api !== 'anthropic-messages')
      || (!input.customEndpoint && [undefined, 'openai'].includes(input.piAuthProvider));
    return responses && (['api_key', 'api_key_with_endpoint', 'none'].includes(input.authType ?? '')
      || (input.authType === 'oauth' && input.oauthProvider === 'tokennest'));
  }
  return (!input.piAuthProvider || ['openai', 'openai-codex'].includes(input.piAuthProvider))
    && !input.baseUrl && !input.customEndpoint
    && [undefined, 'api_key', 'api_key_with_endpoint', 'oauth', 'none'].includes(input.authType);
}

export type FrameworkFeature = 'history' | 'utility' | 'steering' | 'files' | 'sources' | 'sessionTools' | 'browser';
export type FrameworkImplementation = 'native' | 'host' | 'disabled';
export type FrameworkDownloadSource = 'official' | 'mirror';
export const FRAMEWORK_FEATURES: readonly FrameworkFeature[] = ['history', 'utility', 'steering', 'files', 'sources', 'sessionTools', 'browser'];

export interface BackendFrameworkConfiguration {
  id: AgentPluginRuntime;
  /** Empty paths select the bundled/detected runtime for built-in frameworks. */
  executablePath: string;
  entrypointPath: string;
  projectPath: string;
  features: Record<FrameworkFeature, FrameworkImplementation>;
  nativeOptions?: { projectInstructions: boolean; skills: boolean; memory: boolean; toolsets: string[]; profile: string; claudePlugins?: string[] };
  downloadSource?: FrameworkDownloadSource;
}

export type FrameworkInstallPhase = 'preparing' | 'downloading' | 'dependencies' | 'testing' | 'activating' | 'complete' | 'failed' | 'cancelled';
export interface FrameworkInstallProgress { id: AgentPluginRuntime; phase: FrameworkInstallPhase; }
export interface BackendFrameworkInstallation {
  available: boolean; managed: boolean; installable: boolean;
  progress?: FrameworkInstallProgress;
}
export interface BackendFrameworkInstallResult {
  success: boolean; configuration?: BackendFrameworkConfiguration; test?: BackendFrameworkTestResult; error?: string;
}

export interface BackendFrameworkEntry extends AgentPluginDescriptor {
  configuration: BackendFrameworkConfiguration;
  detectedLocation?: { executablePath?: string; entrypointPath?: string };
  installation?: BackendFrameworkInstallation;
}

export interface BackendFrameworkCatalog { frameworks: BackendFrameworkEntry[]; errors: string[] }
export interface BackendFrameworkTestResult {
  success: boolean;
  /** Installation and local protocol checks; never a production model request. */
  checks: Array<{ kind: 'location' | 'runtime' | 'protocol'; success: boolean; detail?: string }>;
  version?: string;
}

/** Offer only routes implemented by the selected adapter. */
export function frameworkFeatureOptions(framework: AgentPluginDescriptor, feature: FrameworkFeature): FrameworkImplementation[] {
  switch (feature) {
    case 'history': return framework.capabilities.includes('resume') ? ['native', 'host'] : ['host'];
    case 'utility': return framework.id === 'plugin:antigravity' ? ['disabled'] : framework.capabilities.includes('utilityCompletion') ? ['native', 'host'] : ['host'];
    case 'steering': return framework.capabilities.includes('steering') ? ['native', 'disabled'] : ['disabled'];
    // Codex can retain its loop while delegating file execution to the host.
    case 'files': return framework.id === 'plugin:antigravity' ? ['native'] : framework.id === 'codex' ? ['native', 'host', 'disabled'] : framework.builtin ? ['native', 'disabled']
      : framework.capabilities.includes('nativeTools') ? ['native', 'host', 'disabled']
      : framework.capabilities.includes('hostTools') ? ['host', 'disabled'] : ['disabled'];
    default: return framework.capabilities.includes('hostTools') ? ['host', 'disabled'] : ['disabled'];
  }
}

export function defaultNativeOptions(): NonNullable<BackendFrameworkConfiguration['nativeOptions']> {
  return { projectInstructions: true, skills: true, memory: true, toolsets: [], profile: 'sdk' };
}

/** Super Agent nodes must not discover native plugin hooks or MCP processes. */
export function claudeFrameworkPlugins(configuration: BackendFrameworkConfiguration | undefined, supervised: boolean) {
  return supervised ? [] : (configuration?.nativeOptions?.claudePlugins ?? []).map(path => ({ type: 'local' as const, path }));
}

export function defaultFrameworkConfiguration(framework: AgentPluginDescriptor): BackendFrameworkConfiguration {
  return { id: framework.id, executablePath: '', entrypointPath: '', projectPath: '',
    features: Object.fromEntries(FRAMEWORK_FEATURES.map(feature => [feature, frameworkFeatureOptions(framework, feature)[0]])) as BackendFrameworkConfiguration['features'] };
}
