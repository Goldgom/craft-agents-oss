import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as config from '@craft-agent/shared/config'
import * as credentials from '@craft-agent/shared/credentials'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { registerLlmConnectionsHandlers, refreshTokenNestModelsAtStartup } from './llm-connections'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

function createHarness() {
  const handlers = new Map<string, HandlerFn>()
  const reinitializeAuth = mock(async (_slug: string) => {})
  const server = {
    handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as RpcServer
  const deps = {
    sessionManager: { reinitializeAuth },
    oauthFlowStore: {},
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      imageProcessor: { getMetadata: async () => null, process: async () => Buffer.from('') },
    },
  } as unknown as HandlerDeps
  registerLlmConnectionsHandlers(server, deps)

  const context: RequestContext = {
    clientId: 'client-1',
    workspaceId: null,
    webContentsId: null,
  }
  const getHandler = (channel: string) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`Handler not registered: ${channel}`)
    return handler
  }
  return { context, getHandler, reinitializeAuth }
}

function stubStorage(existing: config.LlmConnection | null = null) {
  let oauth = { accessToken: 'stored-access-token', refreshToken: 'stored-refresh-token', expiresAt: Date.now() + 60 * 60_000 }
  const getLlmOAuth = mock(async (_slug: string) => oauth)
  const setLlmOAuth = mock(async (_slug: string, tokens: typeof oauth) => { oauth = { ...oauth, ...tokens } })
  const deleteLlmCredentials = mock(async (_slug: string) => {})
  const credentialManager = { getLlmOAuth, setLlmOAuth, deleteLlmCredentials }
  spyOn(credentials, 'getCredentialManager').mockReturnValue(credentialManager as never)
  spyOn(config, 'getLlmConnection').mockImplementation(slug => existing?.slug === slug ? existing : null)
  spyOn(config, 'getDefaultLlmConnection').mockReturnValue(null)
  const add = spyOn(config, 'addLlmConnection').mockReturnValue(true)
  const update = spyOn(config, 'updateLlmConnection').mockReturnValue(true)
  const setDefault = spyOn(config, 'setDefaultLlmConnection').mockReturnValue(true)
  return { add, update, setDefault, getLlmOAuth, setLlmOAuth, deleteLlmCredentials }
}

function stubTokenNestFetch(options?: { models?: string[]; modelStatus?: number; groupStatus?: number; groups?: Record<string, { desc: string; ratio: number; models: string[] }> }) {
  const requests: Array<{ url: string; method: string; authorization?: string }> = []
  const models = options?.models ?? ['gpt-5', 'gpt-4.1']
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    requests.push({ url, method, authorization: headers.get('authorization') ?? undefined })
    if (url.endsWith('/api/oauth2/token')) {
      return Response.json({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        scope: 'api balance:read offline_access',
      })
    }
    if (url.endsWith('/v1/models')) {
      const status = options?.modelStatus ?? 200
      return Response.json({ data: models.map(id => ({ id })) }, { status })
    }
    if (url.endsWith('/api/oauth2/groups')) return Response.json({ data: options?.groups ?? {
      default: { desc: 'Default', ratio: 1, models },
    } }, { status: options?.groupStatus ?? 200 })
    if (url.endsWith('/api/oauth2/revoke')) return new Response(null, { status: 200 })
    throw new Error(`Unexpected request: ${method} ${url}`)
  }) as unknown as typeof fetch
  return requests
}

async function startAndComplete(harness: ReturnType<typeof createHarness>, connectionSlug = 'tokennest') {
  const start = harness.getHandler(RPC_CHANNELS.tokennest.START_OAUTH)
  const complete = harness.getHandler(RPC_CHANNELS.tokennest.COMPLETE_OAUTH)
  const flow = await start(harness.context, {
    connectionSlug,
    callbackUrl: 'http://127.0.0.1:6477/callback',
  }) as { flowId: string; state: string }
  return complete(harness.context, { flowId: flow.flowId, state: flow.state, code: 'authorization-code' })
}

describe('TokenNest OAuth RPC handlers', () => {
  it('defaults the Agent connection to the TokenBird group and a text model', async () => {
    const storage = stubStorage()
    stubTokenNestFetch({
      models: ['gpt-image-2.5', 'gpt-6-astra'],
      groups: {
        drawing: { desc: 'GPT图片生成渠道', ratio: 1, models: ['gpt-image-2.5'] },
        tokenbird: { desc: 'TokenBird', ratio: 1, models: ['gpt-6-astra'] },
      },
    })
    const harness = createHarness()

    await expect(startAndComplete(harness)).resolves.toEqual({ success: true })
    expect(storage.add).toHaveBeenCalledWith(expect.objectContaining({
      channelGroup: 'tokenbird', defaultModel: 'gpt-6-astra',
    }))
  })

  it('creates a ready-to-use connection after OAuth and model discovery', async () => {
    const storage = stubStorage()
    const requests = stubTokenNestFetch()
    const harness = createHarness()

    await expect(startAndComplete(harness)).resolves.toEqual({ success: true })

    expect(storage.setLlmOAuth).toHaveBeenCalledWith('tokennest', expect.objectContaining({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    }))
    expect(storage.add).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'tokennest',
      name: 'TokenNest',
      authType: 'oauth',
      oauthProvider: 'tokennest',
      baseUrl: 'https://openai.goldgom.top/v1',
      models: ['gpt-5', 'gpt-4.1'],
      defaultModel: 'gpt-5',
    }))
    expect(storage.setDefault).toHaveBeenCalledWith('tokennest')
    expect(harness.reinitializeAuth).toHaveBeenCalledWith('tokennest')
    expect(requests.find(request => request.url.endsWith('/v1/models'))?.authorization)
      .toBe('Bearer new-access-token')
  })

  it('revokes the new token and does not persist when model discovery fails', async () => {
    const storage = stubStorage()
    const requests = stubTokenNestFetch({ models: [], modelStatus: 500 })
    const harness = createHarness()

    const result = await startAndComplete(harness) as { success: boolean; error?: string }

    expect(result.success).toBe(false)
    expect(result.error).toContain('Provider returned 500')
    expect(storage.setLlmOAuth).not.toHaveBeenCalled()
    expect(storage.add).not.toHaveBeenCalled()
    expect(requests.some(request => request.url.endsWith('/api/oauth2/revoke'))).toBe(true)
  })

  it('reauthorizes the existing connection and preserves its identity and valid default model', async () => {
    const existing: config.LlmConnection = {
      slug: 'company-tokennest',
      name: '团队 TokenNest',
      providerType: 'pi_compat',
      authType: 'oauth',
      oauthProvider: 'tokennest',
      piAuthProvider: 'openai',
      baseUrl: 'https://openai.goldgom.top/v1',
      customEndpoint: { api: 'openai-completions' },
      models: ['old-model'],
      defaultModel: 'gpt-4.1',
      modelSelectionMode: 'automaticallySyncedFromProvider',
      createdAt: 1234,
    }
    const storage = stubStorage(existing)
    stubTokenNestFetch()
    const harness = createHarness()

    await expect(startAndComplete(harness, existing.slug)).resolves.toEqual({ success: true })

    expect(storage.add).not.toHaveBeenCalled()
    expect(storage.update).toHaveBeenCalledWith(existing.slug, expect.objectContaining({
      name: '团队 TokenNest',
      createdAt: 1234,
      models: ['gpt-5', 'gpt-4.1'],
      defaultModel: 'gpt-4.1',
      oauthProvider: 'tokennest',
    }))
    expect(storage.setLlmOAuth).toHaveBeenCalledWith(existing.slug, expect.objectContaining({
      accessToken: 'new-access-token',
    }))
    expect(harness.reinitializeAuth).toHaveBeenCalledWith(existing.slug)
  })

  it('keeps the existing connection when group discovery fails during reauthorization', async () => {
    const existing = {
      slug: 'tokennest', name: 'TokenNest', providerType: 'pi_compat', authType: 'oauth',
      oauthProvider: 'tokennest', createdAt: 1,
      channelGroup: 'Normal', channelGroups: [{ id: 'Normal', name: 'Normal' }],
    } as config.LlmConnection
    const storage = stubStorage(existing)
    const requests = stubTokenNestFetch({ groupStatus: 503 })

    const result = await startAndComplete(createHarness()) as { success: boolean; error?: string }
    expect(result.success).toBe(false)
    expect(result.error).toContain('HTTP 503')
    expect(storage.setLlmOAuth).not.toHaveBeenCalled()
    expect(storage.update).not.toHaveBeenCalled()
    expect(requests.some(request => request.url.endsWith('/api/oauth2/revoke'))).toBe(true)
  })

  it('refreshes TokenNest models and groups with automatically renewed credentials', async () => {
    const existing: config.LlmConnection = {
      slug: 'tokennest', name: 'TokenNest', providerType: 'pi_compat', authType: 'oauth',
      oauthProvider: 'tokennest', piAuthProvider: 'openai', baseUrl: 'https://openai.goldgom.top/v1',
      customEndpoint: { api: 'openai-completions' }, models: ['old-model'], defaultModel: 'old-model',
      modelSelectionMode: 'automaticallySyncedFromProvider', createdAt: 1,
      channelGroup: 'Normal', channelGroups: [{ id: 'Normal', name: 'Normal', models: ['gpt-image-2.5'] }],
    }
    const storage = stubStorage(existing)
    stubTokenNestFetch({ models: ['gpt-5.6-sol', 'gpt-5.6-terra'] })
    const harness = createHarness()

    const result = await harness.getHandler(RPC_CHANNELS.llmConnections.REFRESH_MODELS)(harness.context, existing.slug)

    expect(result).toEqual({ success: true })
    expect(storage.update).toHaveBeenCalledWith(existing.slug, expect.objectContaining({
      models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
      channelGroup: 'default',
      defaultModel: 'gpt-5.6-sol',
      channelGroups: [{ id: 'default', name: 'Default', ratio: 1, models: ['gpt-5.6-sol', 'gpt-5.6-terra'] }],
    }))
    expect(harness.reinitializeAuth).toHaveBeenCalledWith(existing.slug)
  })

  it('refreshes TokenNest connections once at startup and skips other providers', async () => {
    const existing: config.LlmConnection = {
      slug: 'tokennest', name: 'TokenNest', providerType: 'pi_compat', authType: 'oauth',
      oauthProvider: 'tokennest', piAuthProvider: 'openai', baseUrl: 'https://openai.goldgom.top/v1',
      customEndpoint: { api: 'openai-completions' }, models: ['old-model'], defaultModel: 'old-model',
      modelSelectionMode: 'automaticallySyncedFromProvider', createdAt: 1,
    }
    const storage = stubStorage(existing)
    spyOn(config, 'getLlmConnections').mockReturnValue([existing, {
      ...existing, slug: 'other', oauthProvider: undefined,
    }])
    const requests = stubTokenNestFetch({ models: ['gpt-5.6-sol'] })
    const harness = createHarness()

    refreshTokenNestModelsAtStartup({
      sessionManager: { reinitializeAuth: harness.reinitializeAuth },
      platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    } as unknown as HandlerDeps)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(requests.filter(request => request.url.endsWith('/v1/models'))).toHaveLength(1)
    expect(storage.update).toHaveBeenCalledWith('tokennest', expect.objectContaining({ models: ['gpt-5.6-sol'] }))
    expect(harness.reinitializeAuth).toHaveBeenCalledWith('tokennest')
  })

  it('returns provider-authoritative daily and model usage aggregates', async () => {
    const existing: config.LlmConnection = {
      slug: 'tokennest', name: 'TokenNest', providerType: 'pi_compat', authType: 'oauth',
      oauthProvider: 'tokennest', piAuthProvider: 'openai', baseUrl: 'https://openai.goldgom.top/v1',
      customEndpoint: { api: 'openai-completions' }, models: ['gpt-5'], defaultModel: 'gpt-5',
      modelSelectionMode: 'automaticallySyncedFromProvider', createdAt: 1,
    }
    stubStorage(existing)
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/summary')) return Response.json({ data: {
        start_timestamp: 10, end_timestamp: 20, request_count: 2, input_tokens: 30,
        output_tokens: 10, total_tokens: 40, charged_amount_usd: 0.003, currency: 'USD',
      } })
      if (url.pathname.endsWith('/records')) return Response.json({ data: { total: 2, page: 1, page_size: 100, items: [
        { timestamp: 15, model: 'gpt-5', group: 'default', input_tokens: 20, output_tokens: 5, total_tokens: 25, charged_amount_usd: 0.002, status: 'succeeded', request_id: 'one' },
        { timestamp: 16, model: 'gpt-5', group: 'default', input_tokens: 10, output_tokens: 5, total_tokens: 15, charged_amount_usd: 0.001, status: 'succeeded', request_id: 'two' },
      ] } })
      throw new Error(`Unexpected request: ${url}`)
    }) as unknown as typeof fetch
    const harness = createHarness()

    const result = await harness.getHandler(RPC_CHANNELS.tokennest.GET_USAGE)(harness.context, { connectionSlug: existing.slug, days: 30 }) as import('@craft-agent/shared/protocol').TokenNestUsageSnapshot

    expect(result.totalTokens).toBe(40)
    expect(result.byModel).toEqual([expect.objectContaining({ key: 'gpt-5', requests: 2, totalTokens: 40 })])
    expect(result.daily).toHaveLength(1)
    expect(result.recentRecords).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })
})
