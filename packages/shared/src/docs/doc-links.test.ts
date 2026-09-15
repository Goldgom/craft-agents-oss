import { describe, expect, it } from 'bun:test'
import { DOCS, LOCAL_DOCS_URL, getDocUrl, type DocFeature } from './doc-links'

describe('local documentation links', () => {
  it('routes every feature to the unified in-app guide', () => {
    for (const feature of Object.keys(DOCS) as DocFeature[]) {
      expect(getDocUrl(feature)).toBe(LOCAL_DOCS_URL)
      expect(getDocUrl(feature).startsWith('tokenbird://')).toBe(true)
    }
  })
})
