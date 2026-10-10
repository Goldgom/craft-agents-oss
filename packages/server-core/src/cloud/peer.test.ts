import { expect, test } from 'bun:test'
import { CloudPeerFraming } from './peer'
import { CLOUD_MAX_MESSAGE_BYTES, validateCloudIceServers } from '../../../shared/src/cloud/types'
import { CloudHostStream } from './host-stream'
import { WsRpcServer } from '../transport/server'
import type { CloudPeerEvents } from './peer'

test('fragments preserve UTF-8 around boundaries and reject malformed/oversized messages', () => {
  const packets: string[] = [], messages: string[] = []
  let failed = 0
  const channel = { readyState: 'open', bufferedAmount: 0, send: (data: string) => { packets.push(data) } }
  const sender = new CloudPeerFraming(channel, () => {}, () => { failed++ })
  const receiver = new CloudPeerFraming(channel, data => messages.push(data), () => { failed++ })
  const message = 'x'.repeat(7999) + '🙂汉字'.repeat(20_000) + '\\"'
  sender.send(message)
  for (const packet of packets) { expect(Buffer.byteLength(packet)).toBeLessThan(64 * 1024); receiver.accept(Buffer.from(packet).toString('utf8')) }
  expect(messages).toEqual([message]); expect(failed).toBe(0)
  expect(() => sender.send('x'.repeat(CLOUD_MAX_MESSAGE_BYTES + 1))).toThrow()
  receiver.accept('invalid-fragment'); expect(failed).toBe(1)
  sender.close(); receiver.close()
})

test('bounded send queue waits for buffered channel data to drain', async () => {
  const sent: string[] = []
  const channel = { readyState: 'open', bufferedAmount: 1024 * 1024, send: (data: string) => { sent.push(data) } }
  const framing = new CloudPeerFraming(channel, () => {}, () => {})
  framing.send('queued')
  expect(sent).toHaveLength(0)
  channel.bufferedAmount = 0
  await Bun.sleep(30)
  expect(sent).toEqual(['.queued'])
  framing.close()
})

test('STUN configuration accepts an empty list and excludes credentials/TURN/HTTP URLs', () => {
  expect(validateCloudIceServers([])).toBe(true)
  expect(validateCloudIceServers([{ urls: 'stun:stun.cloudflare.com:3478' }])).toBe(true)
  expect(validateCloudIceServers([{ urls: 'stun:host:3478', username: 'secret' }])).toBe(false)
  for (const urls of ['turn:relay.example:3478', 'https://example.test', 'stun:user:secret@example.test', 'stun:host/path']) {
    expect(validateCloudIceServers([{ urls }])).toBe(false)
  }
})

test('host waits for its DataChannel admission when client selection arrives before the DCEP acknowledgment', async () => {
  const rpc = new WsRpcServer({ host: '127.0.0.1', port: 0 })
  await rpc.listen()
  let events: CloudPeerEvents | undefined
  let open = false
  const signals: unknown[] = []
  const stream = new CloudHostStream({ url: `ws://127.0.0.1:${rpc.port}`, token: 'test' }, () => {}, signal => signals.push(signal), () => {}, [], async callbacks => {
    events = callbacks
    return { get open() { return open }, bufferedAmount: 0, offer: async () => {}, answer: async () => {}, acceptAnswer: async () => {}, send: () => {}, close: () => {} }
  })
  try {
    await Bun.sleep(10)
    await stream.acceptSignal({ action: 'select', mode: 'direct' })
    expect(signals).toHaveLength(0)
    open = true; events!.onOpen()
    expect(signals).toEqual([{ action: 'selected', mode: 'direct' }])
  } finally { stream.close(); await rpc.close() }
})
