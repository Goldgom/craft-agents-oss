import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as config from '@craft-agent/shared/config'
import * as credentials from '@craft-agent/shared/credentials'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { registerLlmConnectionsHandlers } from './llm-connections'

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
  const setLlmOAuth = mock(async (_slug: string, _tokens: unknown) => {})
  const deleteLlmCredentials = mock(async (_slug: string) => {})
  const credentialManager = { setLlmOAuth, deleteLlmCredentials }
  spyOn(credentials, 'getCredentialManager').mockReturnValue(credentialManager as never)
  spyOn(config, 'getLlmConnection').mockImplementation(slug => existing?.slug === slug ? existing : null)
  spyOn(config, 'getDefaultLlmConnection').mockReturnValue(null)
  const add = spyOn(config, 'addLlmConnection').mockReturnValue(true)
  const update = spyOn(config, 'updateLlmConnection').mockReturnValue(true)
  const setDefault = spyOn(config, 'setDefaultLlmConnection').mockReturnValue(true)
  return { add, update, setDefault, setLlmOAuth, deleteLlmCredentials }
}

function stubTokenNestFetch(options?: { models?: string[]; modelStatus?: number }) {
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
})
