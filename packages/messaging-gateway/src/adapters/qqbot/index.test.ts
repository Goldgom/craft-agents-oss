import { describe, expect, test } from 'bun:test'
import { normalizeQQBotCredentials, parseQQBotCredentials } from './index'

describe('normalizeQQBotCredentials', () => {
  test('accepts the AppSecret displayed by the current QQ console', () => {
    expect(normalizeQQBotCredentials('123456', ' app-secret ')).toEqual({ appId: '123456', token: 'app-secret' })
  })

  test('keeps the secret opaque instead of treating it as a legacy AppToken', () => {
    expect(normalizeQQBotCredentials('123456', 'Bot 123456.app-token')).toEqual({ appId: '123456', token: 'Bot 123456.app-token' })
  })

  test('parses credentials persisted as a JSON string', () => {
    expect(parseQQBotCredentials(JSON.stringify({ appId: '123456', token: 'app-secret' }))).toEqual({ appId: '123456', token: 'app-secret' })
  })
})
