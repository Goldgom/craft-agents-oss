/** QQ Bot (official open platform) adapter.
 *
 * Uses the official Gateway WebSocket for inbound events and the v2 channel
 * REST API for outbound messages. Credentials are supplied as `appId` and a
 * bot token (`token`), matching QQ's `Bot appId.token` authorization format.
 */
import WebSocket from 'ws'
import type {
  PlatformAdapter, PlatformConfig, AdapterCapabilities, IncomingMessage,
  SendOptions, SentMessage, InlineButton, ButtonPress, MessagingLogger,
} from '../../types'

const API_BASE = 'https://api.sgroup.qq.com'
const DEFAULT_INTENTS = (1 << 30) | (1 << 12) | 1
const NOOP_LOGGER: MessagingLogger = { info: () => {}, warn: () => {}, error: () => {}, child: () => NOOP_LOGGER }

export interface QQBotConfig extends PlatformConfig { appId: string; intents?: number }

export class QQBotAdapter implements PlatformAdapter {
  readonly platform = 'qqbot' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: false, inlineButtons: false, maxButtons: 0,
    maxMessageLength: 4000, markdown: 'v2', webhookSupport: false,
  }
  private ws: WebSocket | null = null
  private appId = ''
  private token = ''
  private intents = DEFAULT_INTENTS
  private connected = false
  private sequence: number | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private buttonHandler: ((press: ButtonPress) => Promise<void>) | null = null
  private log: MessagingLogger = NOOP_LOGGER
  private readonly directChannels = new Set<string>()

  async initialize(config: QQBotConfig): Promise<void> {
    if (!config.appId || !config.token) throw new Error('QQ Bot requires appId and token')
    this.appId = config.appId
    this.token = config.token.replace(/^Bot\s+/i, '')
    this.intents = config.intents ?? DEFAULT_INTENTS
    this.log = config.logger ?? NOOP_LOGGER
    const gateway = await this.requestGateway()
    this.ws = new WebSocket(gateway)
    await new Promise<void>((resolve, reject) => {
      const ws = this.ws!
      const onError = (err: Error) => { ws.off('open', onOpen); reject(err) }
      const onOpen = () => { ws.off('error', onError); this.connected = true; resolve() }
      ws.once('error', onError)
      ws.once('open', onOpen)
      ws.on('message', (raw) => void this.handleGatewayMessage(String(raw)))
      ws.on('close', () => { this.connected = false; this.stopHeartbeat() })
    })
  }

  async destroy(): Promise<void> {
    this.stopHeartbeat(); this.connected = false
    this.ws?.close(); this.ws = null
  }
  isConnected(): boolean { return this.connected }
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void { this.messageHandler = handler }
  onButtonPress(handler: (press: ButtonPress) => Promise<void>): void { this.buttonHandler = handler }

  async sendText(channelId: string, text: string, _opts?: SendOptions): Promise<SentMessage> {
    const prefix = this.directChannels.has(channelId) ? '/dms/' : '/v2/channels/'
    const body = await this.api(prefix + encodeURIComponent(channelId) + '/messages', { content: text.slice(0, 4000), msg_type: 0 })
    return { platform: 'qqbot', channelId, messageId: String((body as { id?: string }).id ?? '') }
  }
  async editMessage(): Promise<void> { throw new Error('QQ Bot message editing is not supported by this adapter') }
  async sendButtons(channelId: string, text: string, buttons: InlineButton[]): Promise<SentMessage> {
    const suffix = buttons.length ? `\n${buttons.map((b) => `[${b.label}]`).join(' ')}` : ''
    return this.sendText(channelId, text + suffix)
  }
  async sendTyping(): Promise<void> { /* QQ has no public typing endpoint. */ }
  async sendFile(_channelId: string, _file: Buffer, _filename: string, _caption?: string): Promise<SentMessage> {
    throw new Error('QQ Bot file upload is not implemented')
  }

  private async requestGateway(): Promise<string> {
    const body = await this.api('/gateway') as { url?: string }
    if (!body.url) throw new Error('QQ Bot gateway URL missing')
    return body.url
  }

  private async api(path: string, init?: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(API_BASE + path, {
      method: init ? 'POST' : 'GET',
      headers: { Authorization: `Bot ${this.appId}.${this.token}`, 'Content-Type': 'application/json' },
      body: init ? JSON.stringify(init) : undefined,
    })
    if (!response.ok) throw new Error(`QQ Bot API ${response.status}: ${await response.text()}`)
    return response.json()
  }

  private async handleGatewayMessage(raw: string): Promise<void> {
    let packet: { op: number; t?: string; s?: number; d?: any }
    try { packet = JSON.parse(raw) } catch { return }
    if (packet.s !== undefined) this.sequence = packet.s
    if (packet.op === 10) {
      const interval = Number(packet.d?.heartbeat_interval ?? 45_000)
      this.stopHeartbeat()
      this.heartbeat = setInterval(() => this.send({ op: 1, d: this.sequence }), interval)
      this.send({ op: 2, d: { token: `Bot ${this.appId}.${this.token}`, intents: this.intents, shard: [0, 1], properties: { $os: process.platform, $browser: 'craft-agent', $device: 'craft-agent' } } })
      return
    }
    if (packet.op !== 0 || !packet.t) return
    if (packet.t === 'READY') { this.connected = true; return }
    if (packet.t !== 'AT_MESSAGE_CREATE' && packet.t !== 'DIRECT_MESSAGE_CREATE') return
    const d = packet.d ?? {}
    const isDirect = packet.t === 'DIRECT_MESSAGE_CREATE'
    const channelId = String(isDirect ? (d.guild_id ?? d.channel_id ?? '') : (d.channel_id ?? d.guild_id ?? ''))
    if (isDirect && channelId) this.directChannels.add(channelId)
    const msg: IncomingMessage = {
      platform: 'qqbot', channelId, messageId: String(d.id ?? ''),
      senderId: String(d.author?.id ?? ''), senderName: d.author?.username, text: String(d.content ?? '').trim(),
      timestamp: d.timestamp ? Date.parse(d.timestamp) : Date.now(), raw: d,
    }
    if (msg.channelId && this.messageHandler) await this.messageHandler(msg)
  }
  private send(packet: unknown): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(packet)) }
  private stopHeartbeat(): void { if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null }
}

export function parseQQBotCredentials(value: unknown): { appId: string; token: string } | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  return typeof v.appId === 'string' && typeof v.token === 'string' ? { appId: v.appId, token: v.token } : null
}
