import { describe, expect, test } from 'bun:test'
import { normalizeQQBotCredentials } from './index'

describe('normalizeQQBotCredentials', () => {
  test('accepts the bare AppToken expected by the adapter', () => {
    expect(normalizeQQBotCredentials('123456', 'app-token')).toEqual({ appId: '123456', token: 'app-token' })
  })

  test('strips a copied Bot AppID.AppToken authorization value', () => {
    expect(normalizeQQBotCredentials('123456', ' Bot 123456.app-token ')).toEqual({ appId: '123456', token: 'app-token' })
  })
})
