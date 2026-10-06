export type AuthGatedAppState = 'onboarding' | 'workspace-picker' | 'ready'

/**
 * Resolve the first interactive screen after the server reports its auth state.
 * Android local chat can open before model setup; the chat shell then offers
 * an inline connection prompt. Other clients retain the provider setup gate.
 */
export function resolveAuthGatedAppState(
  isFullyConfigured: boolean,
  workspaceId: string | null | undefined,
  openLocalChat = false,
): AuthGatedAppState {
  if (!isFullyConfigured && !openLocalChat) return 'onboarding'
  return workspaceId ? 'ready' : 'workspace-picker'
}
