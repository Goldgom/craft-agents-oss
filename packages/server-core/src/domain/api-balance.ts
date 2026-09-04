import type { LlmConnection } from '@craft-agent/shared/config'
import type { LlmConnectionBalance } from '@craft-agent/shared/protocol'

export type { LlmConnectionBalance } from '@craft-agent/shared/protocol'

type JsonRecord = Record<string, unknown>

interface BalanceAdapter {
  endpoint: (connection: LlmConnection) => string
  parse: (payload: unknown, connectionSlug: string, updatedAt: number) => LlmConnectionBalance | null
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function urlWithPath(baseUrl: string, suffix: string, stripVersion = false): string {
  const url = new URL(baseUrl)
  let path = url.pathname.replace(/\/+$/, '')
  if (stripVersion) path = path.replace(/\/v\d+$/i, '')
  url.pathname = `${path}${suffix}`.replace(/\/+/g, '/')
  url.search = ''
  url.hash = ''
  return url.toString()
}

function openRouterBalanceUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = /\/api\/v1$/i.test(path)
    ? `${path}/auth/key`
    : `${path}/api/v1/auth/key`.replace(/\/+/g, '/')
  url.search = ''
  url.hash = ''
  return url.toString()
}

function providerKey(connection: LlmConnection): string | null {
  const provider = connection.piAuthProvider?.toLowerCase()
  if (provider === 'openrouter' || provider === 'deepseek' || provider === 'moonshotai' || provider === 'moonshotai-cn' || provider === 'siliconflow') {
    return provider
  }

  // A custom OpenAI-compatible connection can still point directly at one of
  // these public APIs. We only match known hosts; arbitrary endpoints are never
  // probed for a guessed balance route.
  try {
    const host = new URL(connection.baseUrl ?? '').hostname.toLowerCase()
    if (host === 'openrouter.ai') return 'openrouter'
    if (host === 'api.deepseek.com') return 'deepseek'
    if (host === 'api.moonshot.ai' || host === 'api.moonshot.cn') return 'moonshotai'
    if (host === 'api.siliconflow.cn') return 'siliconflow'
  } catch {
    // An invalid custom URL is handled by the normal connection validation flow.
  }
  return null
}

const ADAPTERS: Record<string, BalanceAdapter> = {
  openrouter: {
    endpoint: connection => openRouterBalanceUrl(connection.baseUrl ?? 'https://openrouter.ai/api/v1'),
    parse: (payload, connectionSlug, updatedAt) => {
      const data = asRecord(asRecord(payload)?.data)
      if (!data) return null
      const remaining = asNumber(data.limit_remaining)
      if (remaining === undefined && data.limit_remaining !== null) return null
      return {
        connectionSlug,
        remaining,
        currency: 'USD',
        display: remaining === undefined ? 'Unlimited' : undefined,
        updatedAt,
      }
    },
  },
  deepseek: {
    endpoint: connection => urlWithPath(connection.baseUrl ?? 'https://api.deepseek.com', '/user/balance', true),
    parse: (payload, connectionSlug, updatedAt) => {
      const info = asRecord(payload)?.balance_infos
      if (!Array.isArray(info)) return null
      const first = info.map(asRecord).find((entry): entry is JsonRecord => !!entry && asNumber(entry.total_balance ?? entry.balance) !== undefined)
      if (!first) return null
      return {
        connectionSlug,
        remaining: asNumber(first.total_balance ?? first.balance),
        currency: typeof first.currency === 'string' ? first.currency : undefined,
        updatedAt,
      }
    },
  },
  moonshotai: {
    endpoint: connection => urlWithPath(connection.baseUrl ?? 'https://api.moonshot.ai/v1', '/users/me/balance'),
    parse: (payload, connectionSlug, updatedAt) => {
      const data = asRecord(asRecord(payload)?.data)
      const remaining = asNumber(data?.balance ?? data?.available_balance)
      return remaining === undefined ? null : { connectionSlug, remaining, currency: 'CNY', updatedAt }
    },
  },
  'moonshotai-cn': {
    endpoint: connection => urlWithPath(connection.baseUrl ?? 'https://api.moonshot.cn/v1', '/users/me/balance'),
    parse: (payload, connectionSlug, updatedAt) => {
      const data = asRecord(asRecord(payload)?.data)
      const remaining = asNumber(data?.balance ?? data?.available_balance)
      return remaining === undefined ? null : { connectionSlug, remaining, currency: 'CNY', updatedAt }
    },
  },
  siliconflow: {
    endpoint: connection => urlWithPath(connection.baseUrl ?? 'https://api.siliconflow.cn/v1', '/user/info'),
    parse: (payload, connectionSlug, updatedAt) => {
      const data = asRecord(asRecord(payload)?.data)
      const remaining = asNumber(data?.balance)
      return remaining === undefined ? null : { connectionSlug, remaining, currency: 'CNY', updatedAt }
    },
  },
}

export function supportsApiBalance(connection: LlmConnection): boolean {
  return connection.authType !== 'oauth' && !!providerKey(connection)
}

export async function fetchApiBalance(connection: LlmConnection, apiKey: string): Promise<LlmConnectionBalance | null> {
  const key = providerKey(connection)
  const adapter = key ? ADAPTERS[key] : undefined
  if (!adapter || !apiKey.trim()) return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(adapter.endpoint(connection), {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey.trim()}` },
      signal: controller.signal,
    })
    if (!response.ok) return null
    return adapter.parse(await response.json(), connection.slug, Date.now())
  } catch {
    // Balance reporting is supplementary: never surface transport or provider
    // errors in the chat flow, and never treat them as credential failures.
    return null
  } finally {
    clearTimeout(timeout)
  }
}
