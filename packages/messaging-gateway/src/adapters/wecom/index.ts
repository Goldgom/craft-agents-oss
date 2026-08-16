/**
 * WeComAdapter — 企业微信 smart-robot long-connection adapter.
 *
 * Transport: outbound WebSocket to `wss://openws.work.weixin.qq.com` (the
 * official aibot long-connection endpoint). No public URL, no payload
 * encryption to manage — the same "works behind NAT / in Electron" profile
 * as the Lark adapter, but against a raw WebSocket instead of an SDK.
 *
 * Protocol highlights (see `protocol.ts` and the official docs at
 * https://developer.work.weixin.qq.com/document/path/101463):
 *   - `aibot_subscribe` authenticates with BotID + Secret.
 *   - `ping` every 30s keeps the connection alive.
 *   - `aibot_msg_callback` delivers user messages; `aibot_respond_msg`
 *     replies. Stream replies (`stream` msgtype, same `stream.id`, same
 *     callback `req_id`) give us native message editing — a perfect fit for
 *     the gateway renderer's progress-bubble mode.
 *   - `aibot_send_msg` proactively pushes markdown when there is no recent
 *     callback to respond to.
 *   - `aibot_upload_media_{init,chunk,finish}` uploads files for
 *     `sendFile`.
 *
 * Inline buttons / template cards are NOT implemented (phase 1) —
 * `capabilities.inlineButtons` is `false` so the gateway routes permission
 * and plan prompts through the plain-text fallbacks.
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type {
  PlatformAdapter,
  PlatformConfig,
  AdapterCapabilities,
  IncomingAttachment,
  IncomingMessage,
  SentMessage,
  InlineButton,
  ButtonPress,
  MessagingLogger,
  SendOptions,
} from '../../types'
import {
  WECOM_WS_URL,
  WECOM_MAX_CONTENT_BYTES,
  WECOM_CHUNK_MAX_BYTES,
  parseWeComCredentials,
  type WeComCredentials,
  type WeComFrame,
  type WeComMessageCallback,
  type WeComEventCallback,
  resolveChannelId,
  resolveChatType,
  stripMentionPrefix,
  truncateUtf8,
  decryptMediaBlob,
  md5Hex,
  makeReqId,
  makeStreamId,
} from './protocol'

export { parseWeComCredentials, type WeComCredentials } from './protocol'

/** Hard cap for downloaded attachments (matches Telegram/Lark adapters). */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

const HEARTBEAT_INTERVAL_MS = 30 * 1000
const SUBSCRIBE_TIMEOUT_MS = 10 * 1000
const COMMAND_TIMEOUT_MS = 10 * 1000
const RECONNECT_BASE_DELAY_MS = 1 * 1000
const RECONNECT_MAX_DELAY_MS = 30 * 1000
const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

/**
 * Minimal WebSocket projection the adapter programs against. `ws`'s
 * WebSocket satisfies it; tests inject a fake through the socket factory.
 */
export interface WeComSocketLike {
  readyState: number
  send(data: string | Buffer): void
  close(code?: number, reason?: string): void
  terminate?(): void
  onopen?: ((event?: unknown) => void) | null
  onmessage?: ((event: { data: unknown }) => void) | null
  onclose?: ((event?: { code?: number; reason?: string }) => void) | null
  onerror?: ((event?: unknown) => void) | null
}

export type WeComSocketFactory = (url: string) => WeComSocketLike

const defaultSocketFactory: WeComSocketFactory = (url) =>
  new WebSocket(url) as unknown as WeComSocketLike

/** Tuning knobs — only `reconnectBaseDelayMs` matters outside tests. */
export interface WeComAdapterOptions {
  reconnectBaseDelayMs?: number
}

/**
 * Called when the connection state changes after `initialize()` — lets the
 * registry keep the Settings runtime badge truthful across drops/reconnects.
 */
export type WeComStateListener = (state: { connected: boolean; lastError?: string }) => void

interface PendingResponse {
  resolve: (frame: WeComFrame) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface StreamRecord {
  reqId: string
  channelId: string
  finished: boolean
  lastContent: string
}

/** Per-channel proactive-send context captured from callbacks. */
interface ChannelContext {
  chatType: 0 | 1 | 2
  lastReqId?: string
}

export class WeComAdapter implements PlatformAdapter {
  readonly platform = 'wecom' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: true,
    inlineButtons: false,
    maxButtons: 0,
    maxMessageLength: WECOM_MAX_CONTENT_BYTES,
    markdown: 'wecom-markdown',
    webhookSupport: false,
  }

  private readonly createSocket: WeComSocketFactory
  private readonly reconnectBaseDelayMs: number
  private socket: WeComSocketLike | null = null
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private buttonHandler: ((press: ButtonPress) => Promise<void>) | null = null
  private log: MessagingLogger = NOOP_LOGGER
  private stateListener: WeComStateListener | null = null

  private connected = false
  private destroyed = false
  private credentials: WeComCredentials | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  /** Set when the server rejected our credentials — stops reconnect loops. */
  private fatalAuthError = false

  private readonly pendingResponses = new Map<string, PendingResponse>()
  /** Live streams we created, keyed by stream id (for editMessage). */
  private readonly streams = new Map<string, StreamRecord>()
  /** Per-channel context captured from the latest callback. */
  private readonly channels = new Map<string, ChannelContext>()
  /** Recent callback msgids for dedupe. */
  private readonly recentMsgIds = new Set<string>()

  constructor(createSocket: WeComSocketFactory = defaultSocketFactory, options: WeComAdapterOptions = {}) {
    this.createSocket = createSocket
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(config: PlatformConfig): Promise<void> {
    this.log = config.logger ?? NOOP_LOGGER
    const listener = (config as { onWeComStateChange?: WeComStateListener }).onWeComStateChange
    this.stateListener = typeof listener === 'function' ? listener : null
    this.credentials = parseWeComCredentials(config.token)
    this.destroyed = false
    this.fatalAuthError = false
    await this.connect()
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref?.()
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    this.connected = false
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.rejectAllPending(new Error('Adapter destroyed'))
    this.streams.clear()
    this.channels.clear()
    this.recentMsgIds.clear()
    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        socket.close(1000, 'adapter destroyed')
      } catch {
        try {
          socket.terminate?.()
        } catch {
          // ignore
        }
      }
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onButtonPress(handler: (press: ButtonPress) => Promise<void>): void {
    this.buttonHandler = handler
  }

  // -------------------------------------------------------------------------
  // Connection internals
  // -------------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.destroyed || !this.credentials) return
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    const socket = this.createSocket(WECOM_WS_URL)
    this.socket = socket

    const subscribe = new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('Timed out waiting for WeCom subscribe response'))
      }, SUBSCRIBE_TIMEOUT_MS)
      timer.unref?.()

      socket.onopen = () => {
        // Raw send on purpose — the subscribe response is resolved by the
        // dedicated branch in `onmessage` below, NOT through the pending-
        // response map (sending it via `sendFrame` would register a pending
        // entry that swallows the response first).
        try {
          socket.send(JSON.stringify({
            cmd: 'aibot_subscribe',
            headers: { req_id: makeReqId() },
            body: {
              bot_id: this.credentials!.botId,
              secret: this.credentials!.secret,
            },
          }))
        } catch (err) {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        }
      }

      socket.onmessage = (event) => {
        const frame = this.decodeFrame(event.data)
        if (!frame) return
        if (frame.cmd === 'aibot_subscribe' || (frame.errcode !== undefined && !this.pendingResponses.has(frame.headers?.req_id ?? ''))) {
          // Subscribe response isn't correlated through `sendAndWait` —
          // resolve/reject here.
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (frame.errcode === 0) {
            resolve()
          } else {
            // Bad credentials / revoked bot — retrying won't help.
            this.fatalAuthError = true
            reject(new Error(frame.errmsg || `WeCom subscribe failed (errcode ${frame.errcode})`))
          }
          return
        }
        this.handleFrame(frame)
      }

      socket.onclose = (event) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error('WeCom socket closed before subscribe completed'))
        }
        this.handleClose(event?.code, event?.reason)
      }

      socket.onerror = () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error('WeCom socket error during subscribe'))
        }
        this.handleError()
      }
    })

    try {
      await subscribe
      this.connected = true
      this.reconnectAttempts = 0
      this.stateListener?.({ connected: true })
      this.log.info('[wecom] connected and subscribed', {
        event: 'wecom_connected',
        botId: this.credentials.botId,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.connected = false
      this.stateListener?.({ connected: false, lastError: message })
      try {
        socket.close(4000, message)
      } catch {
        // ignore
      }
      this.log.error('[wecom] connect failed', {
        event: 'wecom_connect_failed',
        error: message,
      })
      throw err
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.fatalAuthError || this.reconnectTimer) return
    const delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      this.reconnectBaseDelayMs * 2 ** this.reconnectAttempts,
    )
    this.reconnectAttempts += 1
    this.stateListener?.({
      connected: false,
      lastError: `Connection lost — retrying in ${Math.round(delay / 1000)}s`,
    })
    this.log.warn('[wecom] scheduling reconnect', {
      event: 'wecom_reconnect_scheduled',
      delayMs: delay,
      attempt: this.reconnectAttempts,
    })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect().catch(() => {
        // connect() already logs + notifies; a failed attempt re-enters
        // scheduleReconnect via handleClose/handleError.
        this.scheduleReconnect()
      })
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private handleClose(code?: number, reason?: string): void {
    this.rejectAllPending(new Error('WeCom socket closed'))
    if (this.connected || !this.destroyed) {
      this.connected = false
      this.log.warn('[wecom] socket closed', {
        event: 'wecom_socket_closed',
        code,
        reason,
      })
      if (!this.destroyed) this.scheduleReconnect()
    }
  }

  private handleError(): void {
    if (!this.destroyed) this.scheduleReconnect()
  }

  private decodeFrame(data: unknown): WeComFrame | null {
    try {
      const raw = typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('utf8')
      const parsed = JSON.parse(raw) as WeComFrame
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      this.log.warn('[wecom] dropped non-JSON frame', { event: 'wecom_frame_decode_failed' })
      return null
    }
  }

  private handleFrame(frame: WeComFrame): void {
    const reqId = frame.headers?.req_id
    if (reqId && this.pendingResponses.has(reqId)) {
      const pending = this.pendingResponses.get(reqId)!
      this.pendingResponses.delete(reqId)
      clearTimeout(pending.timer)
      pending.resolve(frame)
      return
    }

    switch (frame.cmd) {
      case 'aibot_msg_callback':
        void this.handleMessageCallback(frame as unknown as WeComMessageCallback)
        return
      case 'aibot_event_callback':
        this.handleEventCallback(frame as unknown as WeComEventCallback)
        return
      default:
        this.log.info('[wecom] unhandled frame', {
          event: 'wecom_unhandled_frame',
          cmd: frame.cmd,
        })
    }
  }

  private async handleMessageCallback(frame: WeComMessageCallback): Promise<void> {
    const body = frame.body
    if (!body) return

    // Record channel context even when no handler is wired yet so outbound
    // replies still find the callback req_id.
    const channelId = resolveChannelId(body)
    const reqId = frame.headers.req_id
    if (channelId && reqId) {
      this.channels.set(channelId, {
        chatType: resolveChatType(body),
        lastReqId: reqId,
      })
    }

    if (!this.messageHandler) return

    const msgid = body.msgid ?? `${frame.headers.req_id ?? ''}:${Date.now()}`
    if (body.msgid) {
      if (this.recentMsgIds.has(body.msgid)) return
      this.recentMsgIds.add(body.msgid)
      if (this.recentMsgIds.size > 500) {
        const oldest = this.recentMsgIds.values().next().value
        if (oldest !== undefined) this.recentMsgIds.delete(oldest)
      }
    }

    if (!channelId) return

    const senderId = body.from?.userid ?? channelId
    const msgtype = body.msgtype ?? 'text'

    let text = ''
    let attachments: IncomingAttachment[] = []

    if (msgtype === 'text' && body.text?.content) {
      text = stripMentionPrefix(body.text.content)
    } else if ((msgtype === 'voice' || msgtype === 'mixed') && body.text?.content) {
      // WeCom already converts voice to text for single chats.
      text = stripMentionPrefix(body.text.content)
    } else if (msgtype === 'image' && body.image?.url) {
      const downloaded = await this.downloadMedia(body.image.url, body.image.aeskey)
      if (downloaded) attachments.push(downloaded)
    } else if (msgtype === 'file' && body.file?.url) {
      const downloaded = await this.downloadMedia(body.file.url, body.file.aeskey)
      if (downloaded) {
        attachments.push({
          ...downloaded,
          type: 'document',
          fileName: 'file.bin',
        })
      }
    } else if (msgtype === 'video' && body.video?.url) {
      const downloaded = await this.downloadMedia(body.video.url, body.video.aeskey)
      if (downloaded) {
        attachments.push({
          ...downloaded,
          type: 'video',
          fileName: 'video.mp4',
        })
      }
    }

    if (!text && attachments.length === 0) return

    const incoming: IncomingMessage = {
      platform: 'wecom',
      channelId,
      messageId: msgid,
      senderId,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      timestamp: Date.now(),
      raw: frame,
    }
    await this.messageHandler(incoming)
  }

  private handleEventCallback(frame: WeComEventCallback): void {
    const eventtype = frame.body?.event?.eventtype
    this.log.info('[wecom] event', {
      event: 'wecom_event',
      eventtype: eventtype ?? 'unknown',
    })
    // enter_chat could carry a welcome reply; phase 1 skips it so the bot
    // never sends unsolicited messages. disconnected_event is informational
    // (the server kicked us — the socket close handler schedules reconnect).
  }

  private sendHeartbeat(): void {
    if (!this.connected || !this.socket) return
    const socket = this.socket
    void this.sendFrame(socket, {
      cmd: 'ping',
      headers: { req_id: makeReqId() },
    }).catch(() => {})
  }

  // -------------------------------------------------------------------------
  // Wire primitives
  // -------------------------------------------------------------------------

  private sendFrame(socket: WeComSocketLike, frame: WeComFrame): Promise<WeComFrame | null> {
    return new Promise((resolve, reject) => {
      try {
        socket.send(JSON.stringify(frame))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      const reqId = frame.headers?.req_id
      if (!reqId || reqId === '') {
        resolve(null)
        return
      }
      const timer = setTimeout(() => {
        this.pendingResponses.delete(reqId)
        reject(new Error(`WeCom command timed out: ${frame.cmd}`))
      }, COMMAND_TIMEOUT_MS)
      timer.unref?.()
      this.pendingResponses.set(reqId, { resolve, reject, timer })
    })
  }

  private rejectAllPending(err: Error): void {
    for (const [reqId, pending] of this.pendingResponses) {
      clearTimeout(pending.timer)
      pending.reject(err)
      this.pendingResponses.delete(reqId)
    }
  }

  private requireSocket(): WeComSocketLike {
    if (!this.socket || !this.connected) {
      throw new Error('WeCom adapter is not connected')
    }
    return this.socket
  }

  // -------------------------------------------------------------------------
  // Outbound — PlatformAdapter
  // -------------------------------------------------------------------------

  async sendText(channelId: string, text: string, _opts?: SendOptions): Promise<SentMessage> {
    const socket = this.requireSocket()
    const content = truncateUtf8(text, WECOM_MAX_CONTENT_BYTES)
    const channel = this.channels.get(channelId)

    // Prefer responding to the latest callback in this channel — the reply
    // window is 24h and WeCom renders `stream` replies with markdown. The
    // stream stays unfinished (`finish: false`) so the renderer's
    // `editMessage` updates it in place; the next send to this channel
    // closes it via `finishActiveStream`.
    if (channel?.lastReqId) {
      this.finishActiveStream(channelId)
      const streamId = makeStreamId()
      this.streams.set(streamId, {
        reqId: channel.lastReqId,
        channelId,
        finished: false,
        lastContent: content,
      })
      await this.sendFrame(socket, {
        cmd: 'aibot_respond_msg',
        headers: { req_id: channel.lastReqId },
        body: {
          msgtype: 'stream',
          stream: { id: streamId, finish: false, content },
        },
      })
      return { platform: 'wecom', channelId, messageId: streamId }
    }

    // No recent callback → proactive push. Requires the user to have
    // messaged the bot at least once in this conversation.
    await this.sendFrame(socket, {
      cmd: 'aibot_send_msg',
      headers: { req_id: makeReqId() },
      body: {
        chatid: channelId,
        chat_type: channel?.chatType ?? 0,
        msgtype: 'markdown',
        markdown: { content },
      },
    })
    return { platform: 'wecom', channelId, messageId: '' }
  }

  async editMessage(channelId: string, messageId: string, text: string, _opts?: SendOptions): Promise<void> {
    if (!messageId) {
      // Proactive-push messages can't be edited — fall back to a fresh send.
      await this.sendText(channelId, text, _opts)
      return
    }
    const record = this.streams.get(messageId)
    if (!record || record.finished) {
      // Unknown stream (e.g. reconnected) — send a fresh finished message.
      await this.sendText(channelId, text, _opts)
      return
    }
    const socket = this.requireSocket()
    const content = truncateUtf8(text, WECOM_MAX_CONTENT_BYTES)
    record.lastContent = content
    await this.sendFrame(socket, {
      cmd: 'aibot_respond_msg',
      headers: { req_id: record.reqId },
      body: {
        msgtype: 'stream',
        stream: { id: messageId, finish: false, content },
      },
    })
  }

  /** Close the previous unfinished stream in `channelId` before a new send. */
  private finishActiveStream(channelId: string): void {
    for (const [streamId, record] of this.streams) {
      if (record.channelId !== channelId || record.finished) continue
      record.finished = true
      const socket = this.socket
      if (socket && this.connected) {
        void this.sendFrame(socket, {
          cmd: 'aibot_respond_msg',
          headers: { req_id: record.reqId },
          body: {
            msgtype: 'stream',
            stream: { id: streamId, finish: true, content: record.lastContent },
          },
        }).catch(() => {})
      }
    }
  }

  async sendTyping(_channelId: string, _opts?: SendOptions): Promise<void> {
    // WeCom has no typing indicator — no-op.
  }

  async sendButtons(
    channelId: string,
    text: string,
    _buttons: InlineButton[],
    opts?: SendOptions,
  ): Promise<SentMessage> {
    // Template-card buttons aren't implemented yet; degrade to text so the
    // user always sees the message. The gateway also gates on
    // `capabilities.inlineButtons` before calling this.
    this.log.info('[wecom] sendButtons degraded to text', { event: 'wecom_buttons_degraded' })
    return this.sendText(channelId, text, opts)
  }

  async sendFile(
    channelId: string,
    file: Buffer,
    filename: string,
    caption?: string,
    _opts?: SendOptions,
  ): Promise<SentMessage> {
    const socket = this.requireSocket()
    const mediaId = await this.uploadMedia(socket, 'file', file, filename)

    const channel = this.channels.get(channelId)
    if (channel?.lastReqId) {
      await this.sendFrame(socket, {
        cmd: 'aibot_respond_msg',
        headers: { req_id: channel.lastReqId },
        body: {
          msgtype: 'file',
          file: { media_id: mediaId },
        },
      })
      if (caption) await this.sendText(channelId, caption)
      return { platform: 'wecom', channelId, messageId: makeStreamId() }
    }

    await this.sendFrame(socket, {
      cmd: 'aibot_send_msg',
      headers: { req_id: makeReqId() },
      body: {
        chatid: channelId,
        chat_type: channel?.chatType ?? 0,
        msgtype: 'file',
        file: { media_id: mediaId },
      },
    })
    if (caption) await this.sendText(channelId, caption)
    return { platform: 'wecom', channelId, messageId: '' }
  }

  private async uploadMedia(
    socket: WeComSocketLike,
    type: 'file' | 'image' | 'voice' | 'video',
    data: Buffer,
    filename: string,
  ): Promise<string> {
    const totalChunks = Math.max(1, Math.ceil(data.length / WECOM_CHUNK_MAX_BYTES))

    const init = await this.sendFrame(socket, {
      cmd: 'aibot_upload_media_init',
      headers: { req_id: makeReqId() },
      body: {
        type,
        filename: filename.slice(0, 256),
        total_size: data.length,
        total_chunks: totalChunks,
        md5: md5Hex(data),
      },
    })
    const initBody = init?.body as { upload_id?: string } | undefined
    const uploadId = initBody?.upload_id
    if (!uploadId) {
      throw new Error(init?.errmsg || 'WeCom media upload init failed')
    }

    for (let i = 0; i < totalChunks; i += 1) {
      const chunk = data.subarray(i * WECOM_CHUNK_MAX_BYTES, (i + 1) * WECOM_CHUNK_MAX_BYTES)
      const res = await this.sendFrame(socket, {
        cmd: 'aibot_upload_media_chunk',
        headers: { req_id: makeReqId() },
        body: {
          upload_id: uploadId,
          chunk_index: i,
          base64_data: chunk.toString('base64'),
        },
      })
      if (res && res.errcode !== 0) {
        throw new Error(res.errmsg || `WeCom media chunk upload failed (errcode ${res.errcode})`)
      }
    }

    const finish = await this.sendFrame(socket, {
      cmd: 'aibot_upload_media_finish',
      headers: { req_id: makeReqId() },
      body: { upload_id: uploadId },
    })
    const mediaId = (finish?.body as { media_id?: string } | undefined)?.media_id
    if (!mediaId) {
      throw new Error(finish?.errmsg || 'WeCom media upload finish failed')
    }
    return mediaId
  }

  private async downloadMedia(
    url: string,
    aeskey?: string,
  ): Promise<IncomingAttachment | null> {
    try {
      const res = await fetch(url)
      if (!res.ok) return null
      const buffer = Buffer.from(await res.arrayBuffer())
      if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_BYTES) return null
      const plain = aeskey ? decryptMediaBlob(buffer, aeskey) : buffer
      const localPath = join(
        tmpdir(),
        `craft-wecom-${randomUUID()}${aeskey ? '' : '.bin'}`,
      )
      writeFileSync(localPath, plain)
      return { type: 'photo', fileId: url, localPath }
    } catch (err) {
      this.log.warn('[wecom] attachment download failed', {
        event: 'wecom_attachment_download_failed',
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }
}
