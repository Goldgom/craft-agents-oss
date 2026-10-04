import { isLocalConnection, type LlmConnection } from '../config/llm-connections'
import { getProviderMetadata } from '../config/provider-metadata'

/** Recognize exhausted account credit across compatible gateway error formats. */
export function isInsufficientBalanceError(error: unknown): boolean {
  const value = error instanceof Error ? error.message
    : typeof error === 'string' ? error
      : error && typeof error === 'object'
        ? ['code', 'message', 'originalError', 'error'].map(key => {
          const field = (error as Record<string, unknown>)[key]
          return typeof field === 'string' ? field : ''
        }).join(' ')
        : ''
  const text = value.replace(/\\_/g, '_').toLowerCase()
  return /(?:insufficient[_ ](?:balance|quota|credit|user_quota)|(?:balance|quota|credit)[_ ](?:is[_ ])?(?:insufficient|exhausted)|quota[_ ]exceeded|余额不足|额度不足)/.test(text)
}

export const TOKENNEST_RECHARGE_URL = 'https://openai.goldgom.top/wallet'

export function validateTokenNestRechargeUrl(value: string): string {
  const url = new URL(value)
  if (url.origin !== new URL(TOKENNEST_RECHARGE_URL).origin || url.username || url.password || url.hash
    || !['/wallet', '/oauth/recharge'].includes(url.pathname)) {
    throw new Error('Invalid TokenNest recharge URL')
  }
  return url.href
}

export interface ProviderRechargeTarget {
  url: string
  websiteUrl: string
  /** Custom gateways commonly use /console/topup; their homepage remains available. */
  inferred?: boolean
}

const PROVIDER_BILLING_URLS: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/billing',
  openai: 'https://platform.openai.com/settings/organization/billing/overview',
  'openai-codex': 'https://chatgpt.com/#settings/Account',
  deepseek: 'https://platform.deepseek.com/top_up',
  openrouter: 'https://openrouter.ai/settings/credits',
  'github-copilot': 'https://github.com/settings/copilot',
  moonshotai: 'https://platform.moonshot.ai/console',
  'moonshotai-cn': 'https://platform.moonshot.cn/console',
  siliconflow: 'https://cloud.siliconflow.cn',
}

const HOST_PROVIDERS: Record<string, string> = {
  'api.anthropic.com': 'anthropic',
  'api.openai.com': 'openai',
  'api.deepseek.com': 'deepseek',
  'openrouter.ai': 'openrouter',
  'api.groq.com': 'groq',
  'api.mistral.ai': 'mistral',
  'api.x.ai': 'xai',
  'generativelanguage.googleapis.com': 'google',
  'api.moonshot.ai': 'moonshotai',
  'api.moonshot.cn': 'moonshotai-cn',
  'api.siliconflow.cn': 'siliconflow',
}

/** Resolve from the actual endpoint first so a custom gateway never bills the upstream provider. */
export function getProviderRechargeTarget(connection: Pick<LlmConnection, 'baseUrl' | 'providerType' | 'piAuthProvider' | 'oauthProvider' | 'authType'>): ProviderRechargeTarget | undefined {
  if (isLocalConnection(connection)) return undefined
  if (connection.oauthProvider === 'tokennest') {
    return { url: TOKENNEST_RECHARGE_URL, websiteUrl: new URL(TOKENNEST_RECHARGE_URL).origin }
  }
  if (connection.baseUrl?.trim()) {
    let endpoint: URL
    try { endpoint = new URL(connection.baseUrl.trim()) } catch { return undefined }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) return undefined
    if (endpoint.origin === new URL(TOKENNEST_RECHARGE_URL).origin) {
      return { url: TOKENNEST_RECHARGE_URL, websiteUrl: endpoint.origin }
    }
    const provider = endpoint.port ? undefined : HOST_PROVIDERS[endpoint.hostname]
    if (provider) {
      const url = PROVIDER_BILLING_URLS[provider] ?? getProviderMetadata('pi', provider)?.dashboardUrl
      if (url) return { url, websiteUrl: new URL(url).origin }
    }
    return { url: `${endpoint.origin}/console/topup`, websiteUrl: endpoint.origin, inferred: true }
  }
  if (connection.providerType === 'anthropic' && connection.authType === 'oauth') {
    return { url: 'https://claude.ai/settings/billing', websiteUrl: 'https://claude.ai' }
  }
  const provider = connection.providerType === 'anthropic' ? 'anthropic' : connection.piAuthProvider
  const url = (provider && PROVIDER_BILLING_URLS[provider]) ?? getProviderMetadata(connection.providerType, provider)?.dashboardUrl
  return url ? { url, websiteUrl: new URL(url).origin } : undefined
}
