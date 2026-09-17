export type AuthGatedAppState = 'onboarding' | 'workspace-picker' | 'ready'

/**
 * Resolve the first interactive screen after the server reports its auth state.
 * Provider setup always comes before workspace selection, including in the
 * Android WebView, because a fresh on-device server has no usable model yet.
 */
export function resolveAuthGatedAppState(
  isFullyConfigured: boolean,
  workspaceId: string | null | undefined,
): AuthGatedAppState {
  if (!isFullyConfigured) return 'onboarding'
  return workspaceId ? 'ready' : 'workspace-picker'
}
