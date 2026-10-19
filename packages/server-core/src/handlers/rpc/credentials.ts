import { RPC_CHANNELS } from '@tokenbird/shared/protocol'
import { CredentialVaultError } from '@tokenbird/shared/credentials/backends/vault-protection'
import { validateNativeCredentialChanges } from '@tokenbird/shared/credentials/native-validation'
import type { NativeCredentialScope, NativeCredentialMetadata, NativeCredentialVaultStatus, NativeCredentialChange } from '@tokenbird/shared/credentials/native-types'
import type { RequestContext, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'

export interface RemoteCredentialHost {
  /** Standalone servers can use their verified connection authentication directly. */
  accessPolicy?: 'host-approval' | 'authenticated-connection'
  scope(workspaceId: string): NativeCredentialScope | null
  status(): Promise<NativeCredentialVaultStatus>
  listMetadata(): Promise<NativeCredentialMetadata[]>
  apply(changes: NativeCredentialChange[]): Promise<{ upsertedCount: number; deletedCount: number }>
  onApplied?(changes: NativeCredentialChange[]): Promise<void>
  approve(request: { clientId: string; workspaceId: string; expiresAt: number; authenticatedBy?: RequestContext['authenticatedBy'] }): Promise<boolean>
}
const TTL = 10 * 60_000
const REQUEST_TTL = 2 * 60_000
const inScope = (id: NativeCredentialChange['id'], scope: NativeCredentialScope) => id.type.startsWith('source_')
  ? !!scope.sourceWorkspaceId && id.workspaceId === scope.sourceWorkspaceId
  : !id.workspaceId || id.workspaceId === scope.workspaceId

/** The host selects connection authentication or an explicit scoped, expiring grant. */
export function registerCredentialHandlers(server: RpcServer, deps: HandlerDeps): void {
  const grants = new Map<string, { expiresAt: number; scope: string }>()
  const pending = new Set<string>()
  const host = deps.remoteCredentialHost
  const resolve = (ctx: RequestContext) => {
    if (!ctx.workspaceId || !host) throw new CredentialVaultError('SCOPE_NOT_ALLOWED')
    const scope = host.scope(ctx.workspaceId)
    if (!scope) throw new CredentialVaultError('SCOPE_NOT_ALLOWED')
    return scope
  }
  const key = (ctx: RequestContext) => JSON.stringify([ctx.clientId, ctx.workspaceId])
  const approved = (ctx: RequestContext, scope: NativeCredentialScope) => {
    if (host?.accessPolicy === 'authenticated-connection') {
      return !ctx.signal?.aborted && (ctx.authenticatedBy === 'bearer' || ctx.authenticatedBy === 'cookie')
    }
    const grant = grants.get(key(ctx))
    return !!grant && grant.expiresAt > Date.now() && grant.scope === JSON.stringify(scope)
  }
  const access = (ctx: RequestContext) => {
    const scope = resolve(ctx)
    return { state: approved(ctx, scope) ? 'approved' : pending.has(key(ctx)) ? 'pending' : 'required',
      ...(approved(ctx, scope) && host?.accessPolicy !== 'authenticated-connection' ? { expiresAt: grants.get(key(ctx))!.expiresAt } : {}) }
  }
  server.handle(RPC_CHANNELS.credentials.ACCESS, ctx => {
    try { return access(ctx) } catch { return { state: 'unavailable' } }
  })
  server.handle(RPC_CHANNELS.credentials.REQUEST_ACCESS, ctx => {
    const scope = resolve(ctx)
    if (host!.accessPolicy === 'authenticated-connection') return access(ctx)
    for (const [id, grant] of grants) if (grant.expiresAt <= Date.now()) grants.delete(id)
    if (approved(ctx, scope) || pending.has(key(ctx))) return access(ctx)
    if (pending.size >= 8 || grants.size >= 256) throw new CredentialVaultError('VAULT_LOCKED')
    const id = key(ctx)
    const requestedScope = JSON.stringify(scope)
    pending.add(id)
    let settled = false
    const timer = setTimeout(() => { settled = true; pending.delete(id) }, REQUEST_TTL)
    void host!.approve({ clientId: ctx.clientId, workspaceId: scope.workspaceId, expiresAt: Date.now() + REQUEST_TTL, authenticatedBy: ctx.authenticatedBy })
      .then(allowed => {
        if (!settled && allowed && JSON.stringify(resolve(ctx)) === requestedScope) {
          grants.set(id, { expiresAt: Date.now() + TTL, scope: requestedScope })
        }
      }).catch(() => {}).finally(() => { if (!settled) { clearTimeout(timer); pending.delete(id); settled = true } })
    return { state: 'pending' }
  })
  const register = (channel: string, operation: (scope: NativeCredentialScope, args: unknown[]) => Promise<unknown>) => {
    server.handle(channel, async (ctx, ...args) => {
      try {
        const scope = resolve(ctx)
        if (!approved(ctx, scope)) throw new CredentialVaultError('SCOPE_NOT_ALLOWED')
        const value = await operation(scope, args)
        if (channel !== RPC_CHANNELS.credentials.APPLY) {
          const currentScope = resolve(ctx)
          if (JSON.stringify(currentScope) !== JSON.stringify(scope) || !approved(ctx, currentScope)) throw new CredentialVaultError('SCOPE_NOT_ALLOWED')
        }
        return { ok: true, value }
      } catch (error) {
        const safe = error instanceof CredentialVaultError ? error : new CredentialVaultError('VAULT_READ_FAILED')
        return { ok: false, code: safe.code, message: safe.message }
      }
    })
  }
  register(RPC_CHANNELS.credentials.STATUS, async (scope, args) => {
    if (args.length) throw new CredentialVaultError('INVALID_REQUEST')
    return { scope, status: { ...await host!.status(), canMigrate: false } }
  })
  register(RPC_CHANNELS.credentials.LIST, async (scope, args) => {
    if (args.length) throw new CredentialVaultError('INVALID_REQUEST')
    const status = { ...await host!.status(), canMigrate: false }
    if (!status.canList) throw new CredentialVaultError(status.errorCode ?? 'VAULT_READ_FAILED')
    return { scope, status, entries: (await host!.listMetadata()).filter(entry => inScope(entry.id, scope)) }
  })
  register(RPC_CHANNELS.credentials.APPLY, async (scope, args) => {
    const request = args[0]
    if (args.length !== 1 || !request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).length !== 1 || !('changes' in request)) throw new CredentialVaultError('INVALID_REQUEST')
    const changes = validateNativeCredentialChanges(request.changes)
    if (changes.some(change => !inScope(change.id, scope))) throw new CredentialVaultError('SCOPE_NOT_ALLOWED')
    let result
    try { result = await host!.apply(changes) } catch (error) {
      throw error instanceof CredentialVaultError ? error : new CredentialVaultError('VAULT_WRITE_FAILED')
    }
    let warnings: string[] | undefined
    try { await host!.onApplied?.(changes) } catch { warnings = ['RUNTIME_RECONCILIATION_PENDING'] }
    return { scope, status: { ...await host!.status(), canMigrate: false }, ...result, ...(warnings ? { warnings } : {}) }
  })
}
