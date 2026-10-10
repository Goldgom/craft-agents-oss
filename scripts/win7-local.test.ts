import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { normalizeWin7Setup, normalizeWin7Test } from '../apps/win7-local/runtime-policy'
const { validateProfile } = createRequire(import.meta.url)('../apps/win7-local/connection.cjs')
const base = { api: 'openai-completions', baseUrl: 'https://api.example.com/v1/', model: ' test-model ', apiKey: ' test-key ', workingDirectory: tmpdir() }
describe('Win7 local configuration boundary', () => {
  test('normalizes model and endpoint without storing secrets in the URL', () => {
    expect(validateProfile(base)).toMatchObject({ baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'test-key', local: false })
  })
  test('only accepts supported protocols and secure nonlocal URLs', () => {
    for (const baseUrl of ['file:///x', 'javascript:alert(1)', 'https://user:key@example.com', 'https://example.com?token=key', 'https://example.com#key', 'http://example.com/v1']) expect(() => validateProfile({ ...base, baseUrl })).toThrow()
    expect(() => validateProfile({ ...base, api: 'claude-code' })).toThrow()
  })
  test('requires credentials for cloud endpoints but accepts keyless loopback endpoints', () => {
    expect(() => validateProfile({ ...base, apiKey: '' })).toThrow()
    expect(validateProfile({ ...base, apiKey: '' }, true).model).toBe('test-model')
    expect(validateProfile({ ...base, apiKey: '', baseUrl: 'http://127.0.0.1:1234/v1' }).local).toBe(true)
  })
  test('rejects empty models, injected credential headers and nonexistent directories', () => {
    expect(() => validateProfile({ ...base, model: '' })).toThrow()
    expect(() => validateProfile({ ...base, apiKey: 'key\r\nHeader: data' })).toThrow()
    expect(() => validateProfile({ ...base, workingDirectory: 'Z:/no-such-win7-local-test-directory' })).toThrow()
  })
})

describe('Win7 original UI runtime policy', () => {
  test('routes the unchanged Anthropic API form to Pi without replacing its slug or key', () => {
    const result = normalizeWin7Setup({ slug: 'anthropic-api-2', credential: 'key', defaultModel: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6'] })
    expect(result).toMatchObject({ slug: 'anthropic-api-2', credential: 'key', baseUrl: 'https://api.anthropic.com', customEndpoint: { api: 'anthropic-messages' }, piAuthProvider: 'anthropic' })
  })
  test('preserves original endpoint protocols, model lists and image support', () => {
    const setup = { slug: 'anthropic-api', customEndpoint: { api: 'openai-completions', supportsImages: true }, baseUrl: 'http://localhost:1234/v1', models: ['test'] }
    expect(normalizeWin7Setup(setup)).toEqual(setup)
  })
  test('validates API forms with the same Pi runtime as chat', () => {
    expect(normalizeWin7Test({ provider: 'anthropic', apiKey: 'key', model: 'claude-sonnet-4-6' })).toMatchObject({ provider: 'pi', piAuthProvider: 'anthropic', customEndpoint: { api: 'anthropic-messages' }, apiKey: 'key' })
  })
  test('explicitly rejects unsupported native subscriptions and runtimes', () => {
    expect(() => normalizeWin7Setup({ slug: 'claude-max-2' })).toThrow('Win7')
    expect(() => normalizeWin7Setup({ slug: 'test' }, { agentRuntime: 'codex' })).toThrow('Win7')
  })
})
