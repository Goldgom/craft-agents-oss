import { describe, expect, it } from 'bun:test'
import { summaryFromMarkdown, titleFromMarkdown } from './catalog'

describe('workspace catalog markdown metadata', () => {
  it('uses the first level-one heading as the guide title', () => {
    expect(titleFromMarkdown('# Browser Tools\n\nContent', 'browser-tools.md')).toBe('Browser Tools')
  })

  it('falls back to a readable filename title', () => {
    expect(titleFromMarkdown('No heading', 'data-tables.md')).toBe('Data Tables')
  })

  it('extracts a plain-text summary after frontmatter and headings', () => {
    const markdown = `---\ntags:\n  - source\n---\n# Guide\n\nUse **this guide** with [the API](https://example.com).`
    expect(summaryFromMarkdown(markdown)).toBe('Use this guide with the API.')
  })
})
