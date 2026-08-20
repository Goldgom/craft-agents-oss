/** QQ Bot adapter backed by a dedicated Node worker and Tencent's official SDK. */
import { spawn, type ChildProcess } from 'node:child_process'
import { encodeMessage, parseFrames, type WorkerCommand, type WorkerEvent } from '@craft-agent/messaging-qqbot-worker'
import type { PlatformAdapter, PlatformConfig, AdapterCapabilities, IncomingMessage, SendOptions, SentMessage, InlineButton, ButtonPress, MessagingLogger } from '../../types'

const NOOP_LOGGER: MessagingLogger = { info: () => {}, warn: () => {}, error: () => {}, child: () => NOOP_LOGGER }
export interface QQBotConfig extends PlatformConfig { appId: string; token: string; workerEntry?: string; nodeBin?: string; sendTimeoutMs?: number }
export function normalizeQQBotCredentials(appId: string, token: string): { appId: string; token: string } {
  const normalizedAppId = appId.trim(); const normalizedToken = token.trim()
  if (!normalizedAppId || !normalizedToken) throw new Error('QQ Bot requires an App ID and AppSecret')
  return { appId: normalizedAppId, token: normalizedToken }
}
type Pending = { resolve: (result: { ok: boolean; messageId?: string; error?: string }) => void; timer: ReturnType<typeof setTimeout> }

export class QQBotAdapter implements PlatformAdapter {
  readonly platform = 'qqbot' as const
  readonly capabilities: AdapterCapabilities = { messageEditing: false, inlineButtons: false, maxButtons: 0, maxMessageLength: 4000, markdown: 'v2', webhookSupport: false }
  private proc: ChildProcess | null = null; private buffer = ''; private connected = false; private log = NOOP_LOGGER
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null; private buttonHandler: ((press: ButtonPress) => Promise<void>) | null = null
  private pending = new Map<string, Pending>(); private seq = 0; private sendTimeoutMs = 30000
  private scopes = new Map<string, 'c2c' | 'group'>(); private replyMessageIds = new Map<string, string>(); private readyCheck: ((event: WorkerEvent) => void) | null = null
  async initialize(config: QQBotConfig): Promise<void> {
    const creds = normalizeQQBotCredentials(config.appId ?? '', config.token ?? '')
    if (!config.workerEntry) throw new Error('QQ Bot workerEntry path is required')
    this.log = config.logger ?? NOOP_LOGGER; this.sendTimeoutMs = config.sendTimeoutMs ?? 30000
    this.proc = spawn(config.nodeBin ?? process.execPath, [config.workerEntry], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    this.proc.stdout?.setEncoding('utf8'); this.proc.stdout?.on('data', (chunk: string) => { this.buffer += chunk; const p = parseFrames<WorkerEvent>(this.buffer); this.buffer = p.rest; p.messages.forEach((e) => this.onEvent(e)) })
    this.proc.stderr?.on('data', (chunk: Buffer) => this.log.warn('QQ Bot worker stderr', { line: chunk.toString('utf8').trim() }))
    this.proc.on('exit', (code) => {
      this.connected = false
      const message = `QQ Bot worker exited with code ${code ?? 'null'}`
      this.readyCheck?.({ type: 'unavailable', message })
      this.readyCheck = null
      this.drain(message)
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.readyCheck = null; reject(new Error('QQ Bot worker READY timeout (SDK did not establish Gateway connection)')) }, 15000)
      this.readyCheck = (event) => {
        if (event.type === 'connected') { clearTimeout(timer); this.readyCheck = null; resolve() }
        if (event.type === 'unavailable') { clearTimeout(timer); this.readyCheck = null; reject(new Error(event.message)) }
        if (event.type === 'error') { clearTimeout(timer); this.readyCheck = null; reject(new Error(event.message)) }
      }
      // Install the listener before sending start; the worker may emit READY
      // immediately on a warm/reused SDK session.
      this.send({ type: 'start', appId: creds.appId, appSecret: creds.token })
    }).catch(async (error) => {
      await this.destroy()
      throw error
    })
  }
  private onEvent(event: WorkerEvent): void {
    this.readyCheck?.(event)
    if (event.type === 'connected') { this.connected = true; return }
    if (event.type === 'error') { this.log.error(event.message); return }
    if (event.type === 'unavailable') { this.drain(event.message); return }
    if (event.type === 'send_result') { const pending = this.pending.get(event.id); if (pending) { clearTimeout(pending.timer); this.pending.delete(event.id); pending.resolve(event) }; return }
    if (event.type === 'incoming') { this.scopes.set(event.channelId, event.scope); if (event.messageId) this.replyMessageIds.set(event.channelId, event.messageId); const msg: IncomingMessage = { platform: 'qqbot', channelId: event.channelId, messageId: event.messageId, senderId: event.senderId, text: event.text, timestamp: event.timestamp, raw: event.raw }; if (this.handler) void this.handler(msg) }
  }
  private send(command: WorkerCommand): void { this.proc?.stdin?.write(encodeMessage(command)) }
  private drain(error: string): void { for (const [id, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error }); this.pending.delete(id) } }
  async destroy(): Promise<void> { if (!this.proc) return; this.send({ type: 'shutdown' }); this.proc.kill(); this.proc = null; this.connected = false; this.drain('QQ Bot worker stopped') }
  isConnected(): boolean { return this.connected }
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void { this.handler = handler }
  onButtonPress(handler: (press: ButtonPress) => Promise<void>): void { this.buttonHandler = handler }
  async sendText(channelId: string, text: string, _opts?: SendOptions): Promise<SentMessage> { const id = String(++this.seq); const scope = this.scopes.get(channelId) ?? 'c2c'; const replyMessageId = this.replyMessageIds.get(channelId); const result = await new Promise<{ ok: boolean; messageId?: string; error?: string }>((resolve) => { const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: 'QQ Bot send timed out' }) }, this.sendTimeoutMs); this.pending.set(id, { resolve, timer }); this.send({ id, type: 'send_text', channelId, scope, replyMessageId, text: text.slice(0, 4000) }) }); if (!result.ok) throw new Error(result.error ?? 'QQ Bot send failed'); return { platform: 'qqbot', channelId, messageId: result.messageId ?? '' } }
  async editMessage(): Promise<void> { throw new Error('QQ Bot message editing is not supported') }
  async sendButtons(channelId: string, text: string, buttons: InlineButton[]): Promise<SentMessage> { return this.sendText(channelId, text + (buttons.length ? `\n${buttons.map((b) => `[${b.label}]`).join(' ')}` : '')) }
  async sendTyping(): Promise<void> {}
  async sendFile(): Promise<SentMessage> { throw new Error('QQ Bot file upload is not implemented') }
}
export function parseQQBotCredentials(value: unknown): { appId: string; token: string } | null { let parsed: unknown = value; if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed) } catch { return null } }; if (!parsed || typeof parsed !== 'object') return null; const v = parsed as Record<string, unknown>; return typeof v.appId === 'string' && typeof v.token === 'string' ? { appId: v.appId, token: v.token } : null }
