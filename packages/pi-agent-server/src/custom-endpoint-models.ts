import type { StreamFn } from '@earendil-works/pi-agent-core'

/** Let compatible endpoints choose their output limit unless the caller supplied
 * one. Pi's synthetic model capacity is context bookkeeping, not an upstream
 * capability: forwarding its 8192 default can exhaust a reasoning-only reply.
 * Explicit budgets (including compaction) and Anthropic's required limit remain. */
export function withCustomEndpointOutputDefaults(stream: StreamFn): StreamFn {
  return (model, context, options) => {
    if (model.provider !== 'custom-endpoint' || options?.maxTokens !== undefined ||
      !['openai-completions', 'openai-responses'].includes(model.api)) {
      return stream(model, context, options)
    }
    return stream(model, context, {
      ...options,
      onPayload: async (payload, requestModel) => {
        let result = payload
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const body = { ...payload } as Record<string, unknown>
          delete body.max_tokens
          delete body.max_completion_tokens
          delete body.max_output_tokens
          result = body
        }
        return await options?.onPayload?.(result, requestModel) ?? result
      },
    })
  }
}

export type CustomEndpointInput = 'text' | 'image'

/** Custom endpoint protocol — determines which streaming adapter Pi SDK uses. */
export type CustomEndpointApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

export interface CustomEndpointModelDefaults {
  supportsImages?: boolean
}

export interface CustomEndpointModelOverrides {
  contextWindow?: number
  supportsImages?: boolean
}

export interface CustomEndpointModelEntry extends CustomEndpointModelOverrides {
  id: string
}

export type CustomEndpointModelConfig = string | {
  id: string
  contextWindow?: number
  supportsImages?: boolean
}

/** Strip bare model IDs (remove pi/ prefix if present). */
export function stripPiPrefix(id: string): string {
  return id.startsWith('pi/') ? id.slice(3) : id
}

/**
 * Normalize a user-configured custom endpoint model for Pi SDK registration.
 *
 * Keep explicit per-model capability overrides intact. In particular,
 * `supportsImages: false` is meaningful because it can override a global
 * endpoint default of `supportsImages: true` for text-only models.
 */
export function normalizeCustomEndpointModelEntry(model: CustomEndpointModelConfig): CustomEndpointModelEntry {
  if (typeof model === 'string') {
    return { id: stripPiPrefix(model) }
  }

  return {
    id: stripPiPrefix(model.id),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
  }
}

/**
 * Build a synthetic model definition for a custom endpoint.
 * Uses reasonable defaults for context window and max tokens since we can't
 * query the endpoint for its actual capabilities. Image support defaults on
 * so GPT, DeepSeek, and other compatible models can receive images without
 * extra setup, while explicit connection/per-model `false` values remain
 * authoritative for text-only models.
 *
 * For `openai-completions` endpoints we set `compat.supportsStore = false` so the
 * pi-ai driver omits the OpenAI-platform-specific `store` param entirely. Third-party
 * OpenAI-compatible gateways gain nothing from `store`, and strict ones reject unknown
 * params with a 400 — which made those connections unusable. See tokenbird#1022.
 */
export function buildCustomEndpointModelDef(
  id: string,
  defaults?: CustomEndpointModelDefaults,
  overrides?: CustomEndpointModelOverrides,
  api?: CustomEndpointApi,
) {
  const supportsImages = overrides?.supportsImages ?? defaults?.supportsImages ?? true
  const input: CustomEndpointInput[] = supportsImages ? ['text', 'image'] : ['text']

  return {
    id,
    name: id,
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides?.contextWindow ?? 1_000_000,
    maxTokens: 8_192,
    ...(api === 'openai-completions' ? { compat: { supportsStore: false } } : {}),
  }
}

/** Keep an omitted endpoint capability omitted when registering Pi models. */
export function buildCustomEndpointProviderModels(
  ids: string[],
  endpoint: { api: CustomEndpointApi; supportsImages?: boolean } | undefined,
  overrides: ReadonlyMap<string, CustomEndpointModelOverrides>,
) {
  return ids.map(id => buildCustomEndpointModelDef(
    id,
    endpoint,
    overrides.get(id),
    endpoint?.api,
  ))
}
