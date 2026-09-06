import { describe, expect, it } from 'bun:test'
import { generateSlug } from './storage.ts'

describe('generateSlug', () => {
  it('preserves Chinese characters in workspace names', () => {
    expect(generateSlug('我的工作区')).toBe('我的工作区')
  })

  it('normalizes separators while retaining Unicode letters and numbers', () => {
    expect(generateSlug('项目 2026 / Demo')).toBe('项目-2026-demo')
  })

  it('falls back for names without letters or numbers', () => {
    expect(generateSlug('---')).toBe('workspace')
  })
})
