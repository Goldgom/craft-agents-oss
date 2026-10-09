import { describe, expect, it } from 'bun:test'
import { classifyStudioError } from './studio-error'

describe('Studio error presentation', () => {
  it('recognizes the image safety rejection from the reported screenshot', () => {
    expect(classifyStudioError('Error: Studio request failed: Your request was rejected by the safety system. If you believe this is an error, contact us and include request ID 28b647a58-9bcf-4123-bcec-efe50a2d3ce9. safety_violations=[sexual]').kind).toBe('policy')
  })

  it('prioritizes moderation over a generic forbidden or bad request status', () => {
    for (const error of ['HTTP 403: content_policy_violation', 'HTTP 400: prompt\\_blocked', 'safety\\_violations=[sexual]', 'request blocked by content moderation']) {
      expect(classifyStudioError(error).kind).toBe('policy')
    }
    expect(classifyStudioError('HTTP 403: access denied').kind).toBe('request')
  })

  it('distinguishes recoverable provider failures', () => {
    for (const [raw, kind] of [
      ['HTTP 402: insufficient_quota', 'billing'], ['HTTP 401: invalid_api_key', 'auth'],
      ['HTTP 429: rate limit exceeded', 'rate'], ['AbortError: operation timed out', 'timeout'],
      ['TypeError: Failed to fetch', 'network'], ['HTTP 503: service unavailable', 'service'],
      ['Studio request failed: model_not_found', 'model'], ['Error: 无可用渠道', 'model'],
    ] as const) expect(classifyStudioError(raw).kind).toBe(kind)
  })

  it('hides unclassified provider payloads while preserving local validation hints', () => {
    expect(classifyStudioError('Error: Studio request failed: Unexpected provider reply {"request_id":"abc"}').kind).toBe('unknown')
    expect(classifyStudioError('Error: 请先选择需要编辑的区域')).toEqual({ kind: 'message', message: '请先选择需要编辑的区域' })
    expect(classifyStudioError('Please enter a drawing prompt').kind).toBe('message')
  })
})
