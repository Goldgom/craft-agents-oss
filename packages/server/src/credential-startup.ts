import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SecureStorageBackend } from '@tokenbird/shared/credentials/backends/secure-storage'
import { CredentialVaultError } from '@tokenbird/shared/credentials/backends/vault-protection'
import type { NativeCredentialErrorCode } from '@tokenbird/shared/credentials/native-types'

export interface ServerCredentialDiagnostic {
  event: 'ready' | 'retrying' | 'recovered' | 'blocked'
  attempt: number
  code?: NativeCredentialErrorCode
}

export class ServerCredentialStartupError extends Error {
  constructor(readonly code: NativeCredentialErrorCode) {
    super(code === 'VAULT_NATIVE_ONLY'
      ? 'Server credential check failed (VAULT_NATIVE_ONLY). This vault requires Electron OS protection. Use the original TokenBird desktop to read it, or set a separate TOKENBIRD_CONFIG_DIR for the server and configure its credentials. The original vault was preserved.'
      : `Server credential check failed (${code}) after automatic retries. No credentials were deleted or replaced. Check config-directory permissions and the original machine identity, or restore a verified backup while the server is stopped. See logs/credential-startup.log in TOKENBIRD_CONFIG_DIR.`)
    this.name = 'ServerCredentialStartupError'
  }
}

/** Check real decryption before creating services, without migrating or writing
 * credential data. Each retry uses a fresh backend so a transient machine-ID
 * lookup failure cannot leave an incorrect derived key cached for the launch.
 */
export async function checkServerStartupCredentials(options: {
  filePath?: string
  backendFactory?: () => SecureStorageBackend
  wait?: (ms: number) => Promise<void>
  report?: (diagnostic: ServerCredentialDiagnostic) => void
} = {}): Promise<SecureStorageBackend> {
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const report = (diagnostic: ServerCredentialDiagnostic) => {
    try { options.report?.(diagnostic) } catch { /* Diagnostics must not affect recovery. */ }
  }
  const delays = [250, 1000, 2500]
  for (let attempt = 1; ; attempt++) {
    let code: NativeCredentialErrorCode
    try {
      const backend = options.backendFactory?.() ?? new SecureStorageBackend(options.filePath)
      backend.getProtectionFormat()
      await backend.list()
      report({ event: attempt === 1 ? 'ready' : 'recovered', attempt })
      return backend
    } catch (error) {
      code = error instanceof CredentialVaultError ? error.code : 'VAULT_READ_FAILED'
    }
    // A standalone Bun server cannot unwrap an Electron vault. Repeating that
    // operation, restoring stale secrets or auto-resetting it cannot repair it.
    const delay = delays[attempt - 1]
    if (code === 'VAULT_NATIVE_ONLY' || delay === undefined) {
      report({ event: 'blocked', attempt, code })
      throw new ServerCredentialStartupError(code)
    }
    report({ event: 'retrying', attempt, code })
    await wait(delay)
  }
}

/** Also available in production, where desktop debug logging is disabled. */
export function logServerCredentialDiagnostic(configDir: string, diagnostic: ServerCredentialDiagnostic): void {
  const directory = join(configDir, 'logs')
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    appendFileSync(join(directory, 'credential-startup.log'), JSON.stringify({
      timestamp: new Date().toISOString(), ...diagnostic,
    }) + '\n', { mode: 0o600 })
  } catch { /* A read-only logs directory must not prevent an otherwise healthy start. */ }
  console.log(`[credentials] startup ${diagnostic.event}; attempt=${diagnostic.attempt}${diagnostic.code ? `; code=${diagnostic.code}` : ''}`)
}
