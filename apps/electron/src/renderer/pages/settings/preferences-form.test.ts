import { describe, expect, it } from 'bun:test'
import { emptyFormState, parsePreferences, serializePreferences } from './preferences-form'

describe('preferences form', () => {
  it('loads the proxy preference', () => {
    expect(parsePreferences('{"preferredProxy":"http://127.0.0.1:7890"}').preferredProxy)
      .toBe('http://127.0.0.1:7890')
  })

  it('handles missing, malformed, and non-string preferences', () => {
    for (const json of ['{}', 'null', '{', '{"preferredProxy":123}']) {
      expect(parsePreferences(json)).toEqual(emptyFormState)
    }
  })

  it('saves and trims the proxy without removing unrelated settings', () => {
    const existing = {
      uiLanguage: 'zh-Hans',
      startupServerLocation: 'remote-server',
      gettingStartedGuideVersion: 2,
      includeCoAuthoredBy: false,
      diffViewer: { diffStyle: 'split' },
      performance: { maxWarmRuntimes: 3 },
      systemPrompt: { capabilities: { subagents: true } },
      location: { region: 'Jiangsu' },
    }
    const saved = JSON.parse(serializePreferences({
      ...emptyFormState,
      preferredProxy: '  http://127.0.0.1:7890  ',
      city: 'Wuxi',
    }, JSON.stringify(existing)))
    expect(saved).toMatchObject({
      ...existing,
      preferredProxy: 'http://127.0.0.1:7890',
      location: { region: 'Jiangsu', city: 'Wuxi' },
    })
    expect(saved.updatedAt).toBeNumber()
  })

  it('clears editable preferences without deleting other location fields', () => {
    const saved = JSON.parse(serializePreferences(emptyFormState, JSON.stringify({
      name: 'Alice',
      timezone: 'Asia/Shanghai',
      preferredProxy: 'http://127.0.0.1:7890',
      notes: 'test',
      location: { city: 'Wuxi', country: 'China', region: 'Jiangsu' },
      uiLanguage: 'zh-Hans',
    })))
    for (const field of ['name', 'timezone', 'preferredProxy', 'notes']) {
      expect(saved).not.toHaveProperty(field)
    }
    expect(saved.location).toEqual({ region: 'Jiangsu' })
    expect(saved.uiLanguage).toBe('zh-Hans')
  })

  it('removes an empty location and leaves a whitespace-only proxy unset', () => {
    const saved = JSON.parse(serializePreferences({ ...emptyFormState, preferredProxy: '  ' }, '{}'))
    expect(saved).not.toHaveProperty('location')
    expect(saved).not.toHaveProperty('preferredProxy')
  })

  it('refuses to overwrite malformed existing preferences', () => {
    for (const json of ['null', '[]', '123', '{']) {
      expect(() => serializePreferences(emptyFormState, json)).toThrow()
    }
  })
})
