/** Native Electron IPC only. Never register these channels on the RPC server. */
import type { CredentialId, CredentialType, StoredCredential } from './types.ts';

export const NATIVE_CREDENTIAL_IPC = {
  STATUS: '__credentials:status',
  LIST: '__credentials:list',
  APPLY: '__credentials:apply',
  MIGRATE: '__credentials:migrate',
} as const;

export const NATIVE_CREDENTIAL_LIMITS = {
  maxChanges: 1000,
  maxFieldBytes: 1_048_576,
  maxRequestBytes: 8_388_608,
  maxIdLength: 256,
} as const;

export const NATIVE_CREDENTIAL_TYPES = [
  'saved_credential',
  'anthropic_api_key', 'claude_oauth', 'llm_api_key', 'llm_oauth',
  'llm_iam', 'llm_service_account', 'workspace_oauth', 'source_oauth',
  'source_bearer', 'source_apikey', 'source_basic', 'messaging_bearer',
  'page_publish_token',
] as const satisfies readonly CredentialType[];

export const NATIVE_CREDENTIAL_FIELDS = [
  'username', 'credentialKind', 'credentialUrl',
  'value', 'refreshToken', 'expiresAt', 'scope', 'clientId', 'clientSecret',
  'tokenType', 'source', 'idToken', 'awsAccessKeyId', 'awsRegion',
  'awsSessionToken', 'gcpProjectId', 'gcpRegion', 'serviceAccountEmail',
] as const satisfies readonly (keyof StoredCredential)[];

export type NativeCredentialErrorCode =
  | 'UNTRUSTED_SENDER'
  | 'INVALID_REQUEST'
  | 'SCOPE_NOT_ALLOWED'
  | 'OS_STORAGE_UNAVAILABLE'
  | 'OS_STORAGE_INSECURE'
  | 'VAULT_NATIVE_ONLY'
  | 'PROTECTION_UPGRADE_FAILED'
  | 'REMOTE_MIGRATION_INCOMPLETE'
  | 'VAULT_CORRUPT'
  | 'VAULT_LOCKED'
  | 'VAULT_READ_FAILED'
  | 'VAULT_WRITE_FAILED';

/** Fixed, non-secret diagnostics only; never attach original errors or causes. */
export type NativeCredentialResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: NativeCredentialErrorCode; message: string };

export interface NativeCredentialScope {
  workspaceId: string;
  /** Existing source-vault namespace derived only from the registered root.
   * null means ambiguous/unavailable; never fall back to the window UUID. */
  sourceWorkspaceId: string | null;
  sourceScopeUnavailable: boolean;
  includesGlobal: true;
  includesLlm: true;
}

export interface NativeCredentialVaultStatus {
  state: 'ready' | 'empty' | 'unavailable' | 'error';
  /** Healthy legacy mode remains fully writable until an optional explicit upgrade. */
  protection: 'electron-safe-storage' | 'legacy-machine' | 'none';
  backend: 'keychain' | 'dpapi' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | null;
  canList: boolean;
  canApply: boolean;
  canMigrate: boolean;
  legacyBackupAvailable: boolean;
  /** A native vault is not readable by standalone Bun sharing this config dir. */
  requiresSeparateHeadlessConfig: boolean;
  /** Optional saved-connection upgrade may still need an explicit retry. */
  pendingRemoteCredentials?: boolean;
  errorCode?: NativeCredentialErrorCode;
}

export interface NativeCredentialStatusResponse {
  status: NativeCredentialVaultStatus;
  scope: NativeCredentialScope;
}

/** No secret values, fragments, suffixes, exported records or key material. */
export interface NativeCredentialMetadata {
  username?: string;
  credentialKind?: StoredCredential['credentialKind'];
  credentialUrl?: string;
  id: CredentialId;
  expiresAt?: number;
  hasValue: boolean;
  presentFields: Array<keyof StoredCredential>;
}

export interface NativeCredentialListResponse extends NativeCredentialStatusResponse {
  entries: NativeCredentialMetadata[];
  managedEntries?: NativeManagedCredentialMetadata[];
  managedEntriesUnavailable?: boolean;
}

/** Profile-managed secrets use immutable revisions, never generic row edits. */
export interface NativeManagedCredentialMetadata {
  kind: 'remote-profile' | 'remote-workspace';
  id: string;
  name: string;
  serverOrigin: string;
  profileId?: string;
  workspaceId?: string;
  fields: Array<'token' | 'sftp-password' | 'sftp-passphrase'>;
  protection: 'legacy-configuration' | 'encrypted-vault' | 'mixed';
  settingsTarget: 'remoteServers';
}

/** Omitted fields preserve existing values; null explicitly clears optional fields. */
export type NativeCredentialPatch = {
  [K in keyof StoredCredential]?: K extends 'value' ? string : StoredCredential[K] | null;
};
export type NativeCredentialChange =
  | { op: 'upsert'; id: CredentialId; credential: NativeCredentialPatch }
  | { op: 'delete'; id: CredentialId };

/** Internal post-commit notification: identifiers and field names, no values. */
export interface NativeCredentialAppliedChange {
  op: 'upsert' | 'delete';
  id: CredentialId;
  fields?: Array<keyof StoredCredential>;
}

export interface NativeCredentialApplyRequest {
  /** At most 1000 changes; duplicate IDs and unknown fields are rejected. */
  changes: NativeCredentialChange[];
}
export interface NativeCredentialApplyResponse extends NativeCredentialStatusResponse {
  upsertedCount: number;
  deletedCount: number;
  warnings?: Array<'RUNTIME_RECONCILIATION_PENDING'>;
}

export interface NativeCredentialMigrateRequest {
  acknowledgeHeadlessIncompatibility: true;
}
export interface NativeCredentialMigrateResponse extends NativeCredentialStatusResponse {
  migratedCredentialCount: number;
  backupCreated: boolean;
  migratedRemoteSecretCount?: number;
}
