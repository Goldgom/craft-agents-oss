import { expect, spyOn, test } from 'bun:test'
import { RPC_CHANNELS } from '@tokenbird/shared/protocol'
import { registerCredentialHandlers, type RemoteCredentialHost } from '../credentials'
import type { HandlerDeps } from '../../handler-deps'
import type { RpcServer, HandlerFn } from '../../../transport'

function fixture() {
  const handlers = new Map<string, HandlerFn>()
  let approve!: (allowed: boolean) => void
  const changes: unknown[] = []
  const status = { state: 'ready', protection: 'legacy-machine', backend: null, canList: true, canApply: true, canMigrate: true, legacyBackupAvailable: false, requiresSeparateHeadlessConfig: false } as const
  const host: RemoteCredentialHost = {
    scope: workspaceId => workspaceId === 'a' ? { workspaceId, sourceWorkspaceId: 'source-a', sourceScopeUnavailable: false, includesGlobal: true, includesLlm: true } : null,
    status: async () => status,
    listMetadata: async () => [
      { id: { type: 'saved_credential', workspaceId: 'a', name: 'visible' }, hasValue: true, presentFields: ['value'] },
      { id: { type: 'saved_credential', workspaceId: 'b', name: 'hidden' }, hasValue: true, presentFields: ['value'] },
    ],
    apply: async batch => { changes.push(...batch); return { upsertedCount: batch.length, deletedCount: 0 } },
    approve: () => new Promise(resolve => { approve = resolve }),
  }
  registerCredentialHandlers({ handle: (channel: string, handler: HandlerFn) => { handlers.set(channel, handler) } } as unknown as RpcServer, { remoteCredentialHost: host } as HandlerDeps)
  const ctx = { clientId: 'client-a', workspaceId: 'a', webContentsId: 42 }
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(ctx, ...args)
  return { handlers, ctx, invoke, changes, allow: async (allowed: boolean) => { approve(allowed); await new Promise(resolve => setTimeout(resolve, 0)) } }
}

test('network clients need host approval; grants never authorize another connection or workspace', async () => {
  const f = fixture()
  expect((await f.invoke(RPC_CHANNELS.credentials.LIST)).ok).toBe(false)
  expect(await f.invoke(RPC_CHANNELS.credentials.REQUEST_ACCESS)).toEqual({ state: 'pending' })
  expect((await f.invoke(RPC_CHANNELS.credentials.LIST)).ok).toBe(false)
  await f.allow(true)
  const list = await f.invoke(RPC_CHANNELS.credentials.LIST)
  expect(list.ok).toBe(true)
  expect(list.value.entries.map((entry: any) => entry.id.name)).toEqual(['visible'])
  expect(list.value.status.canMigrate).toBe(false)
  expect(JSON.stringify(list)).not.toContain('hidden')
  expect((await f.handlers.get(RPC_CHANNELS.credentials.LIST)!({ ...f.ctx, clientId: 'other' })).ok).toBe(false)
  expect((await f.invoke(RPC_CHANNELS.credentials.APPLY, { changes: [{ op: 'delete', id: { type: 'saved_credential', workspaceId: 'b', name: 'hidden' } }] })).ok).toBe(false)
  expect(f.changes).toEqual([])
  expect((await f.invoke(RPC_CHANNELS.credentials.APPLY, { changes: [{ op: 'upsert', id: { type: 'saved_credential', workspaceId: 'a', name: 'new' }, credential: { value: 'dummy-write-only-secret' } }] })).ok).toBe(true)
})

test('denied requests remain unauthorized and hosts without approval are unavailable', async () => {
  const f = fixture()
  await f.invoke(RPC_CHANNELS.credentials.REQUEST_ACCESS)
  await f.allow(false)
  expect(await f.invoke(RPC_CHANNELS.credentials.ACCESS)).toEqual({ state: 'required' })
  expect((await f.invoke(RPC_CHANNELS.credentials.LIST)).ok).toBe(false)
  const handlers = new Map<string, HandlerFn>()
  registerCredentialHandlers({ handle: (channel: string, handler: HandlerFn) => { handlers.set(channel, handler) } } as unknown as RpcServer, {} as HandlerDeps)
  expect(await handlers.get(RPC_CHANNELS.credentials.ACCESS)!(f.ctx)).toEqual({ state: 'unavailable' })
})

test('expired approval denies further reads and writes', async () => {
  const f = fixture()
  await f.invoke(RPC_CHANNELS.credentials.REQUEST_ACCESS)
  await f.allow(true)
  const now = Date.now()
  const clock = spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000)
  try {
    expect(await f.invoke(RPC_CHANNELS.credentials.ACCESS)).toEqual({ state: 'required' })
    expect((await f.invoke(RPC_CHANNELS.credentials.LIST)).ok).toBe(false)
    expect((await f.invoke(RPC_CHANNELS.credentials.APPLY, { changes: [{ op: 'delete', id: { type: 'saved_credential', workspaceId: 'a', name: 'visible' } }] })).ok).toBe(false)
    expect(f.changes).toEqual([])
  } finally { clock.mockRestore() }
})

test('automatic access rechecks connection and workspace scope before returning metadata', async () => {
  for (const disconnect of [false, true]) {
    const handlers = new Map<string, HandlerFn>()
    const controller = new AbortController()
    let sourceWorkspaceId = 'source-a'
    const host: RemoteCredentialHost = {
      accessPolicy: 'authenticated-connection',
      scope: workspaceId => ({ workspaceId, sourceWorkspaceId, sourceScopeUnavailable: false, includesGlobal: true, includesLlm: true }),
      status: async () => ({ state: 'empty', protection: 'none', backend: null, canList: true, canApply: true, canMigrate: false, legacyBackupAvailable: false, requiresSeparateHeadlessConfig: false }),
      listMetadata: async () => {
        if (disconnect) controller.abort()
        else sourceWorkspaceId = 'changed-source'
        return [{ id: { type: 'saved_credential', workspaceId: 'a', name: 'old-scope' }, hasValue: true, presentFields: ['value'] }]
      },
      apply: async () => ({ upsertedCount: 0, deletedCount: 0 }),
      approve: async () => { throw new Error('Automatic access should not request approval') },
    }
    registerCredentialHandlers({ handle: (channel: string, handler: HandlerFn) => handlers.set(channel, handler) } as unknown as RpcServer, { remoteCredentialHost: host } as HandlerDeps)
    const result = await handlers.get(RPC_CHANNELS.credentials.LIST)!({ clientId: 'client', workspaceId: 'a', webContentsId: null, authenticatedBy: 'bearer', signal: controller.signal })
    expect(result.code).toBe('SCOPE_NOT_ALLOWED')
    expect(result.value).toBeUndefined()
  }
})
