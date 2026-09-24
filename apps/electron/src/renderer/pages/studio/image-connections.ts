import { isImageGenerationModelId } from '@config/llm-connections'
import type { LlmConnectionWithStatus } from '../../../shared/types'

export function isImageConnection(connection: LlmConnectionWithStatus): boolean {
  if (connection.oauthProvider === 'tokennest') return true
  return (connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint')
    && (connection.piAuthProvider === 'openai' || connection.customEndpoint?.api === 'openai-completions')
}

export function imageGroups(connection: LlmConnectionWithStatus) {
  if (connection.oauthProvider !== 'tokennest') return []
  return (connection.channelGroups ?? []).filter(group => group.models?.some(isImageGenerationModelId))
}

export function preferredImageGroup(connection: LlmConnectionWithStatus): string {
  const groups = imageGroups(connection)
  return groups.find(group => group.name === 'GPT图片生成渠道')?.id
    ?? groups.find(group => group.models?.some(isImageGenerationModelId))?.id
    ?? groups[0]?.id ?? ''
}

export function imageModels(connection: LlmConnectionWithStatus, groupId = ''): string[] {
  const configured = (connection.models ?? []).map(model => typeof model === 'string' ? model : model.id)
  const groupModels = connection.oauthProvider === 'tokennest'
    ? imageGroups(connection).find(group => group.id === groupId)?.models
    : undefined
  const candidates = connection.oauthProvider === 'tokennest' ? groupModels ?? [] : configured
  const found = [...new Set(candidates.filter(isImageGenerationModelId))]
  if (found.length) return found
  // Agent presets list chat models only. The official OpenAI API key can still use GPT Image.
  if (connection.oauthProvider !== 'tokennest' && connection.piAuthProvider === 'openai'
    && (!connection.baseUrl || /^https:\/\/api\.openai\.com\/v1\/?$/i.test(connection.baseUrl))) return ['gpt-image-1']
  return []
}
