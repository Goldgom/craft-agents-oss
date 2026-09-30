/**
 * Credential Backend Interface
 *
 * All credential storage backends must implement this interface.
 * Backends are tried in priority order until one succeeds.
 */

import type { CredentialId, StoredCredential, CredentialWrite, CredentialSnapshot, CredentialCompareAndSet } from '../types.ts';
import type { NativeCredentialChange } from '../native-types.ts';

export interface CredentialBackend {
  /** Backend name for logging/debugging */
  readonly name: string;

  /** Priority (higher = tried first) */
  readonly priority: number;

  /** Check if this backend is available on the current platform */
  isAvailable(): Promise<boolean>;

  /** Get a credential by ID */
  get(id: CredentialId): Promise<StoredCredential | null>;
  getSnapshot?(id: CredentialId): Promise<CredentialSnapshot>;
  compareAndSetMany?(changes: CredentialCompareAndSet[]): Promise<boolean>;

  /** Set/update a credential */
  set(id: CredentialId, credential: StoredCredential): Promise<void>;

  /** Atomically save all entries, when supported. Must never partially commit. */
  setMany?(entries: CredentialWrite[]): Promise<void>;

  /** Atomically merge write-only replacements and deletes. */
  applyChanges?(changes: NativeCredentialChange[]): Promise<{ upsertedCount: number; deletedCount: number }>;

  /** Delete a credential */
  delete(id: CredentialId): Promise<boolean>;

  /** Delete a credential synchronously, when supported by the backend. */
  deleteSync?(id: CredentialId): boolean;

  /** List all credentials (optionally filtered by partial ID) */
  list(filter?: Partial<CredentialId>): Promise<CredentialId[]>;
}
