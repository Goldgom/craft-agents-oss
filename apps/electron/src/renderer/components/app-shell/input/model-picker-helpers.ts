import {
  isImageGenerationModelId,
  isLocalConnection,
  type LlmConnection,
} from '@config/llm-connections'
import { ANTHROPIC_MODELS, type ModelDefinition } from '@config/models'

/** Keep image generation in Studio while respecting an OAuth connection's active group. */
export function getAgentModelsForConnection(connection: LlmConnection): Array<ModelDefinition | string> {
  const models = connection.models || ANTHROPIC_MODELS
  const group = connection.oauthProvider === 'tokennest'
    ? connection.channelGroups?.find(item => item.id === connection.channelGroup)
    : undefined
  const allowed = group?.models?.length ? new Set(group.models) : null
  return models.filter(model => {
    const id = typeof model === 'string' ? model : model.id
    return !isImageGenerationModelId(id) && (!allowed || allowed.has(id))
  })
}

export function getAgentChannelGroups(connection: LlmConnection) {
  return connection.channelGroups?.filter(group => !group.models?.length || group.models.some(model => !isImageGenerationModelId(model))) ?? []
}

/**
 * Format token count for display (e.g., 1500 -> "1.5k", 200000 -> "200k").
 * Shared by the desktop model dropdown and the compact (drawer) model picker.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k`
  }
  return tokens.toString()
}

/**
 * Strip the "pi/" prefix from model IDs/display names so the user sees a
 * provider-agnostic label in the picker (e.g., "pi/claude-opus" → "claude-opus").
 */
export function stripPiPrefixForDisplay(value: string): string {
  return value.startsWith('pi/') ? value.slice(3) : value
}

export type ConnectionGroup = [groupName: string, connections: LlmConnection[]]

/**
 * Group connections by provider type for hierarchical picker rendering.
 * Each provider section can contain multiple connections (API Key, OAuth, …).
 * Order is significant for UI: Anthropic, Local, TokenBird Backend.
 * Empty groups are dropped.
 */
export function groupConnectionsByProvider<T extends LlmConnection>(
  connections: readonly T[],
): Array<[string, T[]]> {
  const groups: Record<string, T[]> = {
    'Anthropic': [],
    'Local': [],
    'TokenBird Backend': [],
  }
  for (const conn of connections) {
    const provider = conn.providerType || 'anthropic'
    if (provider === 'anthropic') {
      groups['Anthropic'].push(conn)
    } else if (provider === 'pi_compat' && isLocalConnection(conn)) {
      groups['Local'].push(conn)
    } else if (provider === 'pi' || provider === 'pi_compat') {
      groups['TokenBird Backend'].push(conn)
    }
  }
  return Object.entries(groups).filter(([, conns]) => conns.length > 0)
}
