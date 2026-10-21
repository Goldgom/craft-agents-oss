import type { NativeCredentialVaultStatus } from '@tokenbird/shared/credentials/native-types';

export type CredentialRecoveryChoice = 'retry' | 'reconfigure' | 'picker' | 'quit';
export interface CredentialStartupRecoveryDependencies {
  status(): Promise<NativeCredentialVaultStatus>;
  reset(): Promise<{ backupPath?: string }>;
  prompt(status: NativeCredentialVaultStatus, resetFailed: boolean): Promise<CredentialRecoveryChoice>;
  wait(ms: number): Promise<void>;
  report(event: 'unavailable' | 'reset-failed' | 'reconfigured', code?: string): void;
}

/** Run before server bootstrap, while no service can read or refresh credentials. */
export async function recoverStartupCredentials(deps: CredentialStartupRecoveryDependencies): Promise<'ready' | 'picker' | 'quit'> {
  let resetFailed = false;
  for (;;) {
    let status = await deps.status();
    // Briefly locked keychains and delayed OS crypto initialization can recover
    // without user intervention. Never interpret an unreadable vault as empty.
    for (const delay of [250, 750]) {
      if (status.state === 'ready' || status.state === 'empty') return 'ready';
      await deps.wait(delay);
      status = await deps.status();
    }
    if (status.state === 'ready' || status.state === 'empty') return 'ready';
    deps.report('unavailable', status.errorCode);
    const choice = await deps.prompt(status, resetFailed);
    if (choice === 'picker' || choice === 'quit') return choice;
    if (choice === 'retry') { resetFailed = false; continue; }
    // An unavailable OS store cannot protect a replacement vault. There is no
    // plaintext, legacy-key or stale-token fallback.
    if (status.protection !== 'electron-safe-storage'
      || !['VAULT_READ_FAILED', 'VAULT_CORRUPT'].includes(status.errorCode ?? '')) continue;
    try {
      await deps.reset();
      deps.report('reconfigured');
      return 'picker';
    } catch {
      deps.report('reset-failed');
      resetFailed = true;
    }
  }
}
