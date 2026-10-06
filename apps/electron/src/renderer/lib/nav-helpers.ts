/**
 * Navigation helpers
 *
 * Small pure helpers over `NavigationState`. Keep these stateless and free of
 * React/Jotai imports — they're consumed both inside hooks (PanelStackContainer)
 * and in synchronous callbacks (CompactBackButton).
 */

import type { NavigationState } from '../../shared/types'
import { buildRouteFromNavigationState } from '../../shared/route-parser'
import type { ViewRoute } from '../../shared/routes'

/**
 * Returns true when the focused panel's nav state is in "detail" mode —
 * i.e. the user has drilled past the navigator into a specific item.
 *
 * Used by compact-mode logic to flip the layout from navigator-only to
 * content-only with a back-button overlay.
 *
 * Per-navigator semantics:
 * - sessions: a session is selected
 * - settings: a subpage is selected (bare `settings` route → false)
 * - sources / skills / projects: a detail item is selected
 * - automations: a detail item or a standalone management section is selected
 * - tools: management list renders in the content panel
 * - pages: always — both the library grid and a page render in the content
 *   panel (pages has no navigator list to fall back to)
 */
export function isDetailNavState(navState: NavigationState | null): boolean {
  if (!navState) return false
  switch (navState.navigator) {
    case 'sessions':
      return navState.viewMode === 'board' || navState.details !== null
    case 'settings':
      return navState.subpage !== null
    case 'sources':
    case 'skills':
    case 'projects':
      return navState.details !== null
    case 'automations':
      return !!navState.section || navState.details !== null
    case 'tools':
      // Tool management is itself a list in the content panel; its navigator
      // rows have no drill-in route. Showing only that navigator hides controls.
      return true
    case 'pages':
      return true
  }
}

/** Parent list for compact Back. Preserve the current type/session filter. */
export function getCompactListRoute(navState: NavigationState | null): ViewRoute | null {
  if (!navState) return null
  let parent: NavigationState
  if (navState.navigator === 'settings' && navState.subpage) {
    parent = { ...navState, subpage: null }
  } else if (navState.navigator === 'automations' && navState.section) {
    parent = { ...navState, section: undefined, details: null }
  } else if ('details' in navState && navState.details) {
    parent = { ...navState, details: null }
  } else if (navState.navigator === 'sessions' && navState.viewMode === 'board') {
    parent = { ...navState, viewMode: undefined }
  } else {
    return null
  }
  return buildRouteFromNavigationState(parent) as ViewRoute
}
