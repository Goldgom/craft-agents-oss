import { CLOUD_MAX_MESSAGE_BYTES, type CloudIceServer } from '../../../shared/src/cloud/types'

export interface CloudPeerEvents {
  iceServers: CloudIceServer[]
  onSignal: (description: { action: 'offer' | 'answer'; sdp: string }) => void
  onOpen: () => void
  onMessage: (data: string) => void
  onClose: () => void
}
export interface CloudPeer {
  readonly open: boolean
  readonly bufferedAmount: number
  offer(): Promise<void>
  answer(sdp: string): Promise<void>
  acceptAnswer(sdp: string): Promise<void>
  send(data: string): void
  close(): void
}
export type CloudPeerFactory = (events: CloudPeerEvents) => Promise<CloudPeer>

interface DataChannel {
  readonly readyState: string
  readonly bufferedAmount: number
  send(data: string): void
}

/** Ordered reliable SCTP fragments keep large RPC/file messages below 64 KiB.
 * Both the outbound queue and incomplete inbound message have hard bounds. */
export class CloudPeerFraming {
  private queue: string[] = []
  private queuedBytes = 0
  private incoming: string[] = []
  private incomingBytes = 0
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  constructor(private channel: DataChannel, private receive: (data: string) => void, private fail: () => void) {}
  get bufferedAmount(): number { return this.queuedBytes + this.channel.bufferedAmount }
  send(data: string): void {
    const bytes = new TextEncoder().encode(data).length
    if (this.closed || bytes > CLOUD_MAX_MESSAGE_BYTES || this.bufferedAmount + bytes > CLOUD_MAX_MESSAGE_BYTES) throw new Error('Direct channel capacity exceeded')
    // Preserve surrogate pairs while keeping each UTF-8 fragment below 32 KiB.
    let start = 0
    do {
      let end = Math.min(start + 8000, data.length)
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--
      const packet = (end === data.length ? '.' : '+') + data.slice(start, end)
      this.queue.push(packet)
      this.queuedBytes += new TextEncoder().encode(packet).length
      start = end
    } while (start < data.length)
    this.flush()
  }
  accept(packet: string): void {
    if (this.closed) return
    try {
      if (new TextEncoder().encode(packet).length > 64 * 1024) throw new Error('Oversized fragment')
      if (packet[0] !== '+' && packet[0] !== '.') throw new Error('Invalid fragment')
      const data = packet.slice(1)
      // Count fragments as well as data to reject an endless empty-fragment stream.
      this.incomingBytes += new TextEncoder().encode(data).length
      if (this.incomingBytes > CLOUD_MAX_MESSAGE_BYTES || this.incoming.length >= 4096) throw new Error('Oversized message')
      this.incoming.push(data)
      if (packet[0] === '.') {
        const data = this.incoming.join('')
        this.incoming = []; this.incomingBytes = 0
        this.receive(data)
      }
    } catch { this.close(); this.fail() }
  }
  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    this.queue = []; this.incoming = []; this.queuedBytes = 0; this.incomingBytes = 0
  }
  private flush(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.closed) return
    try {
      while (this.queue.length && this.channel.readyState === 'open' && this.channel.bufferedAmount < 512 * 1024) {
        const packet = this.queue.shift()!
        this.queuedBytes -= new TextEncoder().encode(packet).length
        this.channel.send(packet)
      }
      if (this.queue.length) this.timer = setTimeout(() => this.flush(), 10)
    } catch { this.close(); this.fail() }
  }
}
