import WebSocket from 'ws'
import { CLOUD_DIRECT_TIMEOUT_MS, CLOUD_MAX_MESSAGE_BYTES, type CloudIceServer, type CloudSignal } from '../../../shared/src/cloud/types'
import { createNodeCloudPeer } from './peer-node'
import type { CloudPeer, CloudPeerFactory } from './peer'
import type { LocalCloudTarget } from './client'

/** One admitted connection owns one RPC socket and one optional peer.
 * Signaling loss/revocation destroys both together. */
export class CloudHostStream {
  private socket: WebSocket
  private queue: string[] = []
  private bytes = 0
  private first = true
  private closed = false
  private peer?: CloudPeer
  private timer?: ReturnType<typeof setTimeout>
  private mode: 'negotiating' | 'direct' | 'relay'
  private answerReceived = false
  private directRequested = false
  constructor(private target: LocalCloudTarget, private relay: (data: string) => void,
    private signal: (signal: CloudSignal) => void, private ended: () => void,
    iceServers?: CloudIceServer[], factory: CloudPeerFactory = createNodeCloudPeer) {
    this.mode = iceServers ? 'negotiating' : 'relay'
    this.socket = new WebSocket(target.url, { maxPayload: CLOUD_MAX_MESSAGE_BYTES, handshakeTimeout: 10_000,
      ...(target.tlsCert ? { ca: target.tlsCert, checkServerIdentity: (() => undefined) as unknown as NonNullable<WebSocket.ClientOptions['checkServerIdentity']> } : {}) })
    this.socket.on('open', () => { for (const data of this.queue) this.socket.send(data); this.queue = []; this.bytes = 0 })
    this.socket.on('message', raw => {
      if (this.closed) return
      const data = raw.toString()
      try {
        if (this.mode === 'direct') this.peer!.send(data)
        else if (this.mode === 'relay') this.relay(data)
        else throw new Error('RPC before transport selection')
      } catch { this.close() }
    })
    this.socket.on('close', () => this.close())
    this.socket.on('error', () => this.close())
    if (iceServers) {
      this.timer = setTimeout(() => this.select('relay'), CLOUD_DIRECT_TIMEOUT_MS)
      void this.startPeer(iceServers, factory).catch(() => this.select('relay'))
    }
  }
  acceptData(data: string): void {
    if (this.mode !== 'relay') { this.close(); return }
    this.local(data)
  }
  async acceptSignal(signal: CloudSignal): Promise<void> {
    if (this.closed || this.mode !== 'negotiating') return
    if (signal.action === 'select') { this.select(signal.mode); return }
    if (signal.action === 'answer' && this.peer && !this.answerReceived) {
      this.answerReceived = true
      try { await this.peer.acceptAnswer(signal.sdp) } catch { this.select('relay') }
    }
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)
    this.peer?.close(); this.peer = undefined
    this.queue = []; this.bytes = 0
    this.socket.terminate()
    this.ended()
  }
  private select(mode: 'direct' | 'relay'): void {
    if (this.closed || this.mode !== 'negotiating') return
    // The receiving peer can observe SCTP open before the offerer's DCEP ACK.
    // Keep the deadline while waiting for host admission instead of falling
    // back solely because these two events arrived in a different order.
    if (mode === 'direct' && !this.peer?.open) { this.directRequested = true; return }
    clearTimeout(this.timer)
    this.mode = mode === 'direct' && this.peer?.open ? 'direct' : 'relay'
    if (this.mode === 'relay') { this.peer?.close(); this.peer = undefined }
    this.signal({ action: 'selected', mode: this.mode })
  }
  private async startPeer(iceServers: CloudIceServer[], factory: CloudPeerFactory): Promise<void> {
    const peer = await factory({
      iceServers,
      onSignal: signal => { if (!this.closed && this.mode === 'negotiating') this.signal(signal) },
      onOpen: () => { if (this.directRequested) this.select('direct') },
      onMessage: data => { if (this.mode === 'direct') this.local(data); else this.close() },
      onClose: () => { if (this.mode === 'direct') this.close(); else this.select('relay') },
    })
    if (this.closed || this.mode !== 'negotiating') { peer.close(); return }
    this.peer = peer
    await peer.offer()
  }
  private local(data: string): void {
    if (this.closed) return
    try {
      if (Buffer.byteLength(data) > CLOUD_MAX_MESSAGE_BYTES) throw new Error('Oversized RPC message')
      if (this.first) {
        const handshake = JSON.parse(data)
        if (handshake.type !== 'handshake') throw new Error('Handshake required')
        // Local secrets stay on the host; remote callers cannot claim a local
        // Electron window or another client's replay history.
        handshake.token = this.target.token
        delete handshake.webContentsId; delete handshake.reconnectClientId; delete handshake.cloudDirect
        data = JSON.stringify(handshake)
        this.first = false
      }
      if (this.socket.bufferedAmount + this.bytes + Buffer.byteLength(data) > CLOUD_MAX_MESSAGE_BYTES) throw new Error('Local socket capacity exceeded')
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(data)
      else if (this.socket.readyState === WebSocket.CONNECTING) { this.queue.push(data); this.bytes += Buffer.byteLength(data) }
      else this.close()
    } catch { this.close() }
  }
}
