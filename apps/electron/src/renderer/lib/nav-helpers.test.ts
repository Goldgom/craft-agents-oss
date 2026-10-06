import { describe, expect, it } from 'bun:test'
import { parseRouteToNavigationState } from '../../shared/route-parser'
import { getCompactListRoute, isDetailNavState } from './nav-helpers'

describe('compact navigation', () => {
  it('keeps entity list entries visible until a row is selected', () => {
    for (const route of ['sources', 'sources/api', 'sources/mcp', 'sources/local', 'skills', 'projects', 'automations/scheduled', 'settings', 'flagged']) {
      const state = parseRouteToNavigationState(route)
      expect(state).not.toBeNull()
      expect(isDetailNavState(state)).toBe(false)
    }
  })

  it('shows standalone management pages instead of an empty navigator', () => {
    for (const route of ['automations/agents', 'automations/script-monitor', 'tools', 'tools/builtin', 'tools/custom', 'pages', 'board']) {
      const state = parseRouteToNavigationState(route)
      expect(state).not.toBeNull()
      expect(isDetailNavState(state)).toBe(true)
    }
  })

  it('returns to the same filtered list from details', () => {
    for (const [detail, list] of [
      ['sources/api/source/calendar', 'sources/api'],
      ['sources/mcp/source/docs', 'sources/mcp'],
      ['sources/local/source/files', 'sources/local'],
      ['skills/skill/agent-authoring', 'skills'],
      ['projects/project/demo', 'projects'],
      ['automations/scheduled/automation/job', 'automations/scheduled'],
      ['flagged/session/chat', 'flagged'],
      ['settings/appearance', 'settings'],
      ['automations/agents', 'automations'],
      ['automations/script-monitor', 'automations'],
    ] as const) {
      const state = parseRouteToNavigationState(detail!)
      expect(state).not.toBeNull()
      expect(getCompactListRoute(state)).toBe(list!)
    }
  })
})
