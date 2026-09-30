import { getCredentialManager, type CredentialManager } from '@craft-agent/shared/credentials';
import { SecureStorageBackend } from '@craft-agent/shared/credentials/backends/secure-storage';
import { CredentialVaultError, type CredentialKeyProtection } from '@craft-agent/shared/credentials/backends/vault-protection';
import { NATIVE_CREDENTIAL_FIELDS, type NativeCredentialChange, type NativeCredentialMetadata, type NativeCredentialVaultStatus, type NativeManagedCredentialMetadata } from '@craft-agent/shared/credentials/native-types';
import { validateNativeCredentialId } from '@craft-agent/shared/credentials/native-validation';

/** Pinned Electron exposes the synchronous API; only main supplies this adapter. */
export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend(): string;
}

type BackendName = NativeCredentialVaultStatus['backend'];

export interface RemoteCredentialMigrationHooks {
  hasPending(): boolean;
  listMetadata(): Promise<NativeManagedCredentialMetadata[]>;
  migrate(): Promise<{ migratedSecretCount: number }>;
}

export function createElectronKeyProtection(safeStorage: SafeStorageAdapter, platform = process.platform): CredentialKeyProtection & { backendName(): BackendName } {
  const backendName = (): BackendName => {
    try {
      if (platform === 'darwin') return 'keychain';
      if (platform === 'win32') return 'dpapi';
      const selected = safeStorage.getSelectedStorageBackend();
      return ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(selected) ? selected as BackendName : null;
    } catch { return null; }
  };
  const assertAvailable = () => {
    try {
      if (platform === 'linux') {
        const selected = safeStorage.getSelectedStorageBackend();
        if (selected === 'basic_text') throw new CredentialVaultError('OS_STORAGE_INSECURE');
        if (!backendName()) throw new CredentialVaultError('OS_STORAGE_UNAVAILABLE');
      }
      if (!safeStorage.isEncryptionAvailable()) throw new CredentialVaultError('OS_STORAGE_UNAVAILABLE');
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError('OS_STORAGE_UNAVAILABLE');
    }
  };
  return {
    backendName,
    assertAvailable,
    wrapKey(key) {
      assertAvailable();
      try {
        if (key.length !== 32) throw new Error('Invalid key');
        return safeStorage.encryptString(key.toString('base64'));
      } catch { throw new CredentialVaultError('VAULT_WRITE_FAILED'); }
    },
    unwrapKey(wrapped) {
      assertAvailable();
      try {
        const encoded = safeStorage.decryptString(wrapped);
        const key = Buffer.from(encoded, 'base64');
        if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('Invalid key');
        return key;
      } catch { throw new CredentialVaultError('VAULT_READ_FAILED'); }
    },
  };
}

export class ElectronCredentialVault {
  readonly backend: SecureStorageBackend;
  private readonly protection: ReturnType<typeof createElectronKeyProtection>;
  private readonly remoteMigration?: RemoteCredentialMigrationHooks;

  constructor(options: { safeStorage: SafeStorageAdapter; platform?: NodeJS.Platform; filePath?: string; remoteMigration?: RemoteCredentialMigrationHooks }) {
    this.protection = createElectronKeyProtection(options.safeStorage, options.platform);
    this.backend = new SecureStorageBackend(options.filePath, this.protection);
    this.remoteMigration = options.remoteMigration;
  }

  async status(): Promise<NativeCredentialVaultStatus> {
    let format: 'empty' | 'legacy' | 'native' = 'empty';
    let pendingRemoteCredentials = false;
    // A broken optional profile registry must never disable core LLM storage.
    try { pendingRemoteCredentials = this.remoteMigration?.hasPending() ?? false; }
    catch { pendingRemoteCredentials = true; }
    const base = {
      backend: this.protection.backendName(),
      legacyBackupAvailable: this.backend.hasLegacyBackup(),
      requiresSeparateHeadlessConfig: false,
      ...(pendingRemoteCredentials ? { pendingRemoteCredentials: true } : {}),
    };
    try {
      format = this.backend.getProtectionFormat();
      await this.backend.list(); // Validate the actual vault, not just its header.
      let osError: CredentialVaultError | undefined;
      try { this.protection.assertAvailable(); }
      catch (error) { osError = error as CredentialVaultError; }
      // Stability first: optional protection never disables legacy LLM use,
      // saves, deletes, or OAuth refresh persistence on an existing install.
      if (format === 'legacy') return {
        ...base, state: 'ready', protection: 'legacy-machine', canList: true, canApply: true,
        canMigrate: !osError, ...(osError ? { errorCode: osError.code } : {}),
      };
      if (osError) throw osError;
      return {
        ...base, state: format === 'empty' ? 'empty' : 'ready', protection: format === 'empty' ? 'none' : 'electron-safe-storage',
        canList: true, canApply: true, canMigrate: pendingRemoteCredentials, requiresSeparateHeadlessConfig: format === 'native',
      };
    } catch (error) {
      const code = error instanceof CredentialVaultError ? error.code : 'VAULT_READ_FAILED';
      return {
        ...base, state: code === 'OS_STORAGE_UNAVAILABLE' || code === 'OS_STORAGE_INSECURE' ? 'unavailable' : 'error',
        protection: format === 'native' ? 'electron-safe-storage' : format === 'legacy' ? 'legacy-machine' : 'none',
        canList: false, canApply: false, canMigrate: false, requiresSeparateHeadlessConfig: format === 'native', errorCode: code,
      };
    }
  }

  async listMetadata(): Promise<NativeCredentialMetadata[]> {
    const entries: NativeCredentialMetadata[] = [];
    for (const id of await this.backend.list()) {
      // Preserve unknown legacy accounts in storage, but never let an alias or
      // malformed identifier bypass native scope validation.
      try { validateNativeCredentialId(id); } catch { continue; }
      const credential = await this.backend.get(id);
      if (!credential) continue;
      entries.push({
        id,
        ...(typeof credential.expiresAt === 'number' && Number.isFinite(credential.expiresAt) ? { expiresAt: credential.expiresAt } : {}),
        hasValue: !!credential.value,
        presentFields: NATIVE_CREDENTIAL_FIELDS.filter(field => credential[field] !== undefined),
      });
    }
    return entries;
  }

  apply(changes: NativeCredentialChange[]) { return this.backend.applyChanges(changes); }

  /** Main-only recovery helper. The caller must explicitly choose a recovery
   * destination; this never modifies active credentials or exposes IPC data. */
  readLegacyRollbackSnapshot(): Buffer { return this.backend.readLegacyRollbackSnapshot(); }

  async listManagedMetadata(): Promise<{ managedEntries: NativeManagedCredentialMetadata[]; managedEntriesUnavailable?: boolean }> {
    if (!this.remoteMigration) return { managedEntries: [] };
    try {
      return { managedEntries: (await this.remoteMigration.listMetadata()).map(entry => ({
        kind: entry.kind, id: entry.id, name: entry.name,
        // Even a buggy metadata producer cannot forward URL userinfo, paths,
        // query credentials, or unrecognized record/secret properties.
        serverOrigin: new URL(entry.serverOrigin).origin,
        ...(entry.profileId ? { profileId: entry.profileId } : {}),
        ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
        fields: entry.fields.filter(field => ['token', 'sftp-password', 'sftp-passphrase'].includes(field)),
        protection: entry.protection, settingsTarget: 'remoteServers',
      })) };
    } catch { return { managedEntries: [], managedEntriesUnavailable: true }; }
  }

  async migrate() {
    this.protection.assertAvailable();
    let migratedRemoteSecretCount = 0;
    // Stage/publish connection refs in the existing encrypted vault first.
    // If native wrapping subsequently fails, those refs and LLM refreshes
    // remain usable in legacy mode. Nothing invokes this hook on launch.
    if (this.remoteMigration) {
      try { migratedRemoteSecretCount = (await this.remoteMigration.migrate()).migratedSecretCount; }
      catch { throw new CredentialVaultError('REMOTE_MIGRATION_INCOMPLETE'); }
    }
    try {
      const result = await this.backend.migrateToProtectedStorage();
      return { ...result, migratedCredentialCount: result.migratedCredentialCount || migratedRemoteSecretCount,
        ...(this.remoteMigration ? { migratedRemoteSecretCount } : {}) };
    }
    catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError('PROTECTION_UPGRADE_FAILED');
    }
  }
}

/** Call after app.ready and before bootstrapping services. Never auto-migrates. */
export function configureElectronCredentialVault(options: {
  safeStorage: SafeStorageAdapter;
  platform?: NodeJS.Platform;
  filePath?: string;
  manager?: CredentialManager;
  remoteMigration?: RemoteCredentialMigrationHooks;
}): ElectronCredentialVault {
  const vault = new ElectronCredentialVault(options);
  (options.manager ?? getCredentialManager()).configureBackend(vault.backend);
  return vault;
}
