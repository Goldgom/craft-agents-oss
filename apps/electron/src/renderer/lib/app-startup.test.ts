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

  test('opens Android local chat before model setup once its workspace is ready', () => {
    expect(resolveAuthGatedAppState(false, 'local-workspace', true)).toBe('ready')
    expect(resolveAuthGatedAppState(false, null, true)).toBe('workspace-picker')
    expect(resolveAuthGatedAppState(false, 'remote-workspace', false)).toBe('onboarding')
  })
})
