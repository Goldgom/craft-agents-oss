import { describe, expect, test } from 'bun:test'

import {
  GETTING_STARTED_GUIDE_VERSION,
  shouldShowGettingStartedGuide,
} from '../getting-started-guide'

describe('shouldShowGettingStartedGuide', () => {
  test('shows when no completion version has been recorded', () => {
    expect(shouldShowGettingStartedGuide(undefined)).toBe(true)
    expect(shouldShowGettingStartedGuide(null)).toBe(true)
  })

  test('stays hidden after the current guide is completed', () => {
    expect(shouldShowGettingStartedGuide(GETTING_STARTED_GUIDE_VERSION)).toBe(false)
  })

  test('shows a newer guide version once', () => {
    expect(shouldShowGettingStartedGuide(GETTING_STARTED_GUIDE_VERSION - 1)).toBe(true)
    expect(shouldShowGettingStartedGuide(GETTING_STARTED_GUIDE_VERSION + 1)).toBe(false)
  })
})
