/**
 * Config Types (Browser-safe)
 *
 * Pure type definitions for configuration.
 * Re-exports from @craft-agent/core for compatibility.
 */

// Re-export all config types from core (single source of truth)
export type {
  Workspace,
  McpAuthType,
  AuthType,
  OAuthCredentials,
} from '@craft-agent/core/types';

/** App-level network proxy configuration. */
export interface NetworkProxySettings {
  enabled: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

export type RuntimeToolId = 'java' | 'python' | 'node';

export interface RuntimeToolPaths {
  java?: string;
  python?: string;
  node?: string;
}

export interface RuntimeToolStatus {
  id: RuntimeToolId;
  source: 'custom' | 'bundled' | 'system' | 'missing';
  configuredPath?: string;
  executablePath?: string;
  version?: string;
  available: boolean;
  error?: string;
}
