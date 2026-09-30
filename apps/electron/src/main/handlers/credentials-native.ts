import { NATIVE_CREDENTIAL_IPC, type NativeCredentialResult, type NativeCredentialScope, type NativeCredentialAppliedChange } from '@craft-agent/shared/credentials/native-types';
import { validateNativeCredentialChanges } from '@craft-agent/shared/credentials/native-validation';
import { CredentialVaultError } from '@craft-agent/shared/credentials/backends/vault-protection';
import type { CredentialId } from '@craft-agent/shared/credentials';
import type { ElectronCredentialVault } from '../credential-vault';
import type { NativeAuthorityEvent } from '../native-window-authority';

export interface CredentialIpcRegistrar {
  handle(channel: string, listener: (event: NativeAuthorityEvent, ...args: unknown[]) => Promise<unknown>): void;
}
export interface NativeCredentialHandlerDeps {
  vault: ElectronCredentialVault;
  /** Must be createNativeWindowAuthority's main-owned object/frame/URL check. */
  assertSender(event: NativeAuthorityEvent): { workspaceId: string; bindingId: string };
  isLocalWorkspace(workspaceId: string): boolean;
  getSourceWorkspaceId(workspaceId: string): string | null;
  /** Post-commit invalidation/reconciliation receives identifiers, not secrets. */
  onApplied?(changes: NativeCredentialAppliedChange[]): Promise<void>;
}

function requireScope(event: NativeAuthorityEvent, deps: NativeCredentialHandlerDeps): NativeCredentialScope & { bindingId: string } {
  let binding: ReturnType<NativeCredentialHandlerDeps['assertSender']>;
  try { binding = deps.assertSender(event); }
  catch { throw new CredentialVaultError('UNTRUSTED_SENDER'); }
  const { workspaceId, bindingId } = binding;
  if (!workspaceId || !deps.isLocalWorkspace(workspaceId)) throw new CredentialVaultError('SCOPE_NOT_ALLOWED');
  const sourceWorkspaceId = deps.getSourceWorkspaceId(workspaceId);
  return { workspaceId, bindingId, sourceWorkspaceId, sourceScopeUnavailable: sourceWorkspaceId === null, includesGlobal: true, includesLlm: true };
}

const inScope = (id: CredentialId, scope: NativeCredentialScope) => id.type.startsWith('source_')
  ? !!scope.sourceWorkspaceId && id.workspaceId === scope.sourceWorkspaceId
  : !id.workspaceId || id.workspaceId === scope.workspaceId;
const exactObject = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));

/** Native Electron IPC only. Do not register on any network-facing RpcServer. */
export function registerNativeCredentialIpcHandlers(ipc: CredentialIpcRegistrar, deps: NativeCredentialHandlerDeps): void {
  const register = (channel: string, operation: (scope: NativeCredentialScope, args: unknown[]) => Promise<unknown>) => {
    ipc.handle(channel, async (event, ...args): Promise<NativeCredentialResult<unknown>> => {
      try {
        const { bindingId, ...scope } = requireScope(event, deps);
        const value = await operation(scope, args);
        // Discard read results if the trusted native window switched or
        // navigated while an asynchronous inventory operation was pending.
        if (channel === NATIVE_CREDENTIAL_IPC.STATUS || channel === NATIVE_CREDENTIAL_IPC.LIST) {
          const current = requireScope(event, deps);
          if (current.bindingId !== bindingId || current.sourceWorkspaceId !== scope.sourceWorkspaceId) {
            throw new CredentialVaultError('SCOPE_NOT_ALLOWED');
          }
        }
        return { ok: true, value };
      } catch (error) {
        const safe = error instanceof CredentialVaultError ? error : new CredentialVaultError('VAULT_READ_FAILED');
        return { ok: false, code: safe.code, message: safe.message };
      }
    });
  };
  register(NATIVE_CREDENTIAL_IPC.STATUS, async (scope, args) => {
    if (args.length) throw new CredentialVaultError('INVALID_REQUEST');
    return { scope, status: await deps.vault.status() };
  });
  register(NATIVE_CREDENTIAL_IPC.LIST, async (scope, args) => {
    if (args.length) throw new CredentialVaultError('INVALID_REQUEST');
    const status = await deps.vault.status();
    if (!status.canList) throw new CredentialVaultError(status.errorCode ?? 'VAULT_READ_FAILED');
    return { scope, status, entries: (await deps.vault.listMetadata()).filter(entry => inScope(entry.id, scope)), ...await deps.vault.listManagedMetadata() };
  });
  register(NATIVE_CREDENTIAL_IPC.APPLY, async (scope, args) => {
    if (args.length !== 1 || !exactObject(args[0], ['changes'])) throw new CredentialVaultError('INVALID_REQUEST');
    const changes = validateNativeCredentialChanges(args[0].changes);
    if (changes.some(change => !inScope(change.id, scope))) throw new CredentialVaultError('SCOPE_NOT_ALLOWED');
    let result: Awaited<ReturnType<ElectronCredentialVault['apply']>>;
    try { result = await deps.vault.apply(changes); }
    catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError('VAULT_WRITE_FAILED');
    }
    const warnings: Array<'RUNTIME_RECONCILIATION_PENDING'> = [];
    try { await deps.onApplied?.(changes.map(change => ({ op: change.op, id: change.id,
      ...(change.op === 'upsert' ? { fields: Object.keys(change.credential) as NonNullable<NativeCredentialAppliedChange['fields']> } : {}),
    }))); }
    catch { warnings.push('RUNTIME_RECONCILIATION_PENDING'); }
    // Persistence is already committed. Never report a false save failure
    // merely because notifying an existing runtime needs a later retry.
    return { scope, status: await deps.vault.status(), ...result, ...(warnings.length ? { warnings } : {}) };
  });
  register(NATIVE_CREDENTIAL_IPC.MIGRATE, async (scope, args) => {
    if (args.length !== 1 || !exactObject(args[0], ['acknowledgeHeadlessIncompatibility']) || args[0].acknowledgeHeadlessIncompatibility !== true) {
      throw new CredentialVaultError('INVALID_REQUEST');
    }
    const result = await deps.vault.migrate();
    return { scope, status: await deps.vault.status(), ...result };
  });
}
