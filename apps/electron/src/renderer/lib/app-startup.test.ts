import { describe, expect, test } from 'bun:test'
import { resolveAuthGatedAppState } from './app-startup'

describe('resolveAuthGatedAppState', () => {
  test('shows provider onboarding before workspace selection on a fresh server', () => {
    expect(resolveAuthGatedAppState(false, null)).toBe('onboarding')
    expect(resolveAuthGatedAppState(false, 'default-workspace')).toBe('onboarding')
  })

  test('enters a configured workspace directly', () => {
    expect(resolveAuthGatedAppState(true, 'default-workspace')).toBe('ready')
  })

  test('asks for a workspace only after provider setup is complete', () => {
    expect(resolveAuthGatedAppState(true, null)).toBe('workspace-picker')
  })
})
