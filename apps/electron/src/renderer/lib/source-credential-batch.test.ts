import { describe, expect, test } from 'bun:test'
import { parseSourceCredentialBatch } from './source-credential-batch'

describe('bulk credential input', () => {
  test('parses tokens, basic passwords and multi-header credentials without changing secret bytes', () => {
    expect(parseSourceCredentialBatch('{"token":"dummy-one","basic":{"username":"user","password":" dummy password "},"headers":{"X-Key":"dummy-two"}}')).toEqual([
      { sourceSlug: 'token', credential: 'dummy-one' },
      { sourceSlug: 'basic', credential: '{"username":"user","password":" dummy password "}' },
      { sourceSlug: 'headers', credential: '{"X-Key":"dummy-two"}' },
    ])
  })
  test('rejects invalid JSON, empty batches, non-string values and unsafe slugs', () => {
    for (const input of ['{"token":"dummy-secret",}', '{}', '[]', '{"source":42}', '{"source":{"X-Key":42}}', '{"../other":"dummy-secret"}']) {
      expect(() => parseSourceCredentialBatch(input)).toThrow()
      try { parseSourceCredentialBatch(input) } catch (error) { expect(String(error)).not.toContain('dummy-secret') }
    }
  })
})
