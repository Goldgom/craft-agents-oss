import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { replaceModernColors, rgbColor, substituteVariables } from '../apps/webui/src/compat/win7-colors'
import { lowerSupportsCondition } from './win7-css'

const { normalizeConnection } = createRequire(import.meta.url)('../apps/win7-client/connection.cjs')

describe('Win7 remote connection validation', () => {
  test('accepts WebSocket paths and converts browser-facing addresses', () => {
    expect(normalizeConnection({ serverUrl: ' https://example.org/ws ', token: ' secret ', workspaceId: ' team ' }))
      .toEqual({ serverUrl: 'wss://example.org/ws', token: 'secret', workspaceId: 'team' })
    expect(normalizeConnection({ serverUrl: 'http://127.0.0.1:9100' }).serverUrl).toBe('ws://127.0.0.1:9100/')
  })
  test('rejects executable URLs and credentials embedded in addresses', () => {
    for (const serverUrl of ['file:///etc/passwd', 'javascript:alert(1)', 'wss://user:pass@example.org', 'wss://example.org/?token=secret', 'wss://example.org/#secret']) {
      expect(() => normalizeConnection({ serverUrl })).toThrow()
    }
  })
})

describe('Chromium 108 color compatibility', () => {
  test('lowers feature guards so corrected translucent utilities are used', () => {
    expect(lowerSupportsCondition('(color:color-mix(in oklab,red,red))')).toBe('(color:rgb(255, 0, 0))')
    expect(lowerSupportsCondition('(display:grid)')).toBe('(display:grid)')
  })
  test('lowers Oklch colors and alpha mixtures to RGB', () => {
    expect(rgbColor('oklch(0.5 0 0)')).toMatch(/^rgb\(/)
    expect(rgbColor('color-mix(in oklab, rgb(20,30,40) 50%, transparent)')).toBe('rgba(20, 30, 40, 0.5)')
  })
  test('evaluates relative colors after substituting theme variables', () => {
    const source = substituteVariables('oklch(from var(--foreground) l c h / .1)', name => name === '--foreground' ? '#303030' : undefined)
    expect(rgbColor(source)).toBe('rgba(48, 48, 48, 0.1)')
  })
  test('keeps nested functions intact and supports nested variable fallbacks', () => {
    const seen: string[] = []
    expect(replaceModernColors('0 0 color-mix(in srgb, var(--a) 20%, color-mix(in srgb, red, blue))', expr => { seen.push(expr); return 'RGB' }))
      .toBe('0 0 RGB')
    expect(seen).toHaveLength(1)
    expect(substituteVariables('var(--a, var(--b, red))', () => undefined)).toBe('red')
  })
  test('retains unresolved functions as recipes, not unsupported browser values', () => {
    expect(rgbColor('color-mix(in srgb, var(--foreground) 50%, transparent)')).toBeUndefined()
    expect(replaceModernColors('oklch(.5 0 0) solid 1px', expr => rgbColor(expr) || 'transparent')).toMatch(/^rgb\(.+ solid 1px$/)
  })
})
