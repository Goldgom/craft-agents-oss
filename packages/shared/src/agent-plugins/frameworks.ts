import type { AgentPluginDescriptor, AgentPluginRuntime } from './types.ts';

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
  nativeOptions?: { projectInstructions: boolean; skills: boolean; memory: boolean; toolsets: string[]; profile: string };
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
    case 'utility': return framework.capabilities.includes('utilityCompletion') ? ['native', 'host'] : ['host'];
    case 'steering': return framework.capabilities.includes('steering') ? ['native', 'disabled'] : ['disabled'];
    // Native Codex file tools do not expose the host's execution hook.
    case 'files': return framework.id === 'codex' ? ['native'] : framework.builtin ? ['native', 'disabled']
      : framework.capabilities.includes('nativeTools') ? ['native', 'host', 'disabled']
      : framework.capabilities.includes('hostTools') ? ['host', 'disabled'] : ['disabled'];
    default: return framework.capabilities.includes('hostTools') ? ['host', 'disabled'] : ['disabled'];
  }
}

export function defaultNativeOptions(): NonNullable<BackendFrameworkConfiguration['nativeOptions']> {
  return { projectInstructions: true, skills: true, memory: true, toolsets: [], profile: 'sdk' };
}

export function defaultFrameworkConfiguration(framework: AgentPluginDescriptor): BackendFrameworkConfiguration {
  return { id: framework.id, executablePath: '', entrypointPath: '', projectPath: '',
    features: Object.fromEntries(FRAMEWORK_FEATURES.map(feature => [feature, frameworkFeatureOptions(framework, feature)[0]])) as BackendFrameworkConfiguration['features'] };
}
