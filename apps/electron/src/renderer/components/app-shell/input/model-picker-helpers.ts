import {
  isImageGenerationModelId,
  isLocalConnection,
  type LlmConnection,
} from '@config/llm-connections'
import { ANTHROPIC_MODELS, getModelShortName, type ModelDefinition } from '@config/models'

type PickerModel = ModelDefinition | string

const modelSources: ReadonlyArray<readonly [string, RegExp]> = [
  ['OpenAI', /^(?:openai|gpt|chatgpt|codex)(?=$|[\W_\d])|^o\d+(?=$|[\W_])/i],
  ['Anthropic', /^(?:anthropic|claude|opus|sonnet|haiku)(?=$|[\W_\d])/i],
  ['Google AI', /^(?:google|gemini|gemma)(?=$|[\W_\d])/i],
  ['DeepSeek', /^deep[ -]?seek(?=$|[\W_\d])/i],
  ['Alibaba', /^(?:alibaba|qwen|qwq|tongyi|通义千问)(?=$|[\W_\d])/i],
  ['MiniMax', /^minimax(?=$|[\W_\d])/i],
  ['Zhipu AI', /^(?:zhipu|z-ai|glm|chatglm)(?=$|[\W_\d])/i],
  ['Moonshot AI', /^(?:moonshot|kimi)(?=$|[\W_\d])/i],
  ['xAI', /^(?:xai|grok)(?=$|[\W_\d])/i],
  ['Meta', /^(?:meta|llama)(?=$|[\W_\d])/i],
  ['Mistral AI', /^(?:mistral|mixtral|codestral|devstral|magistral|pixtral)(?=$|[\W_\d])/i],
  ['ByteDance', /^(?:bytedance|doubao|豆包|seedream|seedance)(?=$|[\W_\d])/i],
  ['Cohere', /^(?:cohere|command-r)(?=$|[\W_\d])/i],
  ['Perplexity', /^perplexity(?=$|[\W_\d])/i],
]

export function getPickerModelName(model: PickerModel): string {
  return typeof model === 'string'
    ? stripPiPrefixForDisplay(getModelShortName(model))
    : (model.name ?? stripPiPrefixForDisplay(model.id))
}

export function groupPickerModels(models: readonly PickerModel[], query: string) {
  const groups = new Map<string, PickerModel[]>()
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  for (const model of models) {
    const id = typeof model === 'string' ? model : model.id
    const name = getPickerModelName(model)
    const parts = stripPiPrefixForDisplay(id).split('/')
    // Prefer the model ID and its namespace over an editable display alias.
    const modelId = (parts.pop() ?? '').replace(/^(?:us|eu|apac|global)\./i, '')
    let source = 'other'
    for (const label of [modelId, ...parts.reverse(), name, typeof model === 'string' ? '' : model.provider]) {
      const match = modelSources.find(([, pattern]) => pattern.test(label))
      if (match) {
        source = match[0]
        break
      }
    }
    const searchText = `${id} ${name} ${source}`.toLowerCase()
    if (!terms.every(term => searchText.includes(term))) continue
    const group = groups.get(source)
    if (group) group.push(model)
    else groups.set(source, [model])
  }
  // Preserve the connection's ordering within each group and put unknown models last.
  return [...modelSources.map(([source]) => source), 'other'].flatMap(source => {
    const models = groups.get(source)
    return models ? [{ source, models }] : []
  })
}

export function groupPickerConnectionModels<T extends LlmConnection & { isAuthenticated: boolean }>(
  providers: ReadonlyArray<[string, T[]]>,
  query: string,
) {
  return providers.flatMap(([provider, connections]) => {
    const entries = connections.flatMap(connection => {
      const groups = connection.isAuthenticated ? groupPickerModels(getAgentModelsForConnection(connection), query) : []
      return !query.trim() || groups.length ? [{ connection, groups }] : []
    })
    return entries.length ? [{ provider, entries }] : []
  })
}

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
