import { CLOUD_DIRECT_TIMEOUT_MS, isCloudSignal, type CloudDataPath, type CloudSignal } from '../../../shared/src/cloud/types'
import type { CloudPeer, CloudPeerFactory } from './peer'

export function isCloudConnectUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'wss:' || (url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      && /^\/v1\/connect\/[a-f0-9-]{36}$/.test(url.pathname)
  } catch { return false }
}

/** WebSocket-shaped RPC connection. Selection happens before the local RPC
 * handshake, so fallback never replays a request or opens a second session.
 * The authenticated signaling socket stays open throughout direct access;
 * losing it closes the peer immediately, including on revocation. */
export class CloudSocket {
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  onopen: WebSocket['onopen'] = null
  onmessage: WebSocket['onmessage'] = null
  onclose: WebSocket['onclose'] = null
  onerror: WebSocket['onerror'] = null
  private peer?: CloudPeer
  private handshake?: string
  private first = true
  private selected?: CloudDataPath
  private selecting = false
  private initializing = false
  private timer?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private disposed = false
  constructor(private raw: WebSocket, private factory: CloudPeerFactory, private path: (mode: CloudDataPath) => void, private directFailed: () => void) {
    raw.onopen = event => this.onopen?.call(this as unknown as WebSocket, event)
    raw.onerror = event => this.onerror?.call(this as unknown as WebSocket, event)
    raw.onclose = event => { this.dispose(); this.onclose?.call(this as unknown as WebSocket, event) }
    raw.onmessage = event => {
      try {
        const data = typeof event.data === 'string' ? event.data : event.data.toString()
        const message = JSON.parse(data)
        if (message.type === 'cloud_transport') {
          if (!isCloudSignal(message.signal)) throw new Error('Invalid cloud signal')
          void this.signal(message.signal).catch(() => this.fallback())
          return
        }
        // Old cloud/host versions forward the original handshake normally.
        if (!this.selected && this.handshake) { this.handshake = undefined; this.commit('relay') }
        if (this.selected === 'direct') throw new Error('Unexpected relay data')
        this.onmessage?.call(this as unknown as WebSocket, event)
      } catch { this.close(4000, 'Invalid cloud transport message') }
    }
  }
  get readyState(): number { return this.raw.readyState }
  get bufferedAmount(): number { return this.selected === 'direct' ? this.peer?.bufferedAmount ?? 0 : this.raw.bufferedAmount }
  send(data: string): void {
    if (this.disposed || this.raw.readyState !== this.OPEN) throw new Error('Cloud connection closed')
    if (this.first) {
      this.first = false
      const handshake = JSON.parse(data)
      if (handshake.type !== 'handshake') throw new Error('Handshake required')
      this.handshake = data
      this.raw.send(JSON.stringify({ ...handshake, cloudDirect: true }))
      this.timer = setTimeout(() => this.fallback(), CLOUD_DIRECT_TIMEOUT_MS)
      return
    }
    if (!this.selected) throw new Error('Cloud transport selection pending')
    if (this.selected === 'direct') this.peer!.send(data)
    else this.raw.send(data)
  }
  close(code?: number, reason?: string): void { this.dispose(); this.raw.close(code, reason) }
  private dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.timer); clearInterval(this.heartbeat)
    this.peer?.close(); this.peer = undefined; this.handshake = undefined
  }
  private control(signal: CloudSignal): void {
    if (!this.disposed && this.raw.readyState === this.OPEN) this.raw.send(JSON.stringify({ type: 'cloud_transport', signal }))
  }
  private fallback(): void {
    if (this.disposed || this.selected) return
    clearTimeout(this.timer)
    this.directFailed()
    this.peer?.close(); this.peer = undefined
    this.selecting = true
    this.control({ action: 'select', mode: 'relay' })
  }
  private commit(mode: CloudDataPath): void {
    if (this.disposed || this.selected) return
    clearTimeout(this.timer)
    this.selected = mode
    this.path(mode)
    if (mode === 'relay') { this.peer?.close(); this.peer = undefined }
    this.heartbeat = setInterval(() => this.control({ action: 'keepalive' }), 20_000)
  }
  private async signal(signal: CloudSignal): Promise<void> {
    if (this.disposed) return
    if (signal.action === 'keepalive_ack') return
    if (signal.action === 'negotiate') {
      if (this.initializing || this.selected || this.selecting) return
      this.initializing = true
      const peer = await this.factory({
        iceServers: signal.iceServers,
        onSignal: description => this.control(description),
        onOpen: () => { if (!this.selecting && !this.selected && !this.disposed) { this.selecting = true; this.control({ action: 'select', mode: 'direct' }) } },
        onMessage: data => { if (!this.disposed && this.selected === 'direct') this.onmessage?.call(this as unknown as WebSocket, { data } as MessageEvent) },
        onClose: () => {
          this.directFailed()
          if (this.selected === 'direct') this.close(4000, 'Direct connection lost')
          else this.fallback()
        },
      })
      if (this.disposed || this.selected || this.selecting) { peer.close(); return }
      this.peer = peer
      return
    }
    if (signal.action === 'offer') {
      // An offer can arrive while the asynchronous Node factory is loading.
      if (!this.peer && this.initializing && !this.selecting) {
        await new Promise<void>(resolve => setTimeout(resolve, 10))
        return this.signal(signal)
      }
      if (!this.peer || this.selected || this.selecting) return
      await this.peer.answer(signal.sdp)
      return
    }
    if (signal.action === 'selected') {
      if (this.selected) return
      if (signal.mode === 'direct' && !this.peer?.open) { this.directFailed(); this.close(4000, 'Direct connection unavailable'); return }
      const data = this.handshake
      this.handshake = undefined
      this.commit(signal.mode)
      if (data) { if (signal.mode === 'direct') this.peer!.send(data); else this.raw.send(data) }
      return
    }
    throw new Error('Unexpected cloud signal')
  }
}
