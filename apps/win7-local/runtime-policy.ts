import { getDefaultModelForConnection, getDefaultModelsForConnection } from '@craft-agent/shared/config'

export const NATIVE_BACKEND_ERROR = '当前 Claude Code / 原生 Codex 后端不支持 Win7。请使用 API Key 或 Pi 后端；Claude API 模型仍可在本机运行。'

/** Translate native Anthropic API setup without altering the original form. */
export function normalizeWin7Setup(setup: any, existing?: any) {
  if (/^claude-max(?:-\d+)?$/.test(setup.slug) || existing?.agentRuntime === 'codex') throw new Error(NATIVE_BACKEND_ERROR)
  const anthropic = /^anthropic-api(?:-\d+)?$/.test(setup.slug) || existing?.providerType === 'anthropic'
  if (!anthropic || setup.customEndpoint) return setup
  return {
    ...setup,
    baseUrl: setup.baseUrl?.trim() || existing?.baseUrl || 'https://api.anthropic.com',
    customEndpoint: { api: 'anthropic-messages' }, piAuthProvider: 'anthropic',
    models: setup.models || existing?.models || getDefaultModelsForConnection('anthropic'),
    defaultModel: setup.defaultModel || existing?.defaultModel || getDefaultModelForConnection('anthropic'),
  }
}

export function normalizeWin7Test(params: any) {
  if (params.provider !== 'anthropic') return params
  return {
    ...params, provider: 'pi', piAuthProvider: 'anthropic',
    baseUrl: params.baseUrl?.trim() || 'https://api.anthropic.com',
    customEndpoint: params.customEndpoint || { api: 'anthropic-messages' },
    model: params.model || getDefaultModelForConnection('anthropic'),
  }
}
