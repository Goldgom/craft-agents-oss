import { describe, expect, test } from 'bun:test'
import { SETTINGS_ITEMS } from '../menu-schema'
import {
  SETTINGS_PAGES,
  SETTINGS_PAGE_ALIASES,
  isValidSettingsSubpage,
  resolveSettingsSubpage,
} from '../settings-registry'
import { parseRouteToNavigationState } from '../route-parser'
import { buildMobileMenuPages } from '../../renderer/components/app-menu/mobile-menu-pages'

describe('merged settings navigation', () => {
  test('old deep links retain a valid route and resolve to the merged page', () => {
    for (const [alias, target] of Object.entries(SETTINGS_PAGE_ALIASES)) {
      expect(isValidSettingsSubpage(alias)).toBe(true)
      expect(isValidSettingsSubpage(target)).toBe(true)
      const state = parseRouteToNavigationState(`settings/${alias}`)
      expect(state?.navigator).toBe('settings')
      if (state?.navigator !== 'settings' || !state.subpage) throw new Error('Missing settings subpage')
      expect(resolveSettingsSubpage(state.subpage)).toBe(target)
      expect(resolveSettingsSubpage(target)).toBe(target)
    }
  })

  test('menus expose each merged page once and exclude the old entries', () => {
    const ids = SETTINGS_ITEMS.map(item => item.id)
    for (const [alias, target] of Object.entries(SETTINGS_PAGE_ALIASES)) {
      expect(ids).not.toContain(alias)
      expect(ids.filter(id => id === target)).toHaveLength(1)
    }
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain('usage')
    expect(ids).not.toContain('recharge')
    expect(SETTINGS_PAGES.every(page => isValidSettingsSubpage(page.id))).toBe(true)
  })

  test('mobile settings uses the same merged entries', () => {
    const pages = buildMobileMenuPages({ hasNewWindow: false, isDebugMode: false })
    const settings = pages.find(page => page.id === 'settings')!
    const targets = settings.rows.flatMap(row => row.action.kind === 'settingsSubpage' ? [row.action.subpage] : [])
    expect(targets).toEqual(SETTINGS_ITEMS.map(item => item.id))
    expect(targets).not.toContain('shortcuts')
    expect(targets).not.toContain('promptOverview')
  })
})
