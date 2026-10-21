import { getWorkspaces } from '@tokenbird/shared/config';
import { getCredentialManager, type CredentialManager } from '@tokenbird/shared/credentials';
import { SecureStorageBackend } from '@tokenbird/shared/credentials/backends/secure-storage';
import { CredentialVaultError } from '@tokenbird/shared/credentials/backends/vault-protection';
import { NATIVE_CREDENTIAL_FIELDS, type NativeCredentialMetadata, type NativeCredentialVaultStatus } from '@tokenbird/shared/credentials/native-types';
import { validateNativeCredentialId } from '@tokenbird/shared/credentials/native-validation';
import { sourceCredentialWorkspaceId, workspaceForSourceCredentialId } from '@tokenbird/shared/credentials/workspace-scope';
import { reconcileSourceCredentialChanges } from '@tokenbird/shared/sources/credential-runtime';
import type { RemoteCredentialHost } from '@tokenbird/server-core/handlers/rpc/credentials';
import type { SessionManager } from '@tokenbird/server-core/sessions';

/** Standalone storage uses the existing machine-bound AES vault, without Electron. */
export function createHeadlessCredentialHost(sessionManager: Pick<SessionManager, 'notifyStoredCredentialChanges' | 'reloadMcpServers'>, options: {
  backend?: SecureStorageBackend;
  manager?: CredentialManager;
  workspaces?: typeof getWorkspaces;
} = {}): RemoteCredentialHost {
  const backend = options.backend ?? new SecureStorageBackend();
  const manager = options.manager ?? getCredentialManager();
  const workspaces = options.workspaces ?? getWorkspaces;
  manager.configureBackend(backend);
  return {
    accessPolicy: 'authenticated-connection',
    scope(workspaceId) {
      const registered = workspaces();
      if (!registered.some(workspace => workspace.id === workspaceId && !workspace.remoteServer)) return null;
      const sourceWorkspaceId = sourceCredentialWorkspaceId(workspaceId, registered);
      return { workspaceId, sourceWorkspaceId, sourceScopeUnavailable: sourceWorkspaceId === null, includesGlobal: true, includesLlm: true };
    },
    async status(): Promise<NativeCredentialVaultStatus> {
      let format: 'empty' | 'legacy' | 'native' = 'empty';
      const base = { backend: null, canMigrate: false, legacyBackupAvailable: backend.hasLegacyBackup() };
      try {
        format = backend.getProtectionFormat();
        await backend.list();
        return { ...base, state: format === 'empty' ? 'empty' : 'ready', protection: format === 'empty' ? 'none' : 'legacy-machine', canList: true, canApply: true, requiresSeparateHeadlessConfig: false };
      } catch (error) {
        return { ...base, state: 'error', protection: format === 'native' ? 'electron-safe-storage' : format === 'legacy' ? 'legacy-machine' : 'none',
          canList: false, canApply: false, requiresSeparateHeadlessConfig: format === 'native', errorCode: error instanceof CredentialVaultError ? error.code : 'VAULT_READ_FAILED' };
      }
    },
    async listMetadata() {
      const entries: NativeCredentialMetadata[] = [];
      for (const id of await backend.list()) {
        try { validateNativeCredentialId(id); } catch { continue; }
        const credential = await backend.get(id);
        if (!credential) continue;
        entries.push({ id,
          ...(id.type === 'saved_credential' ? { username: credential.username, credentialKind: credential.credentialKind, credentialUrl: credential.credentialUrl } : {}),
          ...(typeof credential.expiresAt === 'number' && Number.isFinite(credential.expiresAt) ? { expiresAt: credential.expiresAt } : {}),
          hasValue: !!credential.value, presentFields: NATIVE_CREDENTIAL_FIELDS.filter(field => credential[field] !== undefined) });
      }
      return entries;
    },
    apply: changes => manager.applyChanges(changes),
    async onApplied(changes) {
      const applied = changes.map(change => ({ op: change.op, id: change.id,
        ...(change.op === 'upsert' ? { fields: Object.keys(change.credential) as NativeCredentialMetadata['presentFields'] } : {}) }));
      const notified = await sessionManager.notifyStoredCredentialChanges(applied);
      const reconciled = await reconcileSourceCredentialChanges(applied, id => workspaceForSourceCredentialId(id, workspaces()));
      const reloads = await Promise.allSettled(reconciled.workspaceIds.map(id => sessionManager.reloadMcpServers(id)));
      if (reconciled.failed || notified.sessionIdsNeedingRestart.length || reloads.some(result => result.status === 'rejected' || result.value.failures.length)) throw new Error('Runtime reconciliation pending');
    },
    // Compatibility for callers requesting approval explicitly. The RPC layer
    // uses verified authentication directly and rechecks workspace scope per call.
    approve: async request => Date.now() < request.expiresAt && (request.authenticatedBy === 'bearer' || request.authenticatedBy === 'cookie'),
  };
}
