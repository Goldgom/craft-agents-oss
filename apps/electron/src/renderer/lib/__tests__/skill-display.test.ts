import { describe, expect, test } from 'bun:test'
import type { LoadedSkill } from '../../../shared/types'
import { localizeBuiltinSkill, localizeBuiltinSkills } from '../skill-display'

function skill(source: LoadedSkill['source'] = 'builtin', slug = 'browser-automation'): LoadedSkill {
  return {
    slug,
    source,
    path: `/skills/${slug}`,
    content: '# Browser automation',
    metadata: {
      name: 'browser-automation',
      description: 'Operate the built-in browser.',
    },
  }
}

describe('built-in skill display localization', () => {
  test('localizes built-in metadata for Simplified Chinese without changing identity or instructions', () => {
    const original = skill()
    const localized = localizeBuiltinSkill(original, 'zh-Hans')

    expect(localized).not.toBe(original)
    expect(localized.slug).toBe(original.slug)
    expect(localized.path).toBe(original.path)
    expect(localized.content).toBe(original.content)
    expect(localized.metadata.name).toBe('浏览器自动化')
    expect(localized.metadata.description).toContain('词元鸟内置浏览器')
  })

  test('uses Traditional Chinese for Taiwan and Hong Kong locale variants', () => {
    expect(localizeBuiltinSkill(skill(), 'zh-TW').metadata.name).toBe('瀏覽器自動化')
    expect(localizeBuiltinSkill(skill(), 'zh-HK').metadata.description).toContain('詞元鳥內建瀏覽器')
  })

  test('does not localize user skills or non-Chinese displays', () => {
    const workspaceSkill = skill('workspace')
    expect(localizeBuiltinSkill(workspaceSkill, 'zh-Hans')).toBe(workspaceSkill)

    const builtins = [skill()]
    expect(localizeBuiltinSkills(builtins, 'en')).toBe(builtins)
  })

  test('falls back to source metadata for unknown built-in slugs', () => {
    const unknown = skill('builtin', 'future-skill')
    expect(localizeBuiltinSkill(unknown, 'zh-Hans')).toBe(unknown)
  })
})
