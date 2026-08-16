/**
 * WeCom adapter tests — fake-socket driven, no network.
 *
 * The fake socket plays the server side: it answers `aibot_subscribe` and
 * records every frame the adapter sends so tests can assert on the exact
 * wire commands. Inbound callbacks are pushed through `server.push(frame)`.
 */

import { describe, expect, test } from 'bun:test'
import { createCipheriv } from 'node:crypto'
import {
  WeComAdapter,
  type WeComSocketLike,
  type WeComSocketFactory,
} from '../index'
import {
  WECOM_MAX_CONTENT_BYTES,
  decryptMediaBlob,
  parseWeComCredentials,
  stripMentionPrefix,
  truncateUtf8,
} from '../protocol'
import type { IncomingMessage } from '../../../types'

const CREDS = JSON.stringify({ botId: 'bot-123', secret: 'secret-abc' })

interface SentFrame {
  cmd: string
  headers: { req_id?: string }
  body: Record<string, unknown>
}

class FakeSocket implements WeComSocketLike {
  readyState = 1
  onopen: ((event?: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null
  onerror: ((event?: unknown) => void) | null = null

  sent: SentFrame[] = []
  closed = false
  private open = false

  send(data: string | Buffer): void {
    const frame = JSON.parse(data.toString()) as SentFrame
    this.sent.push(frame)
    const server = this.server
    void Promise.resolve().then(() => server.answer(this, frame))
  }

  close(code?: number, reason?: string): void {
    this.closed = true
    this.open = false
  }

  terminate(): void {
    this.closed = true
    this.open = false
  }

  /** Server-side: open the connection. */
  accept(): void {
    this.open = true
    this.onopen?.()
  }

  /** Server-side: push an inbound frame to the adapter. */
  push(frame: SentFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  /** Server-side: simulate a socket drop. */
  drop(code = 1006, reason = ''): void {
    this.open = false
    this.onclose?.({ code, reason })
  }

  constructor(private readonly server: FakeServer) {}
}

class FakeServer {
  sockets: FakeSocket[] = []
  /** Subscribe errcode to answer with. */
  subscribeResult: { errcode: number; errmsg: string } = { errcode: 0, errmsg: 'ok' }
  /** Intercept a command to inspect/influence the answer. */
  onCommand?: (frame: SentFrame) => SentFrame | null

  createSocket = (): WeComSocketLike => {
    const socket = new FakeSocket(this)
    this.sockets.push(socket)
    // The adapter assigns handlers synchronously in connect(); accept on
    // the next tick so `onopen` is set.
    setTimeout(() => socket.accept(), 0)
    return socket
  }

  answer(socket: FakeSocket, frame: SentFrame): void {
    const override = this.onCommand?.(frame)
    if (override === null) return
    const f = override ?? frame

    switch (f.cmd) {
      case 'aibot_subscribe':
        this.reply(socket, f, this.subscribeResult)
        return
      case 'aibot_upload_media_init':
        this.reply(socket, f, { errcode: 0, errmsg: 'ok', body: { upload_id: 'up-1' } })
        return
      case 'aibot_upload_media_chunk':
        this.reply(socket, f, { errcode: 0, errmsg: 'ok' })
        return
      case 'aibot_upload_media_finish':
        this.reply(socket, f, { errcode: 0, errmsg: 'ok', body: { type: 'file', media_id: 'media-1' } })
        return
      default:
        this.reply(socket, f, { errcode: 0, errmsg: 'ok' })
    }
  }

  private reply(socket: FakeSocket, request: SentFrame, result: { errcode: number; errmsg: string; body?: unknown }): void {
    if (!request.headers?.req_id) return
    socket.push({
      cmd: request.cmd,
      headers: { req_id: request.headers.req_id },
      body: result.body as Record<string, unknown>,
      errcode: result.errcode,
      errmsg: result.errmsg,
    } as never)
  }

  /** All frames sent by the adapter so far. */
  get frames(): SentFrame[] {
    return this.sockets.flatMap((s) => s.sent)
  }
}

function makeServer(): FakeServer {
  return new FakeServer()
}

function textCallback(overrides: Record<string, unknown> = {}): SentFrame {
  return {
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'req-msg-1' },
    body: {
      msgid: 'msg-1',
      aibotid: 'bot-123',
      chattype: 'single',
      from: { userid: 'user-1' },
      msgtype: 'text',
      text: { content: 'hello' },
      ...overrides,
    },
  }
}

async function connectedAdapter(server: FakeServer): Promise<WeComAdapter> {
  const factory: WeComSocketFactory = () => server.createSocket()
  const adapter = new WeComAdapter(factory, { reconnectBaseDelayMs: 5 })
  await adapter.initialize({ token: CREDS })
  return adapter
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

describe('WeComAdapter connection', () => {
  test('subscribes with BotID + Secret and reports connected', async () => {
    const server = makeServer()
    const adapter = await connectedAdapter(server)

    expect(adapter.isConnected()).toBe(true)
    const subscribe = server.frames.find((f) => f.cmd === 'aibot_subscribe')
    expect(subscribe?.body).toEqual({ bot_id: 'bot-123', secret: 'secret-abc' })
    expect(adapter.capabilities.markdown).toBe('wecom-markdown')
    expect(adapter.capabilities.messageEditing).toBe(true)
    expect(adapter.capabilities.inlineButtons).toBe(false)

    await adapter.destroy()
  })

  test('rejects bad credentials and does not reconnect', async () => {
    const server = makeServer()
    server.subscribeResult = { errcode: 301023, errmsg: 'invalid secret' }

    const states: boolean[] = []
    const adapter = new WeComAdapter(() => server.createSocket(), { reconnectBaseDelayMs: 5 })
    const promise = adapter.initialize({
      token: CREDS,
      onWeComStateChange: (s) => states.push(s.connected),
    })
    await expect(promise).rejects.toThrow(/invalid secret/)

    // Give any bogus reconnect a chance to fire.
    await Bun.sleep(50)
    expect(server.sockets.length).toBe(1)
    expect(states[states.length - 1]).toBe(false)
  })

  test('reconnects after an unexpected close', async () => {
    const server = makeServer()
    const factory: WeComSocketFactory = () => server.createSocket()
    // Longer delay so the intermediate disconnected state is observable.
    const adapter = new WeComAdapter(factory, { reconnectBaseDelayMs: 200 })
    await adapter.initialize({ token: CREDS })

    server.sockets[0]!.drop(1006, 'network')
    await Bun.sleep(50)
    expect(adapter.isConnected()).toBe(false)

    await Bun.sleep(400)
    expect(server.sockets.length).toBeGreaterThanOrEqual(2)
    // Second socket subscribes again.
    const subscribeCount = server.frames.filter((f) => f.cmd === 'aibot_subscribe').length
    expect(subscribeCount).toBeGreaterThanOrEqual(2)
    expect(adapter.isConnected()).toBe(true)

    await adapter.destroy()
  })
})

// ---------------------------------------------------------------------------
// Inbound routing
// ---------------------------------------------------------------------------

describe('WeComAdapter inbound', () => {
  test('routes single-chat text with the userid as channelId', async () => {
    const server = makeServer()
    const adapter = await connectedAdapter(server)

    const messages: IncomingMessage[] = []
    adapter.onMessage(async (m) => {
      messages.push(m)
    })

    server.sockets[0]!.push(textCallback())

    await Bun.sleep(10)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.platform).toBe('wecom')
    expect(messages[0]!.channelId).toBe('user-1')
    expect(messages[0]!.senderId).toBe('user-1')
    expect(messages[0]!.text).toBe('hello')

    await adapter.destroy()
  })

  test('routes group text with chatid as channelId and strips the mention', async () => {
    const server = makeServer()
    const adapter = await connectedAdapter(server)

    const messages: IncomingMessage[] = []
    adapter.onMessage(async (m) => {
      messages.push(m)
    })

    server.sockets[0]!.push(
      textCallback({
        msgid: 'msg-2',
        chattype: 'group',
        chatid: 'group-9',
        text: { content: '@RobotA 你好' },
      }),
    )

    await Bun.sleep(10)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.channelId).toBe('group-9')
    expect(messages[0]!.text).toBe('你好')

    await adapter.destroy()
  })

  test('dedupes repeat callbacks by msgid', async () => {
    const server = makeServer()
    const adapter = await connectedAdapter(server)

    let count = 0
    adapter.onMessage(async () => {
      count += 1
    })

    const socket = server.sockets[0]!
    socket.push(textCallback())
    socket.push(textCallback())

    await Bun.sleep(10)
    expect(count).toBe(1)

    await adapter.destroy()
  })
})

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

describe('WeComAdapter outbound', () => {
  test('sendText replies with an unfinished stream keyed to the callback req_id', async () => {
    const server = makeServer()
    const adapter = await connectedAdapter(server)
    adapter.onMessage(async () => {})

    server.sockets[0]!.push(textCallback())
    await Bun.sleep(10)

    const sent = await adapter.sendText('user-1', 'hi there')
    expect(sent.messageId).toMatch(/^stream_/)

    const respond = server.frames.find((f) => f.cmd === 'aibot_respond_msg')
    expect(respond?.headers.req_id).toBe('req-msg-1')
    expect(respond?.body.msgtype).toBe('stream')
    const stream = respond?.body.stream as { id: string; finish: boolean; content: string }
    expect(stream.id).toBe(sent.messageId)
    expect(stream.finish).toBe(false)
    expect(stream.content).toBe('hi there')

    await adapter.destroy()
  })

  test('editMessage refreshes the stream with finish=false', async () => {
    const server = makeServer()
    const adapter = await connectedAdapter(server)
    adapter.onMessage(async () => {})

    server.sockets[0]!.push(textCallback())
    await Bun.sleep(10)

    const sent = await adapter.sendText('user-1', 'thinking…')
    await adapter.editMessage('user-1', sent.messageId, 'final answer')

    const edits = server.frames.filter(
      (f) => f.cmd === 'aibot_respond_msg' && (f.body.stream as { id: string }).id === sent.messageId,
    )
    expect(edits).toHaveLength(2)
    const last = edits[1]!.body.stream as { id: string; finish: boolean; content: string }
    expect(last.finish).toBe(false)
    expect(last.content).toBe('final answer')
    // Every edit reuses the original callback req_id.
    expect(edits.every((f) => f.headers.req_id === 'req-msg-1')).toBe(true)

    await adapter.destroy()
  })

  test('a new sendText finishes the previous unfinished stream', async () => {
    const server = makeServer()
    const adapter = await connectedAdapter(server)
    adapter.onMessage(async () => {})

    server.sockets[0]!.push(textCallback())
    await Bun.sleep(10)

    const first = await adapter.sendText('user-1', 'one')
    await adapter.sendText('user-1', 'two')

    const frames = server.frames.filter((f) => f.cmd === 'aibot_respond_msg')
    const finishingFirst = frames.find(
      (f) => (f.body.stream as { id: string }).id === first.messageId && (f.body.stream as { finish: boolean }).finish,
    )
    expect(finishingFirst).toBeDefined()

    await adapter.destroy()
  })

  test('sendText without a recent callback pushes a proactive markdown', async () => {
    const server = makeServer()
    const adapter = await connectedAdapter(server)

    const sent = await adapter.sendText('user-1', 'proactive')
    expect(sent.messageId).toBe('')

    const pushed = server.frames.find((f) => f.cmd === 'aibot_send_msg')
    expect(pushed?.body.chatid).toBe('user-1')
    expect(pushed?.body.msgtype).toBe('markdown')
    expect((pushed?.body.markdown as { content: string }).content).toBe('proactive')

    await adapter.destroy()
  })

  test('sendFile uploads in three steps and responds with a file message', async () => {
    const server = makeServer()
    const adapter = await connectedAdapter(server)
    adapter.onMessage(async () => {})

    server.sockets[0]!.push(textCallback())
    await Bun.sleep(10)

    const payload = Buffer.from('hello world')
    const sent = await adapter.sendFile('user-1', payload, 'hello.txt', 'here is the file')

    const cmds = server.frames.map((f) => f.cmd)
    expect(cmds).toContain('aibot_upload_media_init')
    expect(cmds).toContain('aibot_upload_media_chunk')
    expect(cmds).toContain('aibot_upload_media_finish')
    expect(cmds).toContain('aibot_respond_msg')

    const fileFrame = server.frames.find(
      (f) => f.cmd === 'aibot_respond_msg' && f.body.msgtype === 'file',
    )
    expect(fileFrame?.body.file).toEqual({ media_id: 'media-1' })
    expect(sent.messageId).toMatch(/^stream_/)

    await adapter.destroy()
  })
})

// ---------------------------------------------------------------------------
// Protocol helpers
// ---------------------------------------------------------------------------

describe('wecom protocol helpers', () => {
  test('parseWeComCredentials accepts JSON and rejects junk', () => {
    expect(parseWeComCredentials(CREDS)).toEqual({ botId: 'bot-123', secret: 'secret-abc' })
    expect(() => parseWeComCredentials(undefined)).toThrow(/missing/)
    expect(() => parseWeComCredentials('{')).toThrow(/not valid JSON/)
    expect(() => parseWeComCredentials('{"botId":"b"}')).toThrow(/secret/)
    expect(() => parseWeComCredentials('{"secret":"s"}')).toThrow(/botId/)
  })

  test('stripMentionPrefix removes a leading @mention', () => {
    expect(stripMentionPrefix('@RobotA hello robot')).toBe('hello robot')
    expect(stripMentionPrefix('no mention here')).toBe('no mention here')
  })

  test('truncateUtf8 cuts on UTF-8 boundaries under the byte cap', () => {
    const long = '中'.repeat(10000)
    const out = truncateUtf8(long, WECOM_MAX_CONTENT_BYTES)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(WECOM_MAX_CONTENT_BYTES)
    expect(truncateUtf8('short', 1024)).toBe('short')
  })

  test('decryptMediaBlob round-trips AES-256-CBC with PKCS#7', () => {
    const key = Buffer.from('0123456789abcdef0123456789abcdef') // 32 bytes
    const iv = key.subarray(0, 16)
    const cipher = createCipheriv('aes-256-cbc', key, iv)
    const plain = Buffer.from('secret image bytes, padded to block size!')
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])

    // aeskey given as base64 of the key material
    const aeskey = key.toString('base64')
    expect(decryptMediaBlob(encrypted, aeskey).toString('utf8')).toBe(plain.toString('utf8'))

    // aeskey given as raw string
    const rawKey = key.toString('utf8')
    expect(decryptMediaBlob(encrypted, rawKey).toString('utf8')).toBe(plain.toString('utf8'))
  })
})
