import { CloudPeerFraming, type CloudPeer, type CloudPeerFactory } from './peer'
import type { CloudIceServer } from '../../../shared/src/cloud/types'

// Structural browser types avoid adding DOM globals to Node/Bun consumers.
interface BrowserChannel {
  label: string; ordered: boolean; readyState: string; bufferedAmount: number
  onopen: (() => void) | null; onclose: (() => void) | null; onerror: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  send(data: string): void; close(): void
}
interface BrowserPeer {
  ondatachannel: ((event: { channel: BrowserChannel }) => void) | null
  onconnectionstatechange: (() => void) | null
  connectionState: string; iceGatheringState: string; localDescription: { sdp: string } | null
  setRemoteDescription(description: { type: 'offer'; sdp: string }): Promise<void>
  createAnswer(): Promise<{ type: 'answer'; sdp?: string }>
  setLocalDescription(description: { type: 'answer'; sdp?: string }): Promise<void>
  addEventListener(name: string, listener: () => void): void
  removeEventListener(name: string, listener: () => void): void
  close(): void
}
const browserConstructor = () => (globalThis as unknown as { RTCPeerConnection?: new (options: { iceServers: CloudIceServer[] }) => BrowserPeer }).RTCPeerConnection
export const hasBrowserCloudPeer = () => typeof browserConstructor() === 'function'

// Keep the Node-only WebRTC dependency out of browser and preload bundles.
export const createBrowserCloudPeer: CloudPeerFactory = async events => {
  const Constructor = browserConstructor()
  if (!Constructor) throw new Error('Browser direct transport unavailable')
  const pc = new Constructor({ iceServers: events.iceServers })
  let channel: BrowserChannel | undefined
  let framing: CloudPeerFraming | undefined
  let closed = false
  const fail = () => { if (!closed) { peer.close(); events.onClose() } }
  pc.ondatachannel = event => {
    if (channel || event.channel.label !== 'tokenbird-rpc' || !event.channel.ordered) { event.channel.close(); return }
    channel = event.channel
    framing = new CloudPeerFraming(channel, events.onMessage, fail)
    channel.onopen = () => { if (!closed) events.onOpen() }
    channel.onmessage = event => { if (typeof event.data === 'string') framing?.accept(event.data); else fail() }
    channel.onclose = fail
    channel.onerror = fail
  }
  pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) fail() }
  const peer: CloudPeer = {
    get open() { return !closed && channel?.readyState === 'open' },
    get bufferedAmount() { return framing?.bufferedAmount ?? 0 },
    async offer() { throw new Error('Browser cloud peers answer host offers') },
    async answer(sdp) {
      await pc.setRemoteDescription({ type: 'offer', sdp })
      await pc.setLocalDescription(await pc.createAnswer())
      // Send a complete SDP; ICE checking runs concurrently after the answer.
      if (pc.iceGatheringState !== 'complete' && !closed) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', changed); resolve() }
        const changed = () => { if (pc.iceGatheringState === 'complete' || closed) finish() }
        const timer = setTimeout(finish, 2500)
        pc.addEventListener('icegatheringstatechange', changed)
      })
      if (!closed && pc.localDescription) events.onSignal({ action: 'answer', sdp: pc.localDescription.sdp })
    },
    async acceptAnswer() { throw new Error('Unexpected answer') },
    send(data) { if (!peer.open || !framing) throw new Error('Direct channel closed'); framing.send(data) },
    close() { if (closed) return; closed = true; framing?.close(); pc.close() },
  }
  return peer
}
