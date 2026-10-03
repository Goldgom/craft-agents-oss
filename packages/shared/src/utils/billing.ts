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
