export type StudioErrorKind = 'policy' | 'billing' | 'auth' | 'rate' | 'timeout' | 'network' | 'service' | 'model' | 'request' | 'message' | 'unknown'

/** Classify provider failures before displaying their raw response to the user. */
export function classifyStudioError(raw: string): { kind: StudioErrorKind; message: string } {
  const message = raw.replace(/^Error:\s*/i, '').trim()
  const text = message.replace(/\\([_*-])/g, '$1').toLowerCase()
  const result = (kind: StudioErrorKind) => ({ kind, message })
  // Policy responses can also contain HTTP 400/403. Match the specific reason first.
  if (/safety[_ ]violations?|safety[_ ]system|content[_ ]policy[_ ]violation|prompt[_ ]blocked|content[_ ]filter|blocked by content moderation|responsible[_ ]ai[_ ]policy|安全审核|内容审核|违反.*(?:政策|使用规则)/.test(text)) return result('policy')
  if (/insufficient[_ ](?:balance|quota|credit|user_quota)|(?:balance|quota|credit)[_ ](?:is[_ ])?(?:insufficient|exhausted)|quota[_ ]exceeded|payment required|余额不足|额度不足|\bhttp\s*402\b/.test(text)) return result('billing')
  if (/\b401\b|unauthorized|invalid[_ ]api[_ ]key|no api key|authentication failed|invalid_grant|token.*expired|login.*expired|登录.*失效/.test(text)) return result('auth')
  if (/\b429\b|rate[_ ]limit|too many requests|请求.*频繁/.test(text)) return result('rate')
  if (/timed?[_ ]?out|timeout|aborterror|请求.*超时/.test(text)) return result('timeout')
  if (/failed to fetch|fetch failed|network|econnrefused|enotfound|econnreset|connection (?:lost|refused|reset)|网络.*(?:错误|断开)/.test(text)) return result('network')
  if (/model[_ ]not[_ ]found|invalid[_ ]model|model.*(?:not available|not supported|does not exist)|no[_ ]available[_ ]channel|无可用渠道/.test(text)) return result('model')
  if (/\b(?:500|502|503|504|520|529)\b|internal server error|service unavailable|overloaded/.test(text)) return result('service')
  if (/\b(?:400|403|422)\b|invalid[_ ]request|bad request/.test(text)) return result('request')
  if (/studio request failed|(?:type|syntax|range|reference)error|\berror:|\bhttp\b|request[_ -]?id|<!doctype|<html|\bstack\b|[{}]|\n\s*at\s/.test(text) || message.length > 240) return result('unknown')
  // Keep concise local validation hints (missing prompt, locked layer, etc.).
  return result('message')
}
