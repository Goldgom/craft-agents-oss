/**
 * Credential Storage Types
 *
 * Defines the types for secure credential storage using AES-256-GCM encryption.
 * Supports global and source-scoped credentials.
 *
 * Credential key format: "{type}::{scope...}"
 *
 * Examples:
 *   - anthropic_api_key::global
 *   - claude_oauth::global
 *   - source_oauth::{workspaceId}::{sourceId}
 *   - source_bearer::{workspaceId}::{sourceId}
 *
 * Note: Using "::" as delimiter to avoid conflicts with "/" in URLs or paths.
 */

/** Types of credentials we store */
export type CredentialType =
  // Global credentials (legacy, kept for backwards compatibility)
  | 'anthropic_api_key'  // Anthropic API key for Claude
  | 'claude_oauth'       // Claude OAuth token (Max subscription)
  // LLM connection credentials (keyed by connection slug)
  | 'llm_api_key'        // API key for LLM connection
  | 'llm_oauth'          // OAuth token for LLM connection
  | 'llm_iam'            // AWS IAM credentials (accessKeyId + secretAccessKey)
  | 'llm_service_account' // GCP service account JSON
  // Immutable local saved-connection revisions (name = ownerId/revision).
  | 'remote_server_token'
  | 'remote_workspace_token'
  | 'remote_sftp_password'
  | 'remote_sftp_passphrase'
  // Workspace credentials
  | 'workspace_oauth'    // Workspace MCP OAuth token
  // Source credentials (stored at ~/.tokenbird/workspaces/{ws}/sources/{slug}/)
  | 'source_oauth'       // OAuth tokens for MCP/API sources
  | 'source_bearer'      // Bearer tokens
  | 'source_apikey'      // API keys
  | 'source_basic'       // Basic auth (base64 encoded user:pass)
  // Messaging gateway credentials (keyed by workspaceId + platform)
  | 'messaging_bearer'   // Platform tokens (e.g., Telegram bot token)
  // Page publication admin token (keyed by workspaceId + pageId)
  | 'page_publish_token'; // Secret capability that authorizes publication update/unpublish

/** Valid credential types for validation */
const VALID_CREDENTIAL_TYPES: readonly CredentialType[] = [
  'anthropic_api_key',
  'claude_oauth',
  'llm_api_key',
  'llm_oauth',
  'llm_iam',
  'llm_service_account',
  'remote_server_token',
  'remote_workspace_token',
  'remote_sftp_password',
  'remote_sftp_passphrase',
  'workspace_oauth',
  'source_oauth',
  'source_bearer',
  'source_apikey',
  'source_basic',
  'messaging_bearer',
  'page_publish_token',
] as const;

/** Check if a string is a valid CredentialType */
function isValidCredentialType(type: string): type is CredentialType {
  return VALID_CREDENTIAL_TYPES.includes(type as CredentialType);
}

/** Credential identifier - determines credential store entry key */
export interface CredentialId {
  type: CredentialType;

  // LLM connection-scoped format
  /** LLM connection slug for llm_api_key/llm_oauth credentials */
  connectionSlug?: string;

  // Workspace-scoped format
  /** Workspace ID for workspace-scoped credentials */
  workspaceId?: string;
  /** Source ID for source credentials */
  sourceId?: string;
  /** Server name or API name */
  name?: string;
}

/**
 * Stored credential value in encrypted file.
 *
 * This is a generic type for all credential types (OAuth, bearer tokens, API keys, IAM, service accounts).
 * All fields except `value` are optional since not all credential types use them.
 *
 * Note: `clientId` is optional here unlike `OAuthCredentials` (in storage.ts)
 * where it's required, because this type also covers bearer tokens and API keys
 * which don't have a clientId.
 */
export interface StoredCredential {
  /** The secret value (API key, access token, or primary credential) */
  value: string;
  /** OAuth refresh token */
  refreshToken?: string;
  /** OAuth token expiration (Unix timestamp ms) */
  expiresAt?: number;
  /** OAuth scopes granted to this token, if the provider reports them */
  scope?: string;
  /** OAuth client ID (needed for token refresh) */
  clientId?: string;
  /** OAuth client secret (needed for Google token refresh - Google requires both ID and secret) */
  clientSecret?: string;
  /** Token type (e.g., "Bearer") */
  tokenType?: string;
  /** Where the credential came from: 'native' (our OAuth), 'cli' (Claude CLI import) */
  source?: 'native' | 'cli';
  /**
   * OIDC id_token (JWT with user identity claims).
   * Used by OpenAI/Codex which returns both id_token and access_token.
   * The `value` field stores access_token, this field stores id_token.
   */
  idToken?: string;

  // --- AWS IAM credentials (for llm_iam type) ---

  /** AWS Access Key ID (for IAM credentials) */
  awsAccessKeyId?: string;
  /** AWS Secret Access Key (for IAM credentials) - stored in `value` field */
  // awsSecretAccessKey is stored in the `value` field
  /** AWS Region (for IAM credentials) */
  awsRegion?: string;
  /** AWS Session Token (for temporary credentials) */
  awsSessionToken?: string;

  // --- GCP Service Account (for llm_service_account type) ---

  /** GCP Project ID (for service account) */
  gcpProjectId?: string;
  /** GCP Region (for service account) */
  gcpRegion?: string;
  /** Service account email (for identification) */
  serviceAccountEmail?: string;
  // Full service account JSON is stored in the `value` field
}

// Using "::" as delimiter instead of "/" because server names and API names
// could contain "/" (e.g., URLs like "https://api.example.com")
const CREDENTIAL_DELIMITER = '::';

/** Source credential types */
export const SOURCE_CREDENTIAL_TYPES = [
  'source_oauth',
  'source_bearer',
  'source_apikey',
  'source_basic',
] as const;

/** Messaging credential types */
const MESSAGING_CREDENTIAL_TYPES = [
  'messaging_bearer',
] as const;

/** Check if type is a messaging credential */
function isMessagingCredential(type: CredentialType): boolean {
  return (MESSAGING_CREDENTIAL_TYPES as readonly string[]).includes(type);
}

/** Check if type is a page publication credential (workspaceId + pageId via `name`) */
function isPageCredential(type: CredentialType): boolean {
  return type === 'page_publish_token';
}

/** LLM connection credential types */
const LLM_CREDENTIAL_TYPES = [
  'llm_api_key',
  'llm_oauth',
  'llm_iam',
  'llm_service_account',
] as const;

/** Check if type is a source credential */
function isSourceCredential(type: CredentialType): boolean {
  return (SOURCE_CREDENTIAL_TYPES as readonly string[]).includes(type);
}

/** Check if type is an LLM connection credential */
function isLlmCredential(type: CredentialType): boolean {
  return (LLM_CREDENTIAL_TYPES as readonly string[]).includes(type);
}

export const REMOTE_CREDENTIAL_TYPES = [
  'remote_server_token', 'remote_workspace_token', 'remote_sftp_password', 'remote_sftp_passphrase',
] as const;

function isRemoteCredential(type: CredentialType): boolean {
  return (REMOTE_CREDENTIAL_TYPES as readonly string[]).includes(type);
}

/** Convert CredentialId to credential store account string */
export function credentialIdToAccount(id: CredentialId): string {
  const parts: string[] = [id.type];

  if (isRemoteCredential(id.type) && id.name) {
    return [id.type, id.name].join(CREDENTIAL_DELIMITER);
  }

  // LLM connection-scoped format:
  // llm_api_key::{connectionSlug}
  // llm_oauth::{connectionSlug}
  if (isLlmCredential(id.type) && id.connectionSlug) {
    parts.push(id.connectionSlug);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  // Workspace-scoped format (no source):
  // workspace_oauth::{workspaceId}
  if (id.type === 'workspace_oauth' && id.workspaceId) {
    parts.push(id.workspaceId);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  // Source-scoped format:
  // Source credentials: source_oauth::{workspaceId}::{sourceId}
  if (isSourceCredential(id.type) && id.workspaceId && id.sourceId) {
    parts.push(id.workspaceId);
    parts.push(id.sourceId);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  // Messaging-scoped format:
  // messaging_bearer::{workspaceId}::{platform}
  if (isMessagingCredential(id.type) && id.workspaceId && id.name) {
    parts.push(id.workspaceId);
    parts.push(id.name);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  // Page-scoped format:
  // page_publish_token::{workspaceId}::{pageId}
  if (isPageCredential(id.type) && id.workspaceId && id.name) {
    parts.push(id.workspaceId);
    parts.push(id.name);
    return parts.join(CREDENTIAL_DELIMITER);
  }

  parts.push('global');
  return parts.join(CREDENTIAL_DELIMITER);
}

// ============================================================
// Credential Health Check Types
// ============================================================

/** Types of credential health issues detected at startup */
export type CredentialHealthIssueType =
  | 'file_corrupted'         // Credential file exists but can't be parsed
  | 'decryption_failed'      // File exists but can't be decrypted (machine migration)
  | 'no_default_credentials' // No credentials for the default connection

/** A single credential health issue */
export interface CredentialHealthIssue {
  type: CredentialHealthIssueType
  /** Human-readable error message */
  message: string
  /** Original error if available */
  error?: string
}

/** Result of credential store health check */
export interface CredentialHealthStatus {
  /** True if credential store is healthy and usable */
  healthy: boolean
  /** List of issues found (empty if healthy) */
  issues: CredentialHealthIssue[]
}

/** Parse credential store account string back to CredentialId. Returns null if invalid. */
export function accountToCredentialId(account: string): CredentialId | null {
  const parts = account.split(CREDENTIAL_DELIMITER);
  const typeStr = parts[0];

  // Validate the type
  if (!typeStr || !isValidCredentialType(typeStr)) {
    return null;
  }

  const type = typeStr;

  if (isRemoteCredential(type)) {
    return parts.length === 2 && !!parts[1] ? { type, name: parts[1] } : null;
  }

  // LLM connection-scoped format:
  // llm_api_key::{connectionSlug}
  // llm_oauth::{connectionSlug}
  if (isLlmCredential(type) && parts.length === 2) {
    return { type, connectionSlug: parts[1] };
  }

  // Workspace-scoped format (no source):
  // workspace_oauth::{workspaceId}
  if (type === 'workspace_oauth' && parts.length === 2) {
    return { type, workspaceId: parts[1] };
  }

  // Source-scoped format:
  // Source credentials: source_oauth::{workspaceId}::{sourceId}
  if (isSourceCredential(type) && parts.length === 3) {
    return { type, workspaceId: parts[1], sourceId: parts[2] };
  }

  // Messaging-scoped format:
  // messaging_bearer::{workspaceId}::{platform}
  if (isMessagingCredential(type) && parts.length === 3) {
    return { type, workspaceId: parts[1], name: parts[2] };
  }

  // Page-scoped format:
  // page_publish_token::{workspaceId}::{pageId}
  if (isPageCredential(type) && parts.length === 3) {
    return { type, workspaceId: parts[1], name: parts[2] };
  }

  if (parts.length === 2 && parts[1] === 'global') {
    return { type };
  }

  // Unknown format
  return null;
}

/** One entry in an atomic encrypted-store update. */
export interface CredentialWrite {
  id: CredentialId;
  credential: StoredCredential;
}

/** Internal optimistic-concurrency token; never a renderer credential field. */
export interface CredentialSnapshot {
  credential: StoredCredential | null;
  revision: string;
}

export interface CredentialCompareAndSet {
  id: CredentialId;
  expectedRevision: string;
  /** null deletes the entry if it is still the exact observed revision. */
  credential: StoredCredential | null;
}

export class CredentialChangedError extends Error {
  constructor() {
    super('Credentials changed while a refresh was in progress. The refresh result was not saved; check the current sign-in before trying again.');
    this.name = 'CredentialChangedError';
  }
}

/** Validate the complete batch without including secret values in errors. */
export function validateCredentialWrites(entries: CredentialWrite[]): void {
  if (!Array.isArray(entries) || entries.length > 1000) throw new Error('Invalid credential batch');
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry?.id || !isValidCredentialType(entry.id.type) || !entry.credential
      || typeof entry.credential.value !== 'string' || !entry.credential.value.trim()) {
      throw new Error('Each credential must have a valid type and non-empty value');
    }
    const id = entry.id;
    const validPart = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !value.includes(CREDENTIAL_DELIMITER);
    if ((isSourceCredential(id.type) && (!validPart(id.workspaceId) || !validPart(id.sourceId)))
      || (isLlmCredential(id.type) && !validPart(id.connectionSlug))
      || (id.type === 'workspace_oauth' && !validPart(id.workspaceId))
      || (isRemoteCredential(id.type) && (!validPart(id.name) || id.workspaceId !== undefined || id.sourceId !== undefined || id.connectionSlug !== undefined))
      || ((isMessagingCredential(id.type) || isPageCredential(id.type)) && (!validPart(id.workspaceId) || !validPart(id.name)))) {
      throw new Error('Credential scope is missing or invalid');
    }
    const key = credentialIdToAccount(id);
    if (seen.has(key)) throw new Error('Duplicate credential in batch');
    seen.add(key);
  }
}
