import { isImageGenerationModelId } from '@config/llm-connections'
import type { LlmConnectionWithStatus } from '../../../shared/types'

/** A mind map may use any text model exposed by the account's TokenNest groups. */
export function mindMapTextModels(connection: LlmConnectionWithStatus): string[] {
  const configured = (connection.models ?? []).map(item => typeof item === 'string' ? item : item.id)
  const groupModels = connection.oauthProvider === 'tokennest'
    ? (connection.channelGroups ?? []).flatMap(group => group.models ?? [])
    : []
  const candidates = groupModels.length ? groupModels : configured.length ? configured : connection.defaultModel ? [connection.defaultModel] : []
  return [...new Set(candidates.filter(id => typeof id === 'string' && !!id.trim() && !isImageGenerationModelId(id)))]
}

/** Prefer the Agent's active group if it contains this model. */
export function mindMapGroupForModel(connection: LlmConnectionWithStatus, model: string): string {
  if (connection.oauthProvider !== 'tokennest') return ''
  const groups = (connection.channelGroups ?? []).filter(group => group.models?.includes(model))
  return groups.find(group => group.id === connection.channelGroup)?.id ?? groups[0]?.id ?? ''
}
