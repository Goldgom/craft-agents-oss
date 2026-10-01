/** Main owns all remote transport credentials. Preload receives opaque handles only. */
import { createHash, randomUUID } from 'node:crypto'
import { getAllChannelValues, isRemoteEligible } from '@craft-agent/shared/protocol'
import { CLIENT_SFTP_TRANSFER, LOCAL_CLIENT_CAPABILITIES, type TransportConnectionState, type RpcClient, type WsRpcHandshakeGuard } from '@craft-agent/server-core/transport'
import { CHANNEL_MAP } from '../transport/channel-map'
import type { NativeAuthorityEvent, NativeWebContentsIdentity } from './native-window-authority'
import { NATIVE_REMOTE_TRANSPORT as IPC, type NativeRemoteMode, type NativeRemotePacket, type NativeRemoteResult, type NativeRemoteFailureCode, type NativeRemoteCapabilityResult } from '../shared/native-remote-transport'

export interface NativeRemoteAuthority { webContentsId: number; workspaceId: string; bindingId: string }
/** Returned only by trusted main resolution. Never accepted from a renderer. */
export interface MainRemoteTarget {
  mode: NativeRemoteMode
  url: string
  token: string
  remoteWorkspaceId?: string
  revision: string
  /** Exact saved profile generation, for main-owned SFTP only. */
  profileId?: string
  profileRevision?: string
  /** Additional main-owned values to redact if a remote peer echoes them. */
  secrets?: string[]
}
export interface MainRemoteClient extends RpcClient {
  connect(): void
  destroy(): void
  reconnectNow(): void
  isChannelAvailable(channel: string): boolean
  getConnectionState(): TransportConnectionState
  onConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void
  onAnyEvent(callback: (channel: string, ...args: unknown[]) => void): () => void
  setHandshakeGuard(guard: WsRpcHandshakeGuard | undefined): void
}
export interface NativeRemoteTransportDependencies {
  assertSender(event: NativeAuthorityEvent): NativeRemoteAuthority
  resolveTarget(authority: NativeRemoteAuthority): Promise<MainRemoteTarget | null>
  createClient(target: MainRemoteTarget, capabilities: readonly string[], authority: NativeRemoteAuthority): MainRemoteClient
  sendToSender(sender: NativeWebContentsIdentity, packet: NativeRemotePacket): void
  /** Must observe native destruction and main-frame navigation (not iframe navigation). */
  attachInvalidation(sender: NativeWebContentsIdentity, invalidate: () => void): () => void
  /** Resolve this exact profile generation, then assertCurrent immediately before transfer. */
  transferSftp?(target: Readonly<MainRemoteTarget>, request: unknown, assertCurrent: () => Promise<void>): Promise<unknown>
  maxHandles?: number
  capabilityTimeoutMs?: number
}
interface NativeRegistrar {
  handle(channel: string, handler: (event: NativeAuthorityEvent, ...args: any[]) => Promise<unknown>): void
}
const protocolChannels = new Set(getAllChannelValues())
const pushChannels = new Set(Object.values(CHANNEL_MAP).filter(entry => entry.type === 'listener').map(entry => entry.channel))
pushChannels.add('__transport:reconnected')
const failureMessages: Record<NativeRemoteFailureCode, string> = {
  DENIED: 'This remote transport action is not allowed.',
  EXPIRED: 'This remote connection belongs to an expired application window. Reopen the workspace.',
  TARGET_CHANGED: 'The saved remote connection changed. Reopen the workspace to use its new settings.',
  LIMIT: 'Too many remote transport operations are pending. Retry after they finish.',
  FAILED: 'The remote workspace operation failed. Check the connection and retry.',
  NETWORK: 'Cannot connect to the remote server. Check that the server is running and the network is available.',
  AUTH: 'Remote authentication failed. Check Remote Servers settings.',
  PROTOCOL: 'The client and server protocol versions are incompatible. Update the client or server.',
  TIMEOUT: 'The remote server did not respond in time. Check the connection and retry.',
  UNSUPPORTED: 'The remote server does not support this operation. Update the server.',
}
function connectionFailureCode(kind: unknown): NativeRemoteFailureCode {
  switch (kind) {
    case 'network': return 'NETWORK'
    case 'auth': return 'AUTH'
    case 'protocol': return 'PROTOCOL'
    case 'timeout': return 'TIMEOUT'
    default: return 'FAILED'
  }
}
class BoundaryError extends Error {
  constructor(readonly code: NativeRemoteFailureCode) { super(failureMessages[code]) }
}
function fingerprint(target: MainRemoteTarget): string {
  return createHash('sha256').update(JSON.stringify([target.mode, target.url, target.token, target.remoteWorkspaceId, target.revision, target.profileId, target.profileRevision])).digest('hex')
}
function allowed(mode: NativeRemoteMode, channel: unknown): channel is string {
  return typeof channel === 'string' && protocolChannels.has(channel) && (mode === 'thin' || isRemoteEligible(channel))
}
function safePayload(value: unknown, secrets: string[], depth = 0): any {
  if (depth > 64) throw new BoundaryError('FAILED')
  if (typeof value === 'string') return secrets.reduce((text, secret) => {
    if (!secret) return text
    return text === secret ? '[redacted]' : secret.length >= 8 ? text.split(secret).join('[redacted]') : text
  }, value)
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    const buffer = Buffer.from(bytes)
    if (secrets.some(secret => secret && buffer.includes(Buffer.from(secret)))) throw new BoundaryError('FAILED')
    return new Uint8Array(bytes)
  }
  if (Array.isArray(value)) return value.map(item => safePayload(item, secrets, depth + 1))
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [safePayload(key, secrets, depth + 1), safePayload(item, secrets, depth + 1)]))
  throw new BoundaryError('FAILED')
}
interface PendingCapability { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface Handle {
  id: string
  event: NativeAuthorityEvent
  authority: NativeRemoteAuthority
  target: MainRemoteTarget
  fingerprint: string
  client: MainRemoteClient
  started: boolean
  closed: boolean
  subscriptions: Set<string>
  capabilities: Map<string, PendingCapability>
  pendingRequests: number
  pendingMainCapabilities: number
  cleanups: Array<() => void>
  pushTail: Promise<void>
}

export function registerNativeRemoteTransport(ipc: NativeRegistrar, deps: NativeRemoteTransportDependencies) {
  const handles = new Map<string, Handle>()
  const active = new WeakMap<object, Handle>()
  const openSequence = new WeakMap<object, number>()
  const generations = new WeakMap<object, { bindingId: string; fingerprint: string }>()
  function assertEntry(event: NativeAuthorityEvent, id: unknown): Handle {
    const authority = deps.assertSender(event)
    const entry = typeof id === 'string' ? handles.get(id) : undefined
    if (!entry || entry.closed || entry.event.sender !== event.sender || active.get(event.sender) !== entry
      || authority.bindingId !== entry.authority.bindingId || authority.workspaceId !== entry.authority.workspaceId) throw new BoundaryError('EXPIRED')
    return entry
  }
  function dispose(entry: Handle): void {
    const alreadyClosed = entry.closed
    entry.closed = true
    handles.delete(entry.id)
    if (active.get(entry.event.sender) === entry) active.delete(entry.event.sender)
    for (const cleanup of entry.cleanups.splice(0)) { try { cleanup() } catch { /* no provider errors cross IPC */ } }
    for (const pending of entry.capabilities.values()) { clearTimeout(pending.timer); pending.reject(new BoundaryError('EXPIRED')) }
    entry.capabilities.clear()
    if (!alreadyClosed) entry.client.destroy()
  }
  async function revalidate(entry: Handle): Promise<void> {
    try {
      assertEntry(entry.event, entry.id)
      const current = await deps.resolveTarget(deps.assertSender(entry.event))
      assertEntry(entry.event, entry.id)
      if (!current || fingerprint(current) !== entry.fingerprint) throw new BoundaryError('TARGET_CHANGED')
    } catch (error) {
      const code = error instanceof BoundaryError ? error.code : 'EXPIRED'
      // Notify only the still-current native frame. Never forward provider text.
      try {
        assertEntry(entry.event, entry.id)
        deps.sendToSender(entry.event.sender, { kind: 'state', handle: entry.id, availableChannels: [], state: {
          ...safeState(entry), status: 'failed', lastError: { kind: 'unknown', code, message: failureMessages[code] },
        } })
      } catch { /* frame already gone */ }
      dispose(entry)
      throw new BoundaryError(code)
    }
  }
  function channels(entry: Handle): string[] {
    return [...protocolChannels].filter(channel => allowed(entry.target.mode, channel) && entry.client.isChannelAvailable(channel))
  }
  function safeState(entry: Handle): TransportConnectionState {
    const state = entry.client.getConnectionState()
    const validKinds = new Set(['auth', 'protocol', 'timeout', 'network', 'server', 'unknown'])
    const kind = state.lastError && validKinds.has(state.lastError.kind) ? state.lastError.kind : 'unknown'
    let origin = ''
    try { origin = new URL(entry.target.url).origin } catch { /* invalid targets fail on connect */ }
    return {
      mode: 'remote', status: state.status, url: origin, attempt: state.attempt,
      ...(state.nextRetryInMs !== undefined ? { nextRetryInMs: state.nextRetryInMs } : {}),
      ...(state.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: state.lastHeartbeatAt } : {}),
      updatedAt: state.updatedAt,
      ...(state.lastError ? { lastError: { kind, code: connectionFailureCode(kind), message: failureMessages[connectionFailureCode(kind)] } } : {}),
      ...(state.lastClose ? { lastClose: { code: state.lastClose.code, wasClean: state.lastClose.wasClean } } : {}),
    }
  }
  function send(entry: Handle, packet: NativeRemotePacket): void {
    assertEntry(entry.event, entry.id)
    const secrets = [entry.target.token, ...(entry.target.secrets ?? [])]
    // Correlation IDs, protocol names and schema keys are structural metadata,
    // never credential values. Redacting the envelope breaks short-token users.
    deps.sendToSender(entry.event.sender, packet.kind === 'state' ? packet : { ...packet, args: safePayload(packet.args, secrets) })
  }
  function handler(channel: string, fn: (event: NativeAuthorityEvent, ...args: any[]) => Promise<unknown>) {
    ipc.handle(channel, async (event, ...args): Promise<NativeRemoteResult<unknown>> => {
      try { deps.assertSender(event); return { ok: true, value: await fn(event, ...args) } }
      catch (error) {
        const code = error instanceof BoundaryError ? error.code : 'FAILED'
        return { ok: false, code, message: failureMessages[code] }
      }
    })
  }
  handler(IPC.OPEN, async (event, ...args) => {
    if (args.length) throw new BoundaryError('DENIED')
    const authority = deps.assertSender(event)
    const sequence = (openSequence.get(event.sender) ?? 0) + 1
    openSequence.set(event.sender, sequence)
    const target = await deps.resolveTarget(authority)
    if (openSequence.get(event.sender) !== sequence || deps.assertSender(event).bindingId !== authority.bindingId) throw new BoundaryError('EXPIRED')
    if (!target || !['workspace', 'thin'].includes(target.mode) || typeof target.token !== 'string') throw new BoundaryError('DENIED')
    const targetFingerprint = fingerprint(target)
    const generation = generations.get(event.sender)
    if (generation?.bindingId === authority.bindingId && generation.fingerprint !== targetFingerprint) throw new BoundaryError('TARGET_CHANGED')
    const old = active.get(event.sender)
    if (!old && handles.size >= (deps.maxHandles ?? 64)) throw new BoundaryError('LIMIT')
    if (old) dispose(old)
    const client = deps.createClient(target, LOCAL_CLIENT_CAPABILITIES, authority)
    const entry: Handle = { id: randomUUID(), event, authority, target: { ...target }, fingerprint: targetFingerprint, client,
      started: false, closed: false, subscriptions: new Set(), capabilities: new Map(), pendingRequests: 0, pendingMainCapabilities: 0, cleanups: [], pushTail: Promise.resolve() }
    handles.set(entry.id, entry); active.set(event.sender, entry)
    generations.set(event.sender, { bindingId: authority.bindingId, fingerprint: targetFingerprint })
    try {
      // Every first/reconnect handshake must resolve and verify the native
      // binding before the SDK sends its cached bearer. No background retarget.
      client.setHandshakeGuard(() => revalidate(entry))
      const forward = (channel: string, ...args: unknown[]) => {
        if (!entry.subscriptions.has(channel) || !pushChannels.has(channel)) return
        entry.pushTail = entry.pushTail.then(async () => {
          await revalidate(entry)
          if (entry.subscriptions.has(channel)) send(entry, { kind: 'push', handle: entry.id, channel, args })
        }).catch(() => {})
      }
      entry.cleanups.push(client.onAnyEvent((channel, ...args) => { if (channel !== '__transport:reconnected') forward(channel, ...args) }))
      entry.cleanups.push(client.on('__transport:reconnected', (...args) => forward('__transport:reconnected', ...args)))
      entry.cleanups.push(client.onConnectionStateChanged(() => {
        try { send(entry, { kind: 'state', handle: entry.id, state: safeState(entry), availableChannels: channels(entry) }) } catch { dispose(entry) }
      }))
      entry.cleanups.push(deps.attachInvalidation(event.sender, () => dispose(entry)))
      for (const channel of LOCAL_CLIENT_CAPABILITIES) client.handleCapability(channel, async (...args) => {
        await revalidate(entry)
        if (entry.capabilities.size + entry.pendingMainCapabilities >= 128) throw new BoundaryError('LIMIT')
        if (channel === CLIENT_SFTP_TRANSFER) {
          // SFTP credentials and destination ownership stay in main. A queued
          // request must never consult preload's newly selected active profile.
          if (!deps.transferSftp || !entry.target.profileId || !entry.target.profileRevision || args.length !== 1) throw new BoundaryError('DENIED')
          entry.pendingMainCapabilities++
          try {
            const result = await deps.transferSftp(Object.freeze({ ...entry.target }), args[0], () => revalidate(entry))
            await revalidate(entry)
            return safePayload(result, [entry.target.token, ...(entry.target.secrets ?? [])])
          } catch (error) {
            throw error instanceof BoundaryError ? error : new BoundaryError('FAILED')
          } finally { entry.pendingMainCapabilities-- }
        }
        const callId = randomUUID()
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { entry.capabilities.delete(callId); reject(new BoundaryError('FAILED')) }, deps.capabilityTimeoutMs ?? 600_000)
          entry.capabilities.set(callId, { resolve, reject, timer })
          try { send(entry, { kind: 'capability', handle: entry.id, callId, channel, args }) }
          catch { clearTimeout(timer); entry.capabilities.delete(callId); reject(new BoundaryError('EXPIRED')) }
        })
      })
      assertEntry(event, entry.id)
      return { handle: entry.id, state: safeState(entry), availableChannels: channels(entry), ...(target.remoteWorkspaceId ? { remoteWorkspaceId: target.remoteWorkspaceId } : {}) }
    } catch (error) { dispose(entry); throw error }
  })
  handler(IPC.START, async (event, id) => {
    const entry = assertEntry(event, id); await revalidate(entry)
    if (!entry.started) { entry.started = true; entry.client.connect() }
    return null
  })
  handler(IPC.INVOKE, async (event, id, channel, args) => {
    const entry = assertEntry(event, id)
    if (!allowed(entry.target.mode, channel) || !Array.isArray(args)) throw new BoundaryError('DENIED')
    if (entry.pendingRequests >= 128) throw new BoundaryError('LIMIT')
    entry.pendingRequests++
    try {
      await revalidate(entry)
      const result = await entry.client.invoke(channel, ...args)
      await revalidate(entry)
      return safePayload(result, [entry.target.token, ...(entry.target.secrets ?? [])])
    } catch (error) {
      if (error instanceof BoundaryError) throw error
      // Use structured error categories only; provider messages may echo secrets.
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'CHANNEL_NOT_FOUND') throw new BoundaryError('UNSUPPORTED')
      const kind = (error as { kind?: unknown } | null)?.kind
        ?? (code === 'REQUEST_TIMEOUT' ? 'timeout' : entry.client.getConnectionState().lastError?.kind)
      throw new BoundaryError(connectionFailureCode(kind))
    } finally { entry.pendingRequests-- }
  })
  handler(IPC.SUBSCRIBE, async (event, id, requested) => {
    const entry = assertEntry(event, id)
    if (!Array.isArray(requested) || requested.length > pushChannels.size || requested.some(channel => !pushChannels.has(channel) || (channel !== '__transport:reconnected' && !allowed(entry.target.mode, channel)))) throw new BoundaryError('DENIED')
    entry.subscriptions = new Set(requested)
    return null
  })
  handler(IPC.RECONNECT, async (event, id) => {
    const entry = assertEntry(event, id); await revalidate(entry); entry.client.reconnectNow(); return null
  })
  handler(IPC.CAPABILITY_RESULT, async (event, id, callId, result: NativeRemoteCapabilityResult) => {
    const entry = assertEntry(event, id); await revalidate(entry)
    const pending = typeof callId === 'string' ? entry.capabilities.get(callId) : undefined
    if (!pending || !result || typeof result.ok !== 'boolean') throw new BoundaryError('DENIED')
    entry.capabilities.delete(callId); clearTimeout(pending.timer)
    if (result.ok) pending.resolve(result.value)
    else pending.reject(new BoundaryError('FAILED'))
    return null
  })
  handler(IPC.DESTROY, async (event, id) => { dispose(assertEntry(event, id)); return null })
  return { dispose: () => { for (const entry of handles.values()) dispose(entry) }, getStats: () => ({ handles: handles.size, capabilities: [...handles.values()].reduce((sum, entry) => sum + entry.capabilities.size, 0) }) }
}
