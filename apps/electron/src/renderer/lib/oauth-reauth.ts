import { resolveEffectiveConnectionSlug, type LlmConnectionWithStatus } from '@config/llm-connections'

/** Route a terminal login error to its account, including accounts marked unauthenticated. */
export function getOAuthReauthConnection(
  error: unknown, connections: LlmConnectionWithStatus[], sessionConnection?: string, workspaceConnection?: string,
): LlmConnectionWithStatus | undefined {
  const expired = typeof error === 'string'
    ? /login has expired|token (?:is )?expired|invalid_grant/i.test(error)
    : error !== null && typeof error === 'object' && 'code' in error && error.code === 'expired_oauth_token'
  if (!expired) return undefined
  const slug = resolveEffectiveConnectionSlug(sessionConnection, workspaceConnection, connections)
  return connections.find(connection => connection.slug === slug && connection.authType === 'oauth')
}
