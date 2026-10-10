import type { LlmAuthType, LlmProviderType } from '../config/llm-connections.ts';

export type BuiltinAgentRuntime = 'pi' | 'codex' | 'claude-code';
export type AgentPluginRuntime = BuiltinAgentRuntime | `plugin:${string}`;
export type AgentPluginCapability = 'resume' | 'steering' | 'utilityCompletion' | 'hostTools' | 'toolApproval' | 'nativeTools';

/** Serializable catalog entry. Safe to import in desktop/web renderers. */
export interface AgentPluginDescriptor {
  id: AgentPluginRuntime;
  name: string;
  description: string;
  version: string;
  builtin: boolean;
  enabled: boolean;
  /** Bundled adapter whose native runtime has not been configured yet. */
  setupRequired?: boolean;
  capabilities: AgentPluginCapability[];
  compatibility: {
    providerTypes: LlmProviderType[];
    piAuthProviders?: string[];
    authTypes?: LlmAuthType[];
  };
}

/** External agents run in their own process; a bridge owns the native agent loop. */
export interface AgentPluginManifest extends Omit<AgentPluginDescriptor, 'builtin'> {
  schemaVersion: 1;
  id: `plugin:${string}`;
  transport: {
    type: 'stdio';
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    requestTimeoutMs?: number;
    turnTimeoutMs?: number;
  };
  /** Explicit opt-in. Only this connection's credentials are supplied at initialization. */
  useConnectionCredentials?: boolean;
}

export interface AgentPluginCatalog {
  plugins: AgentPluginDescriptor[];
  errors: string[];
}
