import type { NativeCredentialErrorCode } from '../native-types.ts';

/** Injected by Electron main. Shared/headless code never imports Electron. */
export interface CredentialKeyProtection {
  assertAvailable(): void;
  wrapKey(key: Buffer): Buffer;
  unwrapKey(wrapped: Buffer): Buffer;
}

const MESSAGES: Record<NativeCredentialErrorCode, string> = {
  UNTRUSTED_SENDER: 'A trusted local desktop window is required.',
  INVALID_REQUEST: 'The credential request is invalid.',
  SCOPE_NOT_ALLOWED: 'This credential scope is not available in this window.',
  OS_STORAGE_UNAVAILABLE: 'The operating system credential store is unavailable. Existing credential data has been preserved.',
  OS_STORAGE_INSECURE: 'No secure operating system credential store is configured. Existing credential data has been preserved.',
  VAULT_NATIVE_ONLY: 'This vault is protected by Electron. Open it in TokenBird, or use a separate TOKENBIRD_CONFIG_DIR for standalone Bun.',
  PROTECTION_UPGRADE_FAILED: 'Credential protection could not be upgraded. The existing credential vault is unchanged.',
  REMOTE_MIGRATION_INCOMPLETE: 'Saved connection protection is incomplete. Existing credentials remain usable; retry the optional upgrade.',
  VAULT_CORRUPT: 'The credential vault cannot be read. Its original data has been preserved.',
  VAULT_LOCKED: 'The credential vault is busy. Retry after other writers finish.',
  VAULT_READ_FAILED: 'The credential vault could not be read. Its original data has been preserved.',
  VAULT_WRITE_FAILED: 'Credentials could not be saved. Existing credentials are unchanged.',
};

/** Only fixed diagnostics cross the credential boundary; never attach a cause. */
export class CredentialVaultError extends Error {
  constructor(readonly code: NativeCredentialErrorCode) {
    super(MESSAGES[code]);
    this.name = 'CredentialVaultError';
  }
}
