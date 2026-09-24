import { RPC_CHANNELS, STUDIO_IMAGE_PROVIDER_TIMEOUT_MS, STUDIO_TOKENNEST_CHANNEL_UNAVAILABLE, STUDIO_TOKENNEST_REAUTH_REQUIRED } from '@craft-agent/shared/protocol'
import { getLlmConnection, type LlmConnection } from '@craft-agent/shared/config'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { fetchTokenNestChannelGroups, getValidTokenNestCredentials, TokenNestGroupsScopeError, TOKENNEST_OAUTH_CONFIG } from '@craft-agent/shared/auth'
import type { RpcServer } from '@craft-agent/server-core/transport'
import { exportDrawioToVisio } from './studio-visio'
import { inflateRawSync } from 'node:zlib'

type ImageInput = {
  connectionSlug: string
  model: string
  prompt: string
  channelGroup?: string
  imageBase64?: string
  maskBase64?: string
  size?: string
  count?: number
  transparentBackground?: boolean
}

type MindMapRequest = { connectionSlug: string; model: string; prompt: string; currentXml?: string; priorRequests?: string[] }

function requireText(value: unknown, label: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${label} is required (maximum ${max} characters)`)
  }
  return value.trim()
}

function resolveConnection(slug: string): { connection: LlmConnection; baseUrl: string } {
  const connection = getLlmConnection(requireText(slug, 'Connection', 100))
  if (!connection) throw new Error('Select a configured image or AI connection')
  if (connection.oauthProvider === 'tokennest') {
    return { connection, baseUrl: TOKENNEST_OAUTH_CONFIG.apiBaseUrl }
  }
  if (connection.authType !== 'api_key' && connection.authType !== 'api_key_with_endpoint') {
    throw new Error('This connection cannot be used for Studio requests')
  }
  const raw = connection.baseUrl || (connection.piAuthProvider === 'openai' ? 'https://api.openai.com/v1' : '')
  if (!raw) throw new Error('Configure an OpenAI-compatible API endpoint for this connection')
  const url = new URL(raw)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid connection endpoint')
  }
  return { connection, baseUrl: url.toString().replace(/\/$/, '') }
}

async function getToken(connection: LlmConnection, refresh = false): Promise<string> {
  const manager = getCredentialManager()
  if (connection.oauthProvider === 'tokennest') {
    const credentials = await getValidTokenNestCredentials(connection.slug, manager, refresh)
    if (!credentials?.accessToken) throw new Error('TokenNest login expired. Please sign in again.')
    return credentials.accessToken
  }
  const key = await manager.getLlmApiKey(connection.slug)
  if (!key) throw new Error('This connection has no API key')
  return key
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path}`
}

// Fetch converts header values from ByteString to wire bytes. Preserve the
// UTF-8 bytes of group IDs that contain Chinese characters for TokenNest.
function tokenNestGroupHeaderValue(group: string): string {
  return Buffer.from(group, 'utf8').toString('latin1')
}

async function post(
  connection: LlmConnection,
  baseUrl: string,
  path: string,
  body: (token: string) => string | FormData,
  contentType?: string,
  imageGroup?: string,
  timeoutMs = 120_000,
): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(connection, attempt > 0)
    const response = await fetch(endpoint(baseUrl, path), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(contentType ? { 'Content-Type': contentType } : {}),
        ...(connection.oauthProvider === 'tokennest' && (imageGroup || connection.channelGroup)
          ? { 'X-TokenNest-Group': tokenNestGroupHeaderValue(imageGroup || connection.channelGroup!) } : {}),
      },
      body: body(token),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 401 && connection.oauthProvider === 'tokennest') {
      if (attempt === 0) continue
      throw new Error(`${STUDIO_TOKENNEST_REAUTH_REQUIRED}: TokenNest 登录已失效，请重新登录`)
    }
    const payload = await response.json().catch(() => ({})) as Record<string, any>
    if (!response.ok) {
      const message = typeof payload.error?.message === 'string' ? payload.error.message : `HTTP ${response.status}`
      if (connection.oauthProvider === 'tokennest') {
        if (response.status === 403 && (payload.error?.code === 'insufficient_scope' || payload.error === 'insufficient_scope')) {
          throw new Error(`${STUDIO_TOKENNEST_REAUTH_REQUIRED}: TokenNest 授权权限不足，请重新登录`)
        }
        if (/无可用渠道|no available channel|no_available_channel/i.test(message)) {
          try { await fetchTokenNestChannelGroups(token) }
          catch (cause) {
            if (cause instanceof TokenNestGroupsScopeError) {
              throw new Error(`${STUDIO_TOKENNEST_REAUTH_REQUIRED}: 当前 TokenNest 授权缺少分组读取权限，请重新登录`)
            }
          }
          throw new Error(`${STUDIO_TOKENNEST_CHANNEL_UNAVAILABLE}: ${message.slice(0, 500)}`)
        }
      }
      throw new Error(`Studio request failed: ${message.slice(0, 500)}`)
    }
    return payload
  }
  throw new Error('TokenNest login expired. Please sign in again.')
}

function imageBytes(value: unknown, label: string): Blob {
  if (typeof value !== 'string' || value.length > 40_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} must be a PNG image under 30 MB`)
  }
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0))
  if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
    throw new Error(`${label} must be PNG`)
  }
  return new Blob([bytes], { type: 'image/png' })
}

function uncompressDrawio(xml: string): string {
  if (xml.includes('<mxGraphModel')) return xml
  return xml.replace(/(<diagram\b[^>]*>)([^<]+)(<\/diagram>)/g, (_match, open: string, encoded: string, close: string) => {
    try {
      const decoded = decodeURIComponent(inflateRawSync(Buffer.from(encoded.trim(), 'base64'), { maxOutputLength: 500_000 }).toString('utf8'))
      if (!decoded.startsWith('<mxGraphModel')) throw new Error('Invalid draw.io graph')
      return `${open}${decoded}${close}`
    } catch { throw new Error('Cannot read the compressed draw.io diagram') }
  })
}

function requireDrawioXml(value: unknown): string {
  if (typeof value !== 'string' || value.length > 500_000) throw new Error('Invalid draw.io XML')
  let xml = value.trim()
  if (/^<mxGraphModel\b/.test(xml)) xml = `<mxfile host="TokenBird"><diagram name="Mind Map">${xml}</diagram></mxfile>`
  if (!/^<\?xml\b[^>]*>\s*<mxfile\b|^<mxfile\b/.test(xml)
    || !/<diagram\b/.test(xml) || !/<mxGraphModel\b/.test(xml) || !/<root\b/.test(xml)
    || !/<mxCell\b[^>]*\bid=["']0["']/.test(xml) || !/<mxCell\b[^>]*\bid=["']1["']/.test(xml)
    || /<!DOCTYPE|<!ENTITY|<script\b|<iframe\b|<foreignObject\b|\bon\w+\s*=|javascript:/i.test(xml)) {
    throw new Error('AI returned invalid or unsafe draw.io XML')
  }
  return xml
}

function parseMindMapReply(raw: string): { xml: string; summary: string } {
  const cleaned = raw.trim().replace(/^```(?:json|xml)?\s*/i, '').replace(/\s*```$/, '')
  let xml = cleaned; let summary = '已根据要求更新导图'
  if (cleaned.startsWith('{')) {
    const reply = JSON.parse(cleaned) as { xml?: unknown; summary?: unknown }
    if (typeof reply.xml !== 'string') throw new Error('AI did not return draw.io XML')
    xml = reply.xml
    if (typeof reply.summary === 'string' && reply.summary.trim()) summary = reply.summary.trim().slice(0, 300)
  }
  return { xml: requireDrawioXml(xml), summary }
}

export function registerStudioHandlers(server: RpcServer): void {
  server.handle(RPC_CHANNELS.studio.EXPORT_VISIO, async (_ctx, xml: string) => ({ base64: await exportDrawioToVisio(xml) }))
  server.handle(RPC_CHANNELS.studio.GENERATE_IMAGE, async (_ctx, input: ImageInput) => {
    const { connection, baseUrl } = resolveConnection(input.connectionSlug)
    const model = requireText(input.model, 'Image model', 120)
    const prompt = requireText(input.prompt, 'Prompt', 4000)
    const size = ['1024x1024', '1536x1024', '1024x1536'].includes(input.size || '')
      ? input.size! : '1024x1024'
    const count = input.count ?? 1
    if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('Image count must be between 1 and 4')
    const editing = !!input.imageBase64
    const transparentBackground = input.transparentBackground === true && /^gpt-image/i.test(model)
    const imageGroup = connection.oauthProvider === 'tokennest' && input.channelGroup
      ? connection.channelGroups?.find(group => group.id === input.channelGroup && group.models?.includes(model))?.id
      : undefined
    if (connection.oauthProvider === 'tokennest' && !imageGroup) {
      throw new Error(`${STUDIO_TOKENNEST_CHANNEL_UNAVAILABLE}: 当前账户没有可用于此模型的图片分组，请检查 TokenNest 分组权限并刷新连接`)
    }
    if (input.maskBase64 && !editing) throw new Error('A mask requires a source image')
    let payload: Record<string, any>
    if (editing) {
      const image = imageBytes(input.imageBase64, 'Source image')
      const mask = input.maskBase64 ? imageBytes(input.maskBase64, 'Mask') : undefined
      payload = await post(connection, baseUrl, 'images/edits', () => {
        const form = new FormData()
        form.set('model', model)
        form.set('prompt', prompt)
        form.set('size', size)
        if (count > 1) form.set('n', String(count))
        if (transparentBackground) form.set('background', 'transparent')
        form.set('image', image, 'canvas.png')
        if (mask) form.set('mask', mask, 'mask.png')
        return form
      }, undefined, imageGroup, STUDIO_IMAGE_PROVIDER_TIMEOUT_MS)
    } else {
      payload = await post(connection, baseUrl, 'images/generations', () =>
        JSON.stringify({ model, prompt, size, ...(count > 1 ? { n: count } : {}), ...(transparentBackground ? { background: 'transparent' } : {}), ...(/dall-e/i.test(model) ? { response_format: 'b64_json' } : {}) }), 'application/json', imageGroup, STUDIO_IMAGE_PROVIDER_TIMEOUT_MS)
    }
    const images = Array.isArray(payload.data)
      ? payload.data.filter((item: { b64_json?: unknown }) => typeof item?.b64_json === 'string')
        .slice(0, count).map((item: { b64_json: string }) => ({ imageBase64: item.b64_json, mimeType: 'image/png' }))
      : []
    if (images.length) return { ...images[0], images }
    throw new Error('Image provider did not return image data')
  })

  server.handle(RPC_CHANNELS.studio.GENERATE_MIND_MAP, async (_ctx, input: MindMapRequest) => {
    const { connection, baseUrl } = resolveConnection(input.connectionSlug)
    const model = requireText(input.model, 'Text model', 120)
    const prompt = requireText(input.prompt, 'Prompt', 4000)
    const normalizedXml = input.currentXml ? requireDrawioXml(uncompressDrawio(input.currentXml)) : undefined
    // draw.io opens a new session with root cells only; those are editor scaffolding,
    // not user content for the model to preserve.
    const currentXml = normalizedXml && /<mxCell\b[^>]*(?:vertex|edge)=["']1["']/.test(normalizedXml) ? normalizedXml : undefined
    if (currentXml && currentXml.length > 100_000) throw new Error('导图过大，无法完整交给 AI 修改；请精简导图后重试')
    const priorRequests = Array.isArray(input.priorRequests)
      ? input.priorRequests.slice(-8).filter((value): value is string => typeof value === 'string').map(value => value.slice(0, 1000)) : []
    const payload = await post(connection, baseUrl, 'chat/completions', () => JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You edit an editable draw.io mind map. Return only JSON with {"xml":"<mxfile ...>...</mxfile>","summary":"brief Chinese summary"}. The XML must contain one uncompressed mxGraphModel with root cells id 0 and 1, mxCell vertices with mxGeometry, and connected edges. Escape XML attribute values. For an existing diagram, keep unchanged node IDs, positions, styles and relationships unless the instruction requires changing them. Preserve all unrelated content. For a new diagram, create clear hierarchy and readable spacing. Do not include scripts, external links, or markdown.' },
        { role: 'user', content: JSON.stringify({ instruction: prompt, priorRequests, currentXml: currentXml ?? null }) },
      ],
    }), 'application/json')
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('AI returned no mind map')
    return parseMindMapReply(content)
  })
}
