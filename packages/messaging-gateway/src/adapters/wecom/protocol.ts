/**
 * WeCom (企业微信) smart-robot long-connection wire protocol.
 *
 * Implements the subset of the official aibot long-connection protocol that
 * the adapter needs (https://developer.work.weixin.qq.com/document/path/101463):
 *
 *   - `aibot_subscribe`       — identity verification over the WebSocket
 *   - `ping`                  — 30s keep-alive heartbeat
 *   - `aibot_msg_callback`    — inbound messages (text / image / file / …)
 *   - `aibot_event_callback`  — events (enter_chat, disconnected_event, …)
 *   - `aibot_respond_msg`     — reply + streaming updates (`stream` msgtype)
 *   - `aibot_send_msg`        — proactive push (markdown)
 *   - `aibot_upload_media_*`  — three-step media upload returning `media_id`
 *
 * No payload encryption is needed — the WebSocket transport layer is already
 * encrypted, which is the whole point of long-connection mode vs. webhooks.
 */

import { createHash } from 'node:crypto'
import { createDecipheriv } from 'node:crypto'
import { randomUUID } from 'node:crypto'

export const WECOM_WS_URL = 'wss://openws.work.weixin.qq.com'

/** Smart-robot BotID — unique robot identifier from the WeCom admin console. */
export interface WeComCredentials {
  botId: string
  /** Long-connection secret (different from webhook Token/EncodingAESKey). */
  secret: string
}

/**
 * Parse the JSON-encoded credentials from `PlatformConfig.token`.
 * Throws with a user-readable message when malformed.
 */
export function parseWeComCredentials(token: string | undefined): WeComCredentials {
  if (!token) throw new Error('WeCom credentials are missing')
  let parsed: unknown
  try {
    parsed = JSON.parse(token)
  } catch {
    throw new Error('WeCom credentials are not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('WeCom credentials must be a JSON object')
  }
  const { botId, secret } = parsed as Record<string, unknown>
  if (typeof botId !== 'string' || botId.trim().length === 0) {
    throw new Error('WeCom credentials are missing `botId`')
  }
  if (typeof secret !== 'string' || secret.trim().length === 0) {
    throw new Error('WeCom credentials are missing `secret`')
  }
  return { botId: botId.trim(), secret: secret.trim() }
}

/** A single WebSocket frame in either direction. */
export interface WeComFrame {
  cmd?: string
  headers?: { req_id?: string }
  body?: Record<string, unknown>
  errcode?: number
  errmsg?: string
}

/** Message callback frame (`aibot_msg_callback`). */
export interface WeComMessageCallback {
  cmd: 'aibot_msg_callback'
  headers: { req_id?: string }
  body: {
    msgid?: string
    aibotid?: string
    chatid?: string
    chattype?: 'single' | 'group'
    from?: { userid?: string }
    msgtype?: string
    text?: { content?: string }
    image?: { url?: string; aeskey?: string }
    file?: { url?: string; aeskey?: string }
    video?: { url?: string; aeskey?: string }
    voice?: unknown
    mixed?: unknown
  }
}

/** Event callback frame (`aibot_event_callback`). */
export interface WeComEventCallback {
  cmd: 'aibot_event_callback'
  headers: { req_id?: string }
  body: {
    msgid?: string
    aibotid?: string
    chatid?: string
    chattype?: 'single' | 'group'
    from?: { userid?: string }
    msgtype?: string
    event?: { eventtype?: string }
  }
}

/** Unified callback body projection for channel resolution. */
export interface WeComCallbackBody {
  chatid?: string
  chattype?: 'single' | 'group'
  from?: { userid?: string }
}

/**
 * Channel identity used for binding keys:
 *  - group chats  → `chatid`
 *  - single chats → sender `userid`
 * Returns `undefined` when neither is present (defensive).
 */
export function resolveChannelId(body: WeComCallbackBody): string | undefined {
  if (body.chattype === 'group' && body.chatid) return body.chatid
  return body.from?.userid
}

/**
 * WeCom `aibot_send_msg` chat_type:
 *  1 = single (userid), 2 = group (chatid), 0 = auto (prefer group).
 */
export function resolveChatType(body: WeComCallbackBody): 0 | 1 | 2 {
  if (body.chattype === 'group') return 2
  if (body.chattype === 'single') return 1
  return 0
}

/**
 * Strip a leading `@BotName ` mention from group text. WeCom prepends the
 * @-mention as a literal in `text.content` for group messages.
 */
export function stripMentionPrefix(text: string): string {
  const stripped = text.replace(/^@[^\s@]+\s*/, '')
  return stripped.trim()
}

/** Max stream/markdown content length accepted by WeCom (UTF-8 bytes). */
export const WECOM_MAX_CONTENT_BYTES = 20480

/** Truncate to `maxBytes` on UTF-8 boundaries, reserving room for a suffix. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const suffix = '\n…'
  const suffixBytes = Buffer.byteLength(suffix, 'utf8')
  const budget = maxBytes - suffixBytes
  let total = 0
  let end = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (total + size > budget) break
    total += size
    end += char.length
  }
  if (end < text.length) {
    return text.slice(0, end).replace(/\s+$/, '') + suffix
  }
  return text
}

/**
 * Decrypt a downloaded media blob. Long-connection mode hands each resource
 * URL a per-file `aeskey`: AES-256-CBC, PKCS#7 padding, IV = first 16 bytes
 * of the key material. The docs are ambiguous about whether `aeskey` is the
 * raw key string or base64 — try base64 first (32 bytes) and fall back to
 * UTF-8 so both shapes work.
 */
export function decryptMediaBlob(encrypted: Buffer, aeskey: string): Buffer {
  let key = Buffer.from(aeskey, 'base64')
  if (key.length < 32) key = Buffer.from(aeskey, 'utf8')
  if (key.length < 32) {
    // Defensive: pad/truncate so the cipher still has a 256-bit key.
    key = Buffer.concat([key, Buffer.alloc(32)], 32).subarray(0, 32)
  }
  const iv = key.subarray(0, 16)
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}

/** Max per-chunk payload before base64 encoding (must stay < 512KB). */
export const WECOM_CHUNK_MAX_BYTES = 500 * 1024

export function md5Hex(data: Buffer): string {
  return createHash('md5').update(data).digest('hex')
}

export function makeReqId(): string {
  return randomUUID()
}

export function makeStreamId(): string {
  return `stream_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}

/** Response envelope for a completed command. */
export interface WeComResponse {
  headers?: { req_id?: string }
  errcode?: number
  errmsg?: string
  body?: Record<string, unknown>
}

/** True when the frame is a command response rather than a server callback. */
export function isResponse(frame: WeComFrame): boolean {
  return typeof frame.errcode === 'number'
}
