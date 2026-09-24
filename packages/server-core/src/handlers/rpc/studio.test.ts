import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as config from '@craft-agent/shared/config'
import * as credentials from '@craft-agent/shared/credentials'
import * as auth from '@craft-agent/shared/auth'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RpcServer } from '@craft-agent/server-core/transport'
import { deflateRawSync } from 'node:zlib'
import { registerStudioHandlers } from './studio'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; mock.restore() })

function harness() {
  const handlers = new Map<string, HandlerFn>()
  registerStudioHandlers({ handle: (channel, fn) => { handlers.set(channel, fn) } } as RpcServer)
  return (channel: string, input: unknown) => handlers.get(channel)!({ clientId: 'test', workspaceId: null, webContentsId: null }, input)
}

function connection() {
  spyOn(config, 'getLlmConnection').mockReturnValue({
    slug: 'gptimage', name: 'GPT Image', providerType: 'pi_compat', authType: 'api_key_with_endpoint',
    baseUrl: 'https://images.example/v1', createdAt: 1,
  })
  spyOn(credentials, 'getCredentialManager').mockReturnValue({ getLlmApiKey: async () => 'secret' } as never)
}

describe('Studio server requests', () => {
  it('uses the server-owned API key for GPT Image generation', async () => {
    connection()
    let request: RequestInit | undefined
    globalThis.fetch = mock(async (_url, init) => { request = init; return Response.json({ data: [{ b64_json: 'aGVsbG8=' }] }) }) as unknown as typeof fetch
    const invoke = harness()
    const result = await invoke(RPC_CHANNELS.studio.GENERATE_IMAGE, { connectionSlug: 'gptimage', model: 'gpt-image-1', prompt: 'A tree' })
    expect(result.imageBase64).toBe('aGVsbG8=')
    expect(new Headers(request?.headers).get('authorization')).toBe('Bearer secret')
    expect(JSON.parse(String(request?.body))).toEqual({ model: 'gpt-image-1', prompt: 'A tree', size: '1024x1024' })
  })

  it('requests and returns multiple image candidates', async () => {
    connection()
    let body: string | undefined
    globalThis.fetch = mock(async (_url, init) => {
      body = init?.body as string
      return Response.json({ data: [{ b64_json: 'aGVsbG8=' }, { b64_json: 'd29ybGQ=' }] })
    }) as unknown as typeof fetch
    const result = await harness()(RPC_CHANNELS.studio.GENERATE_IMAGE, {
      connectionSlug: 'gptimage', model: 'gpt-image-1', prompt: 'A tree', count: 2,
    })
    expect(JSON.parse(body!).n).toBe(2)
    expect(result.images.map((image: { imageBase64: string }) => image.imageBase64)).toEqual(['aGVsbG8=', 'd29ybGQ='])
    expect(result.imageBase64).toBe('aGVsbG8=')
  })

  it('rejects image counts outside the supported range before dispatch', async () => {
    connection()
    const request = mock(async () => Response.json({ data: [{ b64_json: 'aGVsbG8=' }] }))
    globalThis.fetch = request as unknown as typeof fetch
    await expect(harness()(RPC_CHANNELS.studio.GENERATE_IMAGE, {
      connectionSlug: 'gptimage', model: 'gpt-image-1', prompt: 'A tree', count: 5,
    })).rejects.toThrow('Image count must be between 1 and 4')
    expect(request).not.toHaveBeenCalled()
  })

  it('sends an image and transparent mask to the edit endpoint', async () => {
    connection()
    const png = 'iVBORw0KGgo=' // PNG signature is sufficient for input validation
    let url = ''
    let body: FormData | undefined
    globalThis.fetch = mock(async (input, init) => { url = String(input); body = init?.body as FormData; return Response.json({ data: [{ b64_json: png }] }) }) as unknown as typeof fetch
    const invoke = harness()
    await invoke(RPC_CHANNELS.studio.GENERATE_IMAGE, { connectionSlug: 'gptimage', model: 'gpt-image-1', prompt: 'Fill', imageBase64: png, maskBase64: png, count: 2 })
    expect(url).toBe('https://images.example/v1/images/edits')
    expect(body?.get('image')).toBeInstanceOf(File)
    expect(body?.get('mask')).toBeInstanceOf(File)
    expect(body?.get('n')).toBe('2')
  })

  it('requests transparent output for GPT Image background removal', async () => {
    connection()
    const png = 'iVBORw0KGgo='
    let body: FormData | undefined
    globalThis.fetch = mock(async (_url, init) => { body = init?.body as FormData; return Response.json({ data: [{ b64_json: png }] }) }) as unknown as typeof fetch
    await harness()(RPC_CHANNELS.studio.GENERATE_IMAGE, {
      connectionSlug: 'gptimage', model: 'gpt-image-1', prompt: 'Remove background',
      imageBase64: png, transparentBackground: true,
    })
    expect(body?.get('background')).toBe('transparent')
  })

  it('routes image generation through the selected TokenNest image group', async () => {
    spyOn(config, 'getLlmConnection').mockReturnValue({
      slug: 'tokennest', name: 'TokenNest', providerType: 'pi_compat', authType: 'oauth',
      oauthProvider: 'tokennest', channelGroup: 'chat',
      channelGroups: [{ id: 'chat', name: '聊天', models: ['gpt-text'] }, { id: 'drawing', name: 'GPT图片生成渠道', models: ['gpt-image-1'] }],
      createdAt: 1,
    } as never)
    spyOn(credentials, 'getCredentialManager').mockReturnValue({} as never)
    spyOn(auth, 'getValidTokenNestCredentials').mockResolvedValue({ accessToken: 'oauth-access' } as never)
    let request: RequestInit | undefined
    globalThis.fetch = mock(async (_url, init) => { request = init; return Response.json({ data: [{ b64_json: 'aGVsbG8=' }] }) }) as unknown as typeof fetch
    const invoke = harness()
    await invoke(RPC_CHANNELS.studio.GENERATE_IMAGE, { connectionSlug: 'tokennest', channelGroup: 'drawing', model: 'gpt-image-1', prompt: 'A tree' })
    expect(new Headers(request?.headers).get('X-TokenNest-Group')).toBe('drawing')
    expect(new Headers(request?.headers).get('Authorization')).toBe('Bearer oauth-access')
    expect(invoke(RPC_CHANNELS.studio.GENERATE_IMAGE, { connectionSlug: 'tokennest', channelGroup: 'chat', model: 'gpt-image-1', prompt: 'A tree' }))
      .rejects.toThrow('STUDIO_TOKENNEST_CHANNEL_UNAVAILABLE')
  })

  it('sends a Chinese TokenNest image group as UTF-8 header bytes', async () => {
    const group = 'GPT图片生成渠道'
    spyOn(config, 'getLlmConnection').mockReturnValue({
      slug: 'tokennest', name: 'TokenNest', providerType: 'pi_compat', authType: 'oauth',
      oauthProvider: 'tokennest', channelGroup: 'Normal',
      channelGroups: [{ id: group, name: group, models: ['gpt-image-2.5'] }], createdAt: 1,
    } as never)
    spyOn(credentials, 'getCredentialManager').mockReturnValue({} as never)
    spyOn(auth, 'getValidTokenNestCredentials').mockResolvedValue({ accessToken: 'oauth-access' } as never)
    let request: RequestInit | undefined
    globalThis.fetch = mock(async (_url, init) => {
      request = init
      // Constructing Headers reproduces Fetch's ByteString validation.
      new Headers(init?.headers)
      return Response.json({ data: [{ b64_json: 'aGVsbG8=' }] })
    }) as unknown as typeof fetch

    await harness()(RPC_CHANNELS.studio.GENERATE_IMAGE, {
      connectionSlug: 'tokennest', channelGroup: group, model: 'gpt-image-2.5', prompt: 'A tree',
    })
    const header = new Headers(request?.headers).get('X-TokenNest-Group')!
    expect(Buffer.from(header, 'latin1').toString('utf8')).toBe(group)
  })

  it('does not send an image request without an available OAuth image group', async () => {
    spyOn(config, 'getLlmConnection').mockReturnValue({
      slug: 'tokennest', name: 'TokenNest', providerType: 'pi_compat', authType: 'oauth',
      oauthProvider: 'tokennest', channelGroup: 'Normal', createdAt: 1,
    } as never)
    spyOn(credentials, 'getCredentialManager').mockReturnValue({} as never)
    spyOn(auth, 'getValidTokenNestCredentials').mockResolvedValue({ accessToken: 'old-oauth-access' } as never)
    const request = mock(async () => Response.json({ data: [{ b64_json: 'aGVsbG8=' }] }))
    globalThis.fetch = request as unknown as typeof fetch

    await expect(harness()(RPC_CHANNELS.studio.GENERATE_IMAGE, {
      connectionSlug: 'tokennest', model: 'gpt-image-2.5', prompt: 'A tree',
    })).rejects.toThrow('STUDIO_TOKENNEST_CHANNEL_UNAVAILABLE')
    expect(request).not.toHaveBeenCalled()
  })

  it('asks for OAuth reauthorization when an image request reveals missing group scope', async () => {
    spyOn(config, 'getLlmConnection').mockReturnValue({
      slug: 'tokennest', name: 'TokenNest', providerType: 'pi_compat', authType: 'oauth',
      oauthProvider: 'tokennest', channelGroup: 'Normal',
      channelGroups: [{ id: 'drawing', name: 'GPT图片生成渠道', models: ['gpt-image-2.5'] }], createdAt: 1,
    } as never)
    spyOn(credentials, 'getCredentialManager').mockReturnValue({} as never)
    spyOn(auth, 'getValidTokenNestCredentials').mockResolvedValue({ accessToken: 'old-oauth-access' } as never)
    globalThis.fetch = mock(async input => String(input).endsWith('/api/oauth2/groups')
      ? Response.json({ error: 'insufficient_scope' }, { status: 403 })
      : Response.json({ error: { message: '分组 drawing 下模型 gpt-image-2.5 无可用渠道（distributor）' } }, { status: 503 })) as unknown as typeof fetch

    await expect(harness()(RPC_CHANNELS.studio.GENERATE_IMAGE, {
      connectionSlug: 'tokennest', channelGroup: 'drawing', model: 'gpt-image-2.5', prompt: 'A tree',
    })).rejects.toThrow('STUDIO_TOKENNEST_REAUTH_REQUIRED')
  })

  it('keeps a no-channel failure distinct when OAuth group access still works', async () => {
    spyOn(config, 'getLlmConnection').mockReturnValue({
      slug: 'tokennest', name: 'TokenNest', providerType: 'pi_compat', authType: 'oauth',
      oauthProvider: 'tokennest', channelGroup: 'Normal',
      channelGroups: [{ id: 'Normal', name: 'Normal', models: ['gpt-image-2.5'] }], createdAt: 1,
    } as never)
    spyOn(credentials, 'getCredentialManager').mockReturnValue({} as never)
    spyOn(auth, 'getValidTokenNestCredentials').mockResolvedValue({ accessToken: 'current-oauth-access' } as never)
    globalThis.fetch = mock(async input => String(input).endsWith('/api/oauth2/groups')
      ? Response.json({ data: { Normal: { desc: 'Normal', models: ['gpt-image-2.5'] } } })
      : Response.json({ error: { message: '分组 Normal 下模型 gpt-image-2.5 无可用渠道（distributor）' } }, { status: 503 })) as unknown as typeof fetch

    await expect(harness()(RPC_CHANNELS.studio.GENERATE_IMAGE, {
      connectionSlug: 'tokennest', channelGroup: 'Normal', model: 'gpt-image-2.5', prompt: 'A tree',
    })).rejects.toThrow('STUDIO_TOKENNEST_CHANNEL_UNAVAILABLE')
  })

  it('sends the existing draw.io document and returns an editable revision', async () => {
    connection()
    const currentXml = '<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="topic" value="Plan" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>'
    const changedXml = currentXml.replace('value="Plan"', 'value="Revised plan"')
    let body: { model: string; messages: { content: string }[] } | undefined
    globalThis.fetch = mock(async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ choices: [{ message: { content: JSON.stringify({ xml: changedXml, summary: '已修改主题' }) } }] })
    }) as unknown as typeof fetch
    const invoke = harness()
    expect(await invoke(RPC_CHANNELS.studio.GENERATE_MIND_MAP, { connectionSlug: 'gptimage', model: 'gpt-4.1', prompt: 'Rename topic', currentXml, priorRequests: ['Create a plan'] }))
      .toEqual({ xml: changedXml, summary: '已修改主题' })
    expect(body?.model).toBe('gpt-4.1')
    expect(JSON.parse(body!.messages[1].content)).toEqual({ instruction: 'Rename topic', priorRequests: ['Create a plan'], currentXml })
  })

  it('expands compressed draw.io input before asking the model to edit it', async () => {
    connection()
    const graph = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="topic" value="Plan" vertex="1" parent="1"/></root></mxGraphModel>'
    const compressed = deflateRawSync(Buffer.from(encodeURIComponent(graph))).toString('base64')
    let body: { messages: { content: string }[] } | undefined
    globalThis.fetch = mock(async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ choices: [{ message: { content: `<mxfile><diagram>${graph}</diagram></mxfile>` } }] })
    }) as unknown as typeof fetch
    await harness()(RPC_CHANNELS.studio.GENERATE_MIND_MAP, { connectionSlug: 'gptimage', model: 'gpt-4.1', prompt: 'Change color', currentXml: `<mxfile><diagram>${compressed}</diagram></mxfile>` })
    expect(JSON.parse(body!.messages[1].content).currentXml).toContain('id="topic"')
  })

  it('does not preserve an empty editor scaffold as diagram content', async () => {
    connection()
    let body: { messages: { content: string }[] } | undefined
    const xml = '<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>'
    globalThis.fetch = mock(async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ choices: [{ message: { content: xml } }] })
    }) as unknown as typeof fetch
    await harness()(RPC_CHANNELS.studio.GENERATE_MIND_MAP, { connectionSlug: 'gptimage', model: 'gpt-4.1', prompt: 'New plan', currentXml: xml })
    expect(JSON.parse(body!.messages[1].content).currentXml).toBeNull()
  })

  it('rejects an invalid mind map response', async () => {
    connection()
    globalThis.fetch = mock(async () => Response.json({ choices: [{ message: { content: '{"title":"Plan","children":[{"title":"A"}]}' } }] })) as unknown as typeof fetch
    await expect(harness()(RPC_CHANNELS.studio.GENERATE_MIND_MAP, { connectionSlug: 'gptimage', model: 'gpt-4.1', prompt: 'Make a plan' }))
      .rejects.toThrow('AI did not return draw.io XML')
  })
})
