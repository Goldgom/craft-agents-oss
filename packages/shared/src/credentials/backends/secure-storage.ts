/**
 * Secure Storage Backend
 *
 * Stores credentials in an encrypted file at ~/.tokenbird/credentials.enc
 * Uses AES-256-GCM for authenticated encryption. Standalone/headless keeps the
 * legacy format below. Electron can inject an OS key protector: existing vaults
 * remain fully compatible until an explicit optional protection upgrade.
 *
 * Native format TBVAULT2 stores a random AES key wrapped by Electron safeStorage
 * beside an authenticated payload. TBROLL01 separately protects the exact old
 * encrypted bytes for main-only recovery. Neither format has a weak-key fallback.
 *
 * Legacy encryption key is derived from OS-native hardware UUID using PBKDF2:
 * - macOS: IOPlatformUUID (tied to logic board, never changes)
 * - Windows: MachineGuid from registry (set at OS install)
 * - Linux: /var/lib/dbus/machine-id (set at OS install)
 *
 * This is more stable than the previous hostname-based derivation, which could
 * change with network/DHCP. Legacy credentials are migrated on the next successful write.
 *
 * File format:
 *   [Header - 64 bytes]
 *   ├── Magic: "CRAFT01\0" (8 bytes)
 *   ├── Flags: uint32 LE (4 bytes) - reserved for future use
 *   ├── Salt: 32 bytes (PBKDF2 salt)
 *   ├── Reserved: 20 bytes
 *   [Encrypted Payload]
 *   ├── IV: 12 bytes (random per write)
 *   ├── Auth Tag: 16 bytes (GCM authentication)
 *   └── Ciphertext: variable (encrypted JSON)
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
  createHash,
} from 'crypto';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, statSync, openSync, closeSync, fsyncSync } from 'fs';
import { hostname, userInfo, homedir } from 'os';
import { join, dirname } from 'path';
import { CONFIG_DIR } from '../../config/paths.ts';

import type { CredentialBackend } from './types.ts';
import type { CredentialId, StoredCredential, CredentialWrite, CredentialSnapshot, CredentialCompareAndSet } from '../types.ts';
import { credentialIdToAccount, accountToCredentialId, validateCredentialWrites } from '../types.ts';
import type { NativeCredentialChange } from '../native-types.ts';
import { validateNativeCredentialChanges } from '../native-validation.ts';
import { CredentialVaultError, type CredentialKeyProtection } from './vault-protection.ts';

// File location
const CREDENTIALS_DIR = CONFIG_DIR;
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.enc');

// File format constants
const MAGIC_BYTES = Buffer.from('CRAFT01\0');
const NATIVE_MAGIC_BYTES = Buffer.from('TBVAULT2');
const ROLLBACK_MAGIC_BYTES = Buffer.from('TBROLL01');
const NATIVE_HEADER_SIZE = 12;
const MAX_WRAPPED_KEY_SIZE = 64 * 1024;
const HEADER_SIZE = 64;
const MAGIC_SIZE = 8;
const FLAGS_SIZE = 4;
const SALT_SIZE = 32;
const IV_SIZE = 12;
const AUTH_TAG_SIZE = 16;
const KEY_SIZE = 32;

// PBKDF2 iterations (balance security vs startup time)
const PBKDF2_ITERATIONS = 100000;
const MAX_REVISION_TOMBSTONES = 256;

/**
 * Get stable machine identifier using OS-native hardware UUID.
 * This is far more stable than hostname which can change with network/DHCP.
 * Falls back to username + homedir if hardware UUID unavailable.
 */
function getStableMachineId(): string {
  try {
    if (process.platform === 'darwin') {
      // macOS: IOPlatformUUID - tied to logic board, never changes
      const output = execSync(
        'ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match?.[1]) return match[1];
    } else if (process.platform === 'win32') {
      // Windows: MachineGuid from registry - set at OS install
      const output = execSync(
        'reg query HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (match?.[1]) return match[1];
    } else {
      // Linux: dbus machine-id - set at OS install
      const machineIdPath = '/var/lib/dbus/machine-id';
      const altPath = '/etc/machine-id';
      if (existsSync(machineIdPath)) {
        return readFileSync(machineIdPath, 'utf-8').trim();
      } else if (existsSync(altPath)) {
        return readFileSync(altPath, 'utf-8').trim();
      }
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: username + homedir (stable enough for most cases)
  return `${userInfo().username}:${homedir()}`;
}

/** Internal credential store structure */
interface CredentialStore {
  version: 1;
  credentials: Record<string, StoredCredential>;
  entryRevisions?: Record<string, string>;
  missingRevisionEpoch?: string;
  metadata: {
    createdAt: number;
    updatedAt: number;
  };
}

export class SecureStorageBackend implements CredentialBackend {
  get name(): string { return this.keyProtection ? 'electron-managed-vault' : 'secure-storage'; }
  readonly priority = 100;

  private cachedStore: CredentialStore | null = null;
  private encryptionKey: Buffer | null = null;
  private salt: Buffer | null = null;
  private cachedFileVersion: string | null = null;
  private cachedFormat: 'legacy' | 'native' | null = null;
  private nativeKey: Buffer | null = null;
  private wrappedNativeKey: Buffer | null = null;

  constructor(
    private readonly filePath: string = CREDENTIALS_FILE,
    private readonly keyProtection?: CredentialKeyProtection,
  ) {}

  /** Inspect format without treating an unreadable/native vault as empty. */
  getProtectionFormat(): 'empty' | 'legacy' | 'native' {
    if (this.fileVersion() === null) return 'empty';
    let bytes: Buffer;
    try { bytes = readFileSync(this.filePath); } catch { throw new CredentialVaultError('VAULT_READ_FAILED'); }
    if (bytes.subarray(0, MAGIC_SIZE).equals(NATIVE_MAGIC_BYTES)) return 'native';
    if (bytes.subarray(0, MAGIC_SIZE).equals(MAGIC_BYTES)) return 'legacy';
    throw new CredentialVaultError('VAULT_CORRUPT');
  }

  hasLegacyBackup(): boolean { return existsSync(`${this.filePath}.legacy-backup`); }

  /** Main-only recovery primitive. Requires OS key access; never restores or
   * downgrades the active vault automatically and is not exposed over IPC. */
  readLegacyRollbackSnapshot(): Buffer {
    if (!this.keyProtection) throw new CredentialVaultError('VAULT_NATIVE_ONLY');
    this.keyProtection.assertAvailable();
    let key: Buffer | undefined;
    try {
      const bytes = readFileSync(`${this.filePath}.legacy-backup`);
      if (bytes.length < NATIVE_HEADER_SIZE || !bytes.subarray(0, MAGIC_SIZE).equals(ROLLBACK_MAGIC_BYTES)) throw new Error('Invalid rollback envelope');
      const wrappedLength = bytes.readUInt32LE(MAGIC_SIZE);
      const headerLength = NATIVE_HEADER_SIZE + wrappedLength;
      if (!wrappedLength || wrappedLength > MAX_WRAPPED_KEY_SIZE || bytes.length <= headerLength + IV_SIZE + AUTH_TAG_SIZE) throw new Error('Invalid rollback envelope');
      key = Buffer.from(this.keyProtection.unwrapKey(bytes.subarray(NATIVE_HEADER_SIZE, headerLength)));
      if (key.length !== KEY_SIZE) throw new Error('Invalid rollback key');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(headerLength, headerLength + IV_SIZE));
      decipher.setAAD(bytes.subarray(0, headerLength));
      decipher.setAuthTag(bytes.subarray(headerLength + IV_SIZE, headerLength + IV_SIZE + AUTH_TAG_SIZE));
      const original = Buffer.concat([decipher.update(bytes.subarray(headerLength + IV_SIZE + AUTH_TAG_SIZE)), decipher.final()]);
      if (original.length < HEADER_SIZE + IV_SIZE + AUTH_TAG_SIZE || !original.subarray(0, MAGIC_SIZE).equals(MAGIC_BYTES)) throw new Error('Invalid rollback snapshot');
      return original;
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError('VAULT_READ_FAILED');
    } finally { key?.fill(0); }
  }

  private protectRollbackSnapshot(original: Buffer): Buffer {
    const protection = this.keyProtection!;
    protection.assertAvailable();
    const key = randomBytes(KEY_SIZE);
    try {
      const wrapped = protection.wrapKey(key);
      if (!Buffer.isBuffer(wrapped) || !wrapped.length || wrapped.length > MAX_WRAPPED_KEY_SIZE) throw new Error('Invalid wrapped key');
      const checked = Buffer.from(protection.unwrapKey(wrapped));
      const matches = checked.equals(key);
      checked.fill(0);
      if (!matches) throw new Error('Invalid wrapped key');
      const header = Buffer.alloc(NATIVE_HEADER_SIZE + wrapped.length);
      ROLLBACK_MAGIC_BYTES.copy(header);
      header.writeUInt32LE(wrapped.length, MAGIC_SIZE);
      wrapped.copy(header, NATIVE_HEADER_SIZE);
      const iv = randomBytes(IV_SIZE);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(header);
      const ciphertext = Buffer.concat([cipher.update(original), cipher.final()]);
      return Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]);
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError('VAULT_WRITE_FAILED');
    } finally { key.fill(0); }
  }

  private fileVersion(): string | null {
    try {
      const stat = statSync(this.filePath, { bigint: true });
      return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Cannot read the credential store');
    }
  }

  /** Serialize read/modify/write across app and server processes. Never steal a
   * lock: a crashed writer causes an explicit timeout instead of lost updates.
   * A stale .lock may be removed only after all writers are stopped.
   */
  private withWriteLock<T>(operation: () => T): T {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + 5000;
    let lock: number;
    while (true) {
      try {
        lock = openSync(lockPath, 'wx', 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Cannot lock the credential store');
        if (Date.now() >= deadline) throw new Error('Credential store is busy. If a writer crashed, stop all instances before removing the stale credential lock.');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try { return operation(); }
    finally {
      try { closeSync(lock); } catch { /* Do not turn a committed save into a false failure. */ }
      try { unlinkSync(lockPath); } catch { /* A later writer will time out rather than overwrite. */ }
    }
  }

  async isAvailable(): Promise<boolean> {
    // File backend is always available - we can always write to filesystem
    return true;
  }

  async get(id: CredentialId): Promise<StoredCredential | null> {
    const store = await this.loadStore();
    if (!store) return null;

    const key = credentialIdToAccount(id);
    return store.credentials[key] ? { ...store.credentials[key] } : null;
  }

  async getSnapshot(id: CredentialId): Promise<CredentialSnapshot> {
    const store = this.loadStoreSync();
    const account = credentialIdToAccount(id);
    return { credential: store?.credentials[account] ? { ...store.credentials[account] } : null, revision: this.revisionFor(store, account) };
  }

  private revisionFor(store: CredentialStore | null, account: string): string {
    if (store?.entryRevisions?.[account]) return store.entryRevisions[account];
    const credential = store?.credentials[account];
    // Reading an old vault never writes/migrates it. Its first mutation assigns
    // a fresh token; content-identical replacement cannot reuse this revision.
    return createHash('sha256').update(account).update('\0')
      .update(credential ? JSON.stringify(credential) : `missing:${store?.missingRevisionEpoch ?? 'legacy'}`).digest('hex');
  }

  private changedRevision(store: CredentialStore, account: string): void {
    store.entryRevisions ??= {};
    delete store.entryRevisions[account];
    store.entryRevisions[account] = randomBytes(32).toString('hex');
  }

  private trimRevisionTombstones(store: CredentialStore): void {
    const missing = Object.keys(store.entryRevisions ?? {}).filter(account => !Object.hasOwn(store.credentials, account));
    if (missing.length <= MAX_REVISION_TOMBSTONES) return;
    for (const account of missing.slice(0, missing.length - MAX_REVISION_TOMBSTONES)) delete store.entryRevisions![account];
    // Pruning cannot make an old missing-entry snapshot current again. Live
    // entries keep their exact tokens, avoiding conflicts for unrelated work.
    store.missingRevisionEpoch = randomBytes(32).toString('hex');
  }

  private mutableStore(previous: CredentialStore | null): CredentialStore {
    return {
      ...previous, version: 1, credentials: { ...previous?.credentials }, entryRevisions: { ...previous?.entryRevisions },
      metadata: { ...previous?.metadata, createdAt: previous?.metadata.createdAt ?? Date.now(), updatedAt: Date.now() },
    };
  }

  async compareAndSetMany(changes: CredentialCompareAndSet[]): Promise<boolean> {
    if (!Array.isArray(changes) || changes.length > 1000) throw new Error('Invalid credential comparison batch');
    if (!changes.length) return true;
    const seen = new Set<string>();
    for (const change of changes) {
      if (!change || typeof change.expectedRevision !== 'string' || !change.expectedRevision || change.expectedRevision.length > 256) {
        throw new Error('Invalid credential comparison revision');
      }
      validateCredentialWrites([{ id: change.id, credential: change.credential ?? { value: 'scope-validation' } }]);
      const account = credentialIdToAccount(change.id);
      if (seen.has(account)) throw new Error('Duplicate credential in comparison batch');
      seen.add(account);
    }
    const copies = changes.map(change => ({ ...change, id: { ...change.id }, credential: change.credential ? { ...change.credential } : null }));
    return this.withWriteLock(() => {
      const previous = this.loadStoreSync();
      if (copies.some(change => this.revisionFor(previous, credentialIdToAccount(change.id)) !== change.expectedRevision)) return false;
      const store = this.mutableStore(previous);
      for (const change of copies) {
        const account = credentialIdToAccount(change.id);
        if (change.credential) store.credentials[account] = change.credential;
        else delete store.credentials[account];
        this.changedRevision(store, account);
      }
      this.saveStoreSync(store);
      return true;
    });
  }

  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    await this.setMany([{ id, credential }]);
  }

  /** One synchronous read/modify/atomic-replace, with no await between steps.
   * Prevents overlapping writes from losing entries, including fresh stores.
   * All entries are validated before touching the file or the cached snapshot.
   */
  async setMany(entries: CredentialWrite[]): Promise<void> {
    validateCredentialWrites(entries);
    if (!entries.length) return;
    // Use an independent validated snapshot for the transaction.
    const writes = entries.map(({ id, credential }) => ({ id: { ...id }, credential: { ...credential } }));
    this.withWriteLock(() => {
      const previous = this.loadStoreSync();
      const store = this.mutableStore(previous);
      for (const { id, credential } of writes) {
        const account = credentialIdToAccount(id);
        store.credentials[account] = { ...credential };
        this.changedRevision(store, account);
      }
      this.saveStoreSync(store);
    });
  }

  async applyChanges(changes: NativeCredentialChange[]): Promise<{ upsertedCount: number; deletedCount: number }> {
    const validated = validateNativeCredentialChanges(changes);
    return this.withWriteLock(() => {
      const previous = this.loadStoreSync();
      const store = this.mutableStore(previous);
      let upsertedCount = 0;
      let deletedCount = 0;
      for (const change of validated) {
        const account = credentialIdToAccount(change.id);
        if (change.op === 'delete') {
          if (Object.hasOwn(store.credentials, account)) { delete store.credentials[account]; deletedCount++; }
          this.changedRevision(store, account);
          continue;
        }
        const merged = { ...store.credentials[account] } as StoredCredential;
        for (const [field, value] of Object.entries(change.credential)) {
          if (value === null) delete (merged as unknown as Record<string, unknown>)[field];
          else (merged as unknown as Record<string, unknown>)[field] = value;
        }
        // Validate every final value before a single write is committed.
        if (typeof merged.value !== 'string' || !merged.value.trim()) throw new CredentialVaultError('INVALID_REQUEST');
        store.credentials[account] = merged;
        this.changedRevision(store, account);
        upsertedCount++;
      }
      this.saveStoreSync(store);
      return { upsertedCount, deletedCount };
    });
  }

  /** Explicit optional upgrade. Legacy reads/writes never migrate implicitly. */
  async migrateToProtectedStorage(): Promise<{ migratedCredentialCount: number; backupCreated: boolean }> {
    if (!this.keyProtection) throw new CredentialVaultError('OS_STORAGE_UNAVAILABLE');
    this.keyProtection.assertAvailable();
    return this.withWriteLock(() => {
      const previous = this.loadStoreSync();
      if (this.cachedFormat === 'native') return { migratedCredentialCount: 0, backupCreated: false };
      const store: CredentialStore = previous ?? { version: 1, credentials: {}, metadata: { createdAt: Date.now(), updatedAt: Date.now() } };
      let backupCreated = false;
      if (this.cachedFormat === 'legacy') {
        // Preserve the exact original encrypted bytes inside an OS-protected
        // envelope. Do not leave a weaker machine-ID-only duplicate behind.
        // A retry replaces it atomically to retain intervening token refreshes.
        const original = readFileSync(this.filePath);
        backupCreated = !this.hasLegacyBackup();
        this.persistFileSync(`${this.filePath}.legacy-backup`, this.protectRollbackSnapshot(original), true);
      }
      // The only format switch is the final atomic rename. Any earlier failure
      // leaves the active legacy vault, including normal refresh writes, usable.
      this.saveStoreSync(store, true);
      return { migratedCredentialCount: Object.keys(store.credentials).length, backupCreated };
    });
  }

  async delete(id: CredentialId): Promise<boolean> {
    return this.deleteSync(id);
  }

  deleteSync(id: CredentialId): boolean {
    return this.withWriteLock(() => {
      const previous = this.loadStoreSync();
      if (!previous) return false;
      const store = this.mutableStore(previous);

      const key = credentialIdToAccount(id);
      if (!(key in store.credentials)) return false;

      delete store.credentials[key];
      this.changedRevision(store, key);
      store.metadata.updatedAt = Date.now();

      this.saveStoreSync(store);
      return true;
    });
  }

  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    const store = await this.loadStore();
    if (!store) return [];

    const ids = Object.keys(store.credentials)
      .map(accountToCredentialId)
      .filter((id): id is CredentialId => id !== null);

    if (!filter) return ids;

    return ids.filter((id) => {
      if (filter.type && id.type !== filter.type) return false;
      if (filter.workspaceId && id.workspaceId !== filter.workspaceId) return false;
      if (filter.name && id.name !== filter.name) return false;
      if (filter.sourceId && id.sourceId !== filter.sourceId) return false;
      if (filter.connectionSlug && id.connectionSlug !== filter.connectionSlug) return false;
      return true;
    });
  }

  // ============================================================
  // Private Methods
  // ============================================================

  private async loadStore(): Promise<CredentialStore | null> {
    return this.loadStoreSync();
  }

  private loadStoreSync(): CredentialStore | null {
    // Atomic replacement changes the inode/version. Observe saves made by other
    // manager instances/processes, while keeping the normal read path cheap.
    const version = this.fileVersion();
    if (this.cachedStore && version === this.cachedFileVersion) {
      if (this.cachedFormat === 'native') this.keyProtection?.assertAvailable();
      return this.cachedStore;
    }
    this.clearCache();
    if (version === null) return null;

    let fileData: Buffer;
    try {
      fileData = readFileSync(this.filePath);
    } catch {
      throw new Error('Cannot read the credential store');
    }

    if (fileData.subarray(0, MAGIC_SIZE).equals(ROLLBACK_MAGIC_BYTES)) throw new CredentialVaultError('VAULT_NATIVE_ONLY');

    if (fileData.subarray(0, MAGIC_SIZE).equals(NATIVE_MAGIC_BYTES)) {
      if (!this.keyProtection) throw new CredentialVaultError('VAULT_NATIVE_ONLY');
      this.keyProtection.assertAvailable();
      if (fileData.length < NATIVE_HEADER_SIZE + IV_SIZE + AUTH_TAG_SIZE) throw new CredentialVaultError('VAULT_CORRUPT');
      const wrappedLength = fileData.readUInt32LE(MAGIC_SIZE);
      const headerLength = NATIVE_HEADER_SIZE + wrappedLength;
      if (!wrappedLength || wrappedLength > MAX_WRAPPED_KEY_SIZE || fileData.length <= headerLength + IV_SIZE + AUTH_TAG_SIZE) {
        throw new CredentialVaultError('VAULT_CORRUPT');
      }
      const wrapped = fileData.subarray(NATIVE_HEADER_SIZE, headerLength);
      let key: Buffer;
      try { key = Buffer.from(this.keyProtection.unwrapKey(wrapped)); } catch (error) {
        if (error instanceof CredentialVaultError) throw error;
        throw new CredentialVaultError('VAULT_READ_FAILED');
      }
      if (!Buffer.isBuffer(key) || key.length !== KEY_SIZE) throw new CredentialVaultError('VAULT_CORRUPT');
      const store = this.tryDecrypt(fileData.subarray(headerLength), key, fileData.subarray(0, headerLength));
      if (!store) { key.fill(0); throw new CredentialVaultError('VAULT_CORRUPT'); }
      this.nativeKey = key;
      this.wrappedNativeKey = Buffer.from(wrapped);
      this.cachedFormat = 'native';
      this.cachedStore = store;
      this.cachedFileVersion = version;
      return store;
    }

    // Validate minimum size
    if (fileData.length < HEADER_SIZE + IV_SIZE + AUTH_TAG_SIZE) {
      throw new Error('Credential store is corrupted; original file preserved');
    }

    // Validate magic bytes
    if (!fileData.subarray(0, MAGIC_SIZE).equals(MAGIC_BYTES)) {
      throw new Error('Credential store is corrupted; original file preserved');
    }

    // Parse header
    // const flags = fileData.readUInt32LE(MAGIC_SIZE); // Reserved for future use
    const salt = fileData.subarray(MAGIC_SIZE + FLAGS_SIZE, MAGIC_SIZE + FLAGS_SIZE + SALT_SIZE);
    this.salt = salt;

    // Extract encrypted data
    const encryptedData = fileData.subarray(HEADER_SIZE);

    // Try new stable key first (v2 - hardware UUID based)
    const newKey = this.getEncryptionKey(salt);
    let store = this.tryDecrypt(encryptedData, newKey);

    if (store) {
      this.cachedFormat = 'legacy';
      this.cachedStore = store;
      this.cachedFileVersion = version;
      return store;
    }

    // Try legacy key for migration (v1 - included hostname)
    // This handles credentials encrypted with old key derivation
    const legacyKey = this.getLegacyEncryptionKey(salt);
    store = this.tryDecrypt(encryptedData, legacyKey);

    if (store) {
      // Migrate on the next locked write. A read must not race another writer.
      this.cachedFormat = 'legacy';
      this.cachedStore = store;
      this.cachedFileVersion = version;
      return store;
    }

    // Never silently destroy an unreadable vault or overwrite it with a new one.
    throw new Error('Cannot decrypt credential store; original file preserved');
  }

  /**
   * Attempt to decrypt data with given key.
   * Returns parsed store on success, null on failure.
   */
  private tryDecrypt(encryptedData: Buffer, key: Buffer, additionalData?: Buffer): CredentialStore | null {
    try {
      const iv = encryptedData.subarray(0, IV_SIZE);
      const authTag = encryptedData.subarray(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE);
      const ciphertext = encryptedData.subarray(IV_SIZE + AUTH_TAG_SIZE);

      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      if (additionalData) decipher.setAAD(additionalData);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const store = JSON.parse(decrypted.toString('utf8')) as CredentialStore;
      if (store.version !== 1 || !store.credentials || typeof store.credentials !== 'object'
        || Array.isArray(store.credentials) || !store.metadata
        || !Number.isFinite(store.metadata.createdAt) || !Number.isFinite(store.metadata.updatedAt)) return null;
      // Authenticated JSON can still have a malformed schema. Do not expose
      // bogus credentials or rewrite a damaged vault on the next valid save.
      // Preserve unknown fields/accounts and legacy empty-string values.
      if (Object.values(store.credentials).some(credential => !credential || typeof credential !== 'object'
        || Array.isArray(credential) || typeof credential.value !== 'string')) return null;
      if (store.entryRevisions !== undefined && (!store.entryRevisions || typeof store.entryRevisions !== 'object'
        || Array.isArray(store.entryRevisions) || Object.values(store.entryRevisions).some(value => typeof value !== 'string' || !value || value.length > 256))) return null;
      if (store.missingRevisionEpoch !== undefined && (typeof store.missingRevisionEpoch !== 'string' || !store.missingRevisionEpoch)) return null;
      return store;
    } catch {
      return null;
    }
  }

  private saveStoreSync(store: CredentialStore, forceProtected = false): void {
    this.trimRevisionTombstones(store);
    // Ensure directory exists
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });

    // Existing legacy vaults keep their complete read/write/refresh behavior.
    // Only an explicit upgrade (or the first save to an empty vault) opts in.
    if (this.keyProtection && (forceProtected || this.cachedFormat !== 'legacy')) {
      this.saveProtectedStoreSync(store);
      return;
    }

    // Use existing salt or generate new one
    const salt = this.salt || randomBytes(SALT_SIZE);
    this.salt = salt;

    // Get encryption key
    const key = this.getEncryptionKey(salt);

    // Serialize payload
    const plaintext = Buffer.from(JSON.stringify(store), 'utf8');

    // Generate new IV for each write (critical for GCM security)
    const iv = randomBytes(IV_SIZE);

    // Encrypt
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Build header
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC_BYTES.copy(header, 0);
    header.writeUInt32LE(0, MAGIC_SIZE); // Flags (reserved)
    salt.copy(header, MAGIC_SIZE + FLAGS_SIZE);

    // Combine all parts
    const fileData = Buffer.concat([header, iv, authTag, ciphertext]);

    this.persistFileSync(this.filePath, fileData);
    this.cachedStore = store;
    this.cachedFormat = 'legacy';
    // Do not fail after the durable commit merely because a later stat fails.
    try { this.cachedFileVersion = this.fileVersion(); } catch { this.clearCache(); }
  }

  private saveProtectedStoreSync(store: CredentialStore): void {
    const protection = this.keyProtection!;
    protection.assertAvailable();
    const key = this.nativeKey ?? randomBytes(KEY_SIZE);
    let wrapped: Buffer;
    try {
      wrapped = this.wrappedNativeKey ?? protection.wrapKey(key);
      if (!Buffer.isBuffer(wrapped) || !wrapped.length || wrapped.length > MAX_WRAPPED_KEY_SIZE) throw new Error('Invalid wrapped key');
      // Validate a newly wrapped key before commit. A cached native key was
      // already authenticated when loaded/created; do not prompt the OS key
      // store again on every normal OAuth refresh write.
      if (!this.wrappedNativeKey) {
        const checkedKey = Buffer.from(protection.unwrapKey(wrapped));
        const matches = checkedKey.length === KEY_SIZE && checkedKey.equals(key);
        checkedKey.fill(0);
        if (!matches) throw new Error('Invalid wrapped key');
      }
    } catch (error) {
      if (!this.nativeKey) key.fill(0);
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError('VAULT_WRITE_FAILED');
    }
    const header = Buffer.alloc(NATIVE_HEADER_SIZE + wrapped.length);
    NATIVE_MAGIC_BYTES.copy(header);
    header.writeUInt32LE(wrapped.length, MAGIC_SIZE);
    wrapped.copy(header, NATIVE_HEADER_SIZE);
    const iv = randomBytes(IV_SIZE);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(header);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(store), 'utf8'), cipher.final()]);
    const fileData = Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]);
    try { this.persistFileSync(this.filePath, fileData); }
    catch (error) { if (!this.nativeKey) key.fill(0); throw error; }
    this.nativeKey = key;
    this.wrappedNativeKey = Buffer.from(wrapped);
    this.cachedStore = store;
    this.cachedFormat = 'native';
    // The commit already happened; a later directory flush failure must not
    // masquerade as an uncommitted save and cause an unsafe caller retry.
    try { this.flushDirectorySync(); } catch { /* The encrypted backup is durable. */ }
    try { this.cachedFileVersion = this.fileVersion(); } catch { this.clearCache(); }
  }

  private flushDirectorySync(): void {
    // Windows does not expose the POSIX directory-fsync operation.
    if (process.platform === 'win32') return;
    const directory = openSync(dirname(this.filePath), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }

  private persistFileSync(targetPath: string, fileData: Buffer, requireDirectoryFlush = false): void {
    // Commit via a restrictive, exclusive sibling file. A failed write/rename
    // leaves both the existing encrypted file and cached credentials unchanged.
    const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(fd, fileData);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporaryPath, targetPath);
      // For migration, make the rollback directory entry durable before the
      // active vault can switch formats. A failure here leaves it unchanged.
      if (requireDirectoryFlush) this.flushDirectorySync();
    } catch {
      throw new Error('Could not save credentials; existing credentials are unchanged');
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporaryPath); } catch { /* Already committed or not created. */ }
    }
  }

  private getEncryptionKey(salt: Buffer): Buffer {
    if (this.encryptionKey) return this.encryptionKey;

    // New stable machine ID using hardware UUID (v2)
    // This is far more stable than hostname which can change with network/DHCP
    const stableMachineId = createHash('sha256')
      .update(getStableMachineId())
      .update('craft-agent-v2') // Bumped version for new key derivation
      .digest();

    // Derive key using PBKDF2
    this.encryptionKey = pbkdf2Sync(stableMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');

    return this.encryptionKey;
  }

  /**
   * Legacy key derivation for migration from v1 (included hostname).
   * Used to decrypt credentials from older versions before re-encrypting with stable key.
   */
  private getLegacyEncryptionKey(salt: Buffer): Buffer {
    const legacyMachineId = createHash('sha256')
      .update(hostname())
      .update(userInfo().username)
      .update(homedir())
      .update('craft-agent-v1')
      .digest();

    return pbkdf2Sync(legacyMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');
  }

  /** Clear cached data (for testing or forced refresh) */
  clearCache(): void {
    this.cachedStore = null;
    this.cachedFileVersion = null;
    this.encryptionKey = null;
    this.salt = null;
    this.cachedFormat = null;
    this.nativeKey?.fill(0);
    this.nativeKey = null;
    this.wrappedNativeKey = null;
  }
}
