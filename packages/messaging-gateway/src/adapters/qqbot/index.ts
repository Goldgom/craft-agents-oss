/** QQ Bot (official open platform) adapter.
 *
 * Uses the official Gateway WebSocket for inbound events and the v2 channel
 * REST API for outbound messages. The current QQ API requires AppID +
 * AppSecret, which this adapter exchanges for a short-lived access_token.
 */
import WebSocket from 'ws'
import type {
  PlatformAdapter, PlatformConfig, AdapterCapabilities, IncomingMessage,
  SendOptions, SentMessage, InlineButton, ButtonPress, MessagingLogger,
} from '../../types'

const API_BASE = 'https://api.bot.qq.com'
// GUILDS + PUBLIC_GUILD_MESSAGES are the baseline intents available to every
// QQ Bot. Direct-message and other privileged intents require separately
// granted capabilities and must not make a basic connection fail.
const DEFAULT_INTENTS = (1 << 30) | 1
const NOOP_LOGGER: MessagingLogger = { info: () => {}, warn: () => {}, error: () => {}, child: () => NOOP_LOGGER }

export interface QQBotConfig extends PlatformConfig { appId: string; token: string; intents?: number }
interface QQGatewayInfo { url: string; shards: number }

function networkError(stage: string, error: unknown): Error {
  const err = error instanceof Error ? error : new Error(String(error))
  const cause = (err as Error & { cause?: unknown }).cause
  const causeText = cause && typeof cause === 'object' && 'code' in cause
    ? `, ${(cause as { code?: unknown }).code}`
    : ''
  return new Error(`QQ Bot ${stage} network request failed: ${err.message}${causeText}`)
}

/**
 * Normalize credentials from the UI. `token` is retained as the persisted
 * field name for compatibility, but its value is the current QQ AppSecret.
 */
export function normalizeQQBotCredentials(appId: string, token: string): { appId: string; token: string } {
  const normalizedAppId = appId.trim()
  const normalizedToken = token.trim()
  if (!normalizedAppId || !normalizedToken) {
    throw new Error('QQ Bot requires an App ID and AppSecret')
  }
  return { appId: normalizedAppId, token: normalizedToken }
}

export class QQBotAdapter implements PlatformAdapter {
  readonly platform = 'qqbot' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: false, inlineButtons: false, maxButtons: 0,
    maxMessageLength: 4000, markdown: 'v2', webhookSupport: false,
  }
  private ws: WebSocket | null = null
  private appId = ''
  private appSecret = ''
  private accessToken = ''
  private accessTokenExpiresAt = 0
  private gatewayShards = 1
  private intents = DEFAULT_INTENTS
  private connected = false
  private sequence: number | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private readyWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private buttonHandler: ((press: ButtonPress) => Promise<void>) | null = null
  private log: MessagingLogger = NOOP_LOGGER
  private readonly directChannels = new Set<string>()

  async initialize(config: QQBotConfig): Promise<void> {
    const credentials = normalizeQQBotCredentials(config.appId ?? '', config.token ?? '')
    this.appId = credentials.appId
    this.appSecret = credentials.token
    this.intents = config.intents ?? DEFAULT_INTENTS
    this.log = config.logger ?? NOOP_LOGGER
    this.log.info('QQ Bot auth mode: AppID + AppSecret -> short-lived access token')
    const gatewayInfo = await this.requestGateway()
    this.gatewayShards = gatewayInfo.shards
    this.log.info(`QQ Bot gateway received (shards: ${gatewayInfo.shards}, intents: ${this.intents})`)
    this.ws = new WebSocket(gatewayInfo.url)
    await new Promise<void>((resolve, reject) => {
      const ws = this.ws!
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.readyWaiter = null
        reject(error)
      }
      const onError = (err: Error) => fail(new Error(`QQ Bot WebSocket connection failed: ${err.message}`))
      const onOpen = () => { /* Keep the error listener installed for post-open failures. */ }
      timer = setTimeout(() => fail(new Error('QQ Bot WebSocket authentication timed out')), 15_000)
      this.readyWaiter = {
        resolve: () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.readyWaiter = null
          this.connected = true
          resolve()
        },
        reject: fail,
      }
      ws.once('error', onError)
      ws.once('open', onOpen)
      ws.on('message', (raw) => void this.handleGatewayMessage(String(raw)))
      ws.on('close', (code, reason) => {
        this.connected = false
        this.stopHeartbeat()
        const detail = reason?.toString() ? `: ${reason.toString()}` : ''
        this.readyWaiter?.reject(new Error(`QQ Bot WebSocket identify failed (close ${code})${detail}`))
      })
    })
  }

  async destroy(): Promise<void> {
    this.stopHeartbeat(); this.connected = false
    this.ws?.close(); this.ws = null
    this.readyWaiter = null
    this.accessToken = ''
    this.accessTokenExpiresAt = 0
  }
  isConnected(): boolean { return this.connected }
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void { this.messageHandler = handler }
  onButtonPress(handler: (press: ButtonPress) => Promise<void>): void { this.buttonHandler = handler }

  async sendText(channelId: string, text: string, _opts?: SendOptions): Promise<SentMessage> {
    const prefix = this.directChannels.has(channelId) ? '/v2/users/' : '/v2/channels/'
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

  private async requestGateway(): Promise<QQGatewayInfo> {
    const body = await this.api('/gateway') as { url?: string; shards?: number }
    if (!body.url) throw new Error('QQ Bot gateway request failed: URL missing')
    const shards = Number(body.shards ?? 1)
    if (!Number.isInteger(shards) || shards < 1) throw new Error('QQ Bot gateway request failed: invalid shard count')
    return { url: body.url, shards }
  }

  private async api(path: string, init?: Record<string, unknown>): Promise<unknown> {
    const accessToken = await this.getAccessToken()
    let response: Response
    try {
      response = await fetch(API_BASE + path, {
        method: init ? 'POST' : 'GET',
        headers: { Authorization: `QQBot ${accessToken}`, 'Content-Type': 'application/json' },
        body: init ? JSON.stringify(init) : undefined,
      })
    } catch (error) {
      throw networkError(`REST ${path}`, error)
    }
    if (!response.ok) throw new Error(`QQ Bot REST request failed (${response.status}): ${await response.text()}`)
    return response.json()
  }

  /** Exchange AppID + AppSecret for the short-lived access token required by the current API. */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) return this.accessToken
    let response: Response
    try {
      response = await fetch(`${API_BASE}/app/getAppAccessToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
      })
    } catch (error) {
      throw networkError('access token', error)
    }
    const body = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; message?: string; code?: number; err_code?: number }
    if (!response.ok || !body.access_token) {
      const detail = body.message ? `: ${body.message}` : ''
      const code = body.err_code ?? body.code
      throw new Error(`QQ Bot access token exchange failed (${response.status}${code ? `, code ${code}` : ''})${detail}`)
    }
    this.accessToken = body.access_token
    this.accessTokenExpiresAt = Date.now() + Math.max(60, Number(body.expires_in ?? 7200)) * 1000
    return this.accessToken
  }

  private async handleGatewayMessage(raw: string): Promise<void> {
    let packet: { op: number; t?: string; s?: number; d?: any }
    try { packet = JSON.parse(raw) } catch { return }
    if (packet.s !== undefined) this.sequence = packet.s
    if (packet.op === 10) {
      const interval = Number(packet.d?.heartbeat_interval ?? 45_000)
      this.stopHeartbeat()
      this.heartbeat = setInterval(() => this.send({ op: 1, d: this.sequence }), interval)
      void this.getAccessToken().then((accessToken) => {
        this.send({ op: 2, d: { token: `QQBot ${accessToken}`, intents: this.intents, shard: [0, this.gatewayShards], properties: { $os: process.platform, $browser: 'craft-agent', $device: 'craft-agent' } } })
      }).catch((error) => {
        this.log.error(`QQ Bot authentication failed: ${error instanceof Error ? error.message : String(error)}`)
        this.readyWaiter?.reject(error instanceof Error ? error : new Error(String(error)))
        this.ws?.close()
      })
      return
    }
    if (packet.op === 9) {
      const detail = packet.d === undefined || packet.d === null || packet.d === ''
        ? ''
        : ` (${typeof packet.d === 'string' ? packet.d : JSON.stringify(packet.d)})`
      this.readyWaiter?.reject(new Error(`QQ Bot WebSocket identify failed: invalid identify parameters${detail}`))
      this.ws?.close()
      return
    }
    if (packet.op !== 0 || !packet.t) return
    if (packet.t === 'READY') { this.readyWaiter?.resolve(); return }
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
  // Credentials are persisted through CredentialManager as a JSON string, but
  // accepting an object keeps this helper compatible with already-decoded
  // callers and older in-memory configurations.
  let decoded: unknown = value
  if (typeof decoded === 'string') {
    try { decoded = JSON.parse(decoded) } catch { return null }
  }
  if (!decoded || typeof decoded !== 'object') return null
  const v = decoded as Record<string, unknown>
  return typeof v.appId === 'string' && typeof v.token === 'string' ? { appId: v.appId, token: v.token } : null
}
