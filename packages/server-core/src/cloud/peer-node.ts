import type { CloudPeer, CloudPeerFactory } from './peer'
import { CloudPeerFraming } from './peer'

/** Pure JS WebRTC implementation, bundled with Bun and Electron main. */
export const createNodeCloudPeer: CloudPeerFactory = async events => {
  // Initialize x509's DI metadata before the WebRTC graph is loaded. Explicit
  // ordering also survives Bun executable and Electron CJS bundling.
  await import('reflect-metadata')
  const { RTCPeerConnection } = await import('werift')
  const pc = new RTCPeerConnection({ iceServers: events.iceServers, iceUseIpv6: true, iceUseTcp: false, iceTcpPassive: false, iceStunGatherTimeout: 2 })
  let channel: ReturnType<typeof pc.createDataChannel> | undefined
  let framing: CloudPeerFraming | undefined
  let closed = false
  const fail = () => { if (!closed) { peer.close(); events.onClose() } }
  const attach = (next: NonNullable<typeof channel>) => {
    if (channel || next.label !== 'tokenbird-rpc' || !next.ordered) { next.close(); return }
    channel = next
    framing = new CloudPeerFraming(next, events.onMessage, fail)
    next.onMessage.subscribe(data => { if (typeof data === 'string') framing?.accept(data); else fail() })
    next.stateChanged.subscribe(state => {
      if (closed) return
      if (state === 'open') events.onOpen()
      else if (state === 'closed') fail()
    })
  }
  pc.onDataChannel.subscribe(attach)
  pc.connectionStateChange.subscribe(state => { if (state === 'failed' || state === 'closed' || state === 'disconnected') fail() })
  const describe = async (action: 'offer' | 'answer') => {
    const description = action === 'offer' ? await pc.createOffer() : await pc.createAnswer()
    await pc.setLocalDescription(description)
    if (!closed && pc.localDescription) events.onSignal({ action, sdp: pc.localDescription.sdp })
  }
  const peer: CloudPeer = {
    get open() { return !closed && channel?.readyState === 'open' },
    get bufferedAmount() { return framing?.bufferedAmount ?? 0 },
    async offer() { attach(pc.createDataChannel('tokenbird-rpc', { ordered: true })); await describe('offer') },
    async answer(sdp) { await pc.setRemoteDescription({ type: 'offer', sdp }); await describe('answer') },
    async acceptAnswer(sdp) { await pc.setRemoteDescription({ type: 'answer', sdp }) },
    send(data) { if (!peer.open || !framing) throw new Error('Direct channel closed'); framing.send(data) },
    close() { if (closed) return; closed = true; framing?.close(); void pc.close().catch(() => {}) },
  }
  return peer
}
