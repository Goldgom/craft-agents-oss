/** Preload transport adapter. It never accepts, resolves, or stores a server token. */
import type { RpcClient, TransportConnectionState } from '@craft-agent/server-core/transport'
import { getAllChannelValues } from '@craft-agent/shared/protocol'
import { LOCAL_CLIENT_CAPABILITIES } from '@craft-agent/server-core/transport'
import { NATIVE_REMOTE_TRANSPORT as IPC, type NativeRemoteOpened, type NativeRemotePacket, type NativeRemoteResult } from '../shared/native-remote-transport'

export interface NativeRemoteIpcClient {
  invoke(channel: string, ...args: unknown[]): Promise<any>
  on(channel: string, listener: (event: unknown, packet: NativeRemotePacket) => void): unknown
  removeListener(channel: string, listener: (event: unknown, packet: NativeRemotePacket) => void): unknown
}
const knownChannels = new Set(getAllChannelValues())
const knownCapabilities = new Set(LOCAL_CLIENT_CAPABILITIES)
function unwrap<T>(result: NativeRemoteResult<T>): T {
  if (!result || result.ok !== true) throw new Error(result && result.ok === false ? result.message : 'Remote transport is unavailable')
  return result.value
}
export class NativeRemoteClient implements RpcClient {
  private handle: string | null = null
  private opening: Promise<void> | null = null
  private destroyed = false
  private generation = 0
  private subscriptionsQueued = false
  private reconnectOperation: Promise<void> | null = null
  private available: Set<string> | null = null
  private listeners = new Map<string, Set<(...args: any[]) => void>>()
  private capabilities = new Map<string, (...args: any[]) => Promise<any> | any>()
  private stateListeners = new Set<(state: TransportConnectionState) => void>()
  private state: TransportConnectionState = { mode: 'remote', status: 'idle', url: '', attempt: 0, updatedAt: Date.now() }
  private remoteWorkspaceId?: string
  private readonly receive = (_event: unknown, packet: NativeRemotePacket) => {
    if (this.destroyed || !packet || packet.handle !== this.handle) return
    if (packet.kind === 'state') {
      this.available = new Set(packet.availableChannels)
      this.setState(packet.state)
    } else if (packet.kind === 'push') {
      for (const callback of this.listeners.get(packet.channel) ?? []) { try { callback(...packet.args) } catch { /* user listeners are isolated */ } }
    } else if (packet.kind === 'capability') {
      const handle = this.handle
      const handler = knownCapabilities.has(packet.channel) ? this.capabilities.get(packet.channel) : undefined
      void (async () => {
        let result: { ok: true; value: unknown } | { ok: false; message: string }
        try {
          if (!handler) throw new Error('Capability unavailable')
          result = { ok: true, value: await handler(...packet.args) }
        } catch { result = { ok: false, message: 'Client capability failed' } }
        if (!this.destroyed && this.handle === handle) {
          await this.ipc.invoke(IPC.CAPABILITY_RESULT, handle, packet.callId, result).catch(() => {})
        }
      })()
    }
  }
  constructor(private readonly ipc: NativeRemoteIpcClient) { ipc.on(IPC.EVENT, this.receive) }
  private setState(state: TransportConnectionState): void {
    this.state = { ...state }
    for (const callback of this.stateListeners) { try { callback(this.getConnectionState()) } catch { /* isolate callbacks */ } }
  }
  private fail(error: unknown): void {
    if (this.destroyed) return
    this.setState({ ...this.state, status: 'failed', updatedAt: Date.now(), lastError: {
      kind: 'unknown', message: error instanceof Error ? error.message : 'Remote transport is unavailable',
    } })
  }
  private ensureOpen(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('Remote client destroyed'))
    if (this.opening) return this.opening
    this.setState({ ...this.state, status: 'connecting', updatedAt: Date.now() })
    const generation = this.generation
    let ownedHandle: string | null = null
    this.opening = (async () => {
      const opened = unwrap<NativeRemoteOpened>(await this.ipc.invoke(IPC.OPEN))
      ownedHandle = opened.handle
      if (this.destroyed || generation !== this.generation) { await this.ipc.invoke(IPC.DESTROY, opened.handle).catch(() => {}); throw new Error('Remote client generation expired') }
      this.handle = opened.handle
      this.remoteWorkspaceId = opened.remoteWorkspaceId
      this.available = new Set(opened.availableChannels)
      this.setState(opened.state)
      unwrap(await this.ipc.invoke(IPC.SUBSCRIBE, opened.handle, [...this.listeners.keys()]))
      if (this.destroyed || generation !== this.generation) throw new Error('Remote client generation expired')
      unwrap(await this.ipc.invoke(IPC.START, opened.handle))
    })().catch(async error => {
      if (generation === this.generation && this.handle === ownedHandle) this.handle = null
      if (ownedHandle) await this.ipc.invoke(IPC.DESTROY, ownedHandle).catch(() => {})
      throw error
    })
    // A failed open is terminal for this adapter's generation. Reopening a
    // workspace creates a fresh adapter instead of silently changing its target.
    return this.opening
  }
  connect(): void {
    const generation = this.generation
    void this.ensureOpen().catch(error => { if (generation === this.generation) this.fail(error) })
  }
  /** Explicit native switch/reopen only. Keeps the public object and listeners stable. */
  async rebind(): Promise<void> {
    if (this.destroyed) throw new Error('Remote client destroyed')
    const generation = ++this.generation
    const oldHandle = this.handle
    this.handle = null; this.opening = null; this.reconnectOperation = null
    this.available = null; this.remoteWorkspaceId = undefined; this.subscriptionsQueued = false
    this.setState({ mode: 'remote', status: 'connecting', url: '', attempt: 0, updatedAt: Date.now() })
    if (oldHandle) await this.ipc.invoke(IPC.DESTROY, oldHandle).catch(() => {})
    if (this.destroyed || generation !== this.generation) throw new Error('Remote client generation expired')
    await this.ensureOpen()
  }
  async invoke(channel: string, ...args: any[]): Promise<any> {
    if (!knownChannels.has(channel)) throw new Error('Unknown remote protocol channel')
    const generation = this.generation
    await this.ensureOpen()
    if (generation !== this.generation) throw new Error('Remote client generation expired')
    if (this.reconnectOperation) await this.reconnectOperation
    if (generation !== this.generation) throw new Error('Remote client generation expired')
    if (!this.handle || this.destroyed) throw new Error('Remote client destroyed')
    const handle = this.handle
    const result = await this.ipc.invoke(IPC.INVOKE, handle, channel, args)
    // Main may already have produced a valid result when an explicit switch
    // or teardown invalidates this adapter. Never expose that old workspace's
    // reply through the stable adapter object now bound to another workspace.
    if (this.destroyed || generation !== this.generation || this.handle !== handle) throw new Error('Remote client generation expired')
    return unwrap(result)
  }
  private scheduleSubscriptions(): void {
    if (!this.handle || this.destroyed || this.subscriptionsQueued) return
    this.subscriptionsQueued = true
    const generation = this.generation
    queueMicrotask(() => {
      if (generation !== this.generation) return
      this.subscriptionsQueued = false
      if (!this.handle || this.destroyed) return
      void this.ipc.invoke(IPC.SUBSCRIBE, this.handle, [...this.listeners.keys()]).then(unwrap).catch(error => { if (generation === this.generation) this.fail(error) })
    })
  }
  on(channel: string, callback: (...args: any[]) => void): () => void {
    if (this.destroyed) return () => {}
    if (!knownChannels.has(channel) && channel !== '__transport:reconnected') throw new Error('Unknown remote event channel')
    let callbacks = this.listeners.get(channel)
    if (!callbacks) { callbacks = new Set(); this.listeners.set(channel, callbacks) }
    callbacks.add(callback); this.scheduleSubscriptions()
    return () => {
      callbacks!.delete(callback)
      if (!callbacks!.size) this.listeners.delete(channel)
      this.scheduleSubscriptions()
    }
  }
  handleCapability(channel: string, handler: (...args: any[]) => Promise<any> | any): void {
    if (!knownCapabilities.has(channel)) throw new Error('Unknown client capability')
    if (!this.destroyed) this.capabilities.set(channel, handler)
  }
  isChannelAvailable(channel: string): boolean { return knownChannels.has(channel) && (!this.available || this.available.has(channel)) }
  getConnectionState(): TransportConnectionState { return structuredClone(this.state) }
  onConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void {
    if (this.destroyed) return () => {}
    this.stateListeners.add(callback); callback(this.getConnectionState())
    return () => { this.stateListeners.delete(callback) }
  }
  reconnectNow(): void {
    if (this.destroyed || this.reconnectOperation) return
    const generation = this.generation
    this.setState({ ...this.state, status: 'reconnecting', nextRetryInMs: undefined, updatedAt: Date.now() })
    const attempt = this.ensureOpen().then(async () => { if (this.handle && !this.destroyed && generation === this.generation) unwrap(await this.ipc.invoke(IPC.RECONNECT, this.handle)) })
    this.reconnectOperation = attempt
    void attempt.then(() => { if (this.reconnectOperation === attempt) this.reconnectOperation = null }, error => {
      if (this.reconnectOperation === attempt) this.reconnectOperation = null
      if (generation === this.generation) this.fail(error)
    })
  }
  emitReconnected(isStale: boolean): void {
    if (this.destroyed) return
    for (const callback of this.listeners.get('__transport:reconnected') ?? []) { try { callback(isStale) } catch { /* isolate callbacks */ } }
  }
  getRemoteWorkspaceId(): string | undefined { return this.remoteWorkspaceId }
  get isConnected(): boolean { return !this.destroyed && this.state.status === 'connected' }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.generation++
    this.ipc.removeListener(IPC.EVENT, this.receive)
    const handle = this.handle; this.handle = null
    this.state = { ...this.state, status: 'disconnected', updatedAt: Date.now() }
    this.listeners.clear(); this.capabilities.clear(); this.stateListeners.clear()
    if (handle) void this.ipc.invoke(IPC.DESTROY, handle).catch(() => {})
  }
}
