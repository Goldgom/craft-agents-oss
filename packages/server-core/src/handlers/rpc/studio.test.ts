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
  it('returns a transport-safe recovery code when image generation has no TokenNest group', async () => {
    spyOn(config, 'getLlmConnection').mockReturnValue({
      slug: 'tokennest', name: 'TokenNest', providerType: 'pi_compat', authType: 'oauth',
      oauthProvider: 'tokennest', channelGroups: [{ id: 'chat', models: ['gpt-text'] }], createdAt: 1,
    } as never)
    try {
      await harness()(RPC_CHANNELS.studio.GENERATE_IMAGE, { connectionSlug: 'tokennest', model: 'gpt-image-1', prompt: 'A cat' })
      throw new Error('Expected missing image group')
    } catch (error) {
      expect((error as Error & { code: string }).code).toBe('STUDIO_TOKENNEST_CHANNEL_UNAVAILABLE')
    }
  })
  it('asks GPT about one canvas session and validates the suggested adjustment', async () => {
    connection()
    let body: any
    globalThis.fetch = mock(async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ choices: [{ message: { content: JSON.stringify({ reply: '可以增强对比度', operation: 'adjust', adjustments: { contrast: 999, blur: -2, style: 'noir' } }) } }] })
    }) as unknown as typeof fetch
    const result = await harness()(RPC_CHANNELS.studio.ASSIST_CANVAS, {
      connectionSlug: 'gptimage', model: 'gpt-4.1', sessionId: 'canvas-123', sessionTitle: '海边日落',
      question: '如何更有电影感？', imageBase64: 'iVBORw0KGgo=', selection: { x: 10, y: 20, width: 100, height: 80 },
    })
    expect(result).toEqual({ reply: '可以增强对比度', operation: 'adjust', adjustments: { contrast: 200, blur: 0, style: 'noir' } })
    expect(body.messages[1].content[0].text).toContain('canvas-123')
    expect(body.messages[1].content[1].image_url.url.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('treats a plain GPT answer as advice without an automatic canvas edit', async () => {
    connection()
    globalThis.fetch = mock(async () => Response.json({ choices: [{ message: { content: '可以让主体更突出。' } }] })) as unknown as typeof fetch
    expect(await harness()(RPC_CHANNELS.studio.ASSIST_CANVAS, {
      connectionSlug: 'gptimage', model: 'gpt-4.1', sessionId: 'canvas-123', sessionTitle: '海边日落', question: '点评画面',
    })).toEqual({ reply: '可以让主体更突出。', operation: 'none' })
  })

  it('includes both sides of the canvas conversation in a follow-up request', async () => {
    connection()
    let body: { messages: Array<{ role: string; content: unknown }> } | undefined
    globalThis.fetch = mock(async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ choices: [{ message: { content: '{"reply":"可以调低亮度","operation":"none"}' } }] })
    }) as unknown as typeof fetch
    await harness()(RPC_CHANNELS.studio.ASSIST_CANVAS, {
      connectionSlug: 'gptimage', model: 'gpt-4.1', sessionId: 'canvas-123', sessionTitle: 'Portrait',
      question: '那现在应该怎么改？',
      history: [{ role: 'user', text: '想要电影感' }, { role: 'assistant', text: '可以降低亮度并增加对比度' }],
    })
    expect(body?.messages.slice(1, 3)).toEqual([
      { role: 'user', content: '想要电影感' },
      { role: 'assistant', content: '可以降低亮度并增加对比度' },
    ])
    expect((body?.messages.at(-1)?.content as Array<{ text: string }>)[0].text).toContain('那现在应该怎么改？')
  })

  it('passes the selected canvas thinking level to the text model', async () => {
    connection()
    let body: { reasoning_effort?: string } | undefined
    globalThis.fetch = mock(async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ choices: [{ message: { content: '{"reply":"可以提高对比度","operation":"none"}' } }] })
    }) as unknown as typeof fetch
    await harness()(RPC_CHANNELS.studio.ASSIST_CANVAS, {
      connectionSlug: 'gptimage', model: 'gpt-6-sol', sessionId: 'canvas-123', sessionTitle: 'Portrait',
      question: '如何调整？', thinkingLevel: 'high',
    })
    expect(body?.reasoning_effort).toBe('high')
    expect(body).toHaveProperty('stream', true)
  })

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

  it('includes both sides of the mind map conversation in follow-up requests', async () => {
    connection()
    const xml = '<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>'
    const revisedXml = xml.replace('</root>', '<mxCell id="risk" value="Risk" vertex="1" parent="1"/></root>')
    let body: { messages: Array<{ role: string; content: string }> } | undefined
    globalThis.fetch = mock(async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ choices: [{ message: { content: JSON.stringify({ xml: revisedXml, summary: '已添加节点' }) } }] })
    }) as unknown as typeof fetch
    await harness()(RPC_CHANNELS.studio.GENERATE_MIND_MAP, {
      connectionSlug: 'gptimage', model: 'gpt-4.1', prompt: '再添加风险节点', currentXml: xml,
      history: [{ role: 'user', text: '创建项目计划' }, { role: 'assistant', text: '已创建目标和里程碑' }],
    })
    expect(body?.messages.slice(1, 3)).toEqual([
      { role: 'user', content: '创建项目计划' },
      { role: 'assistant', content: '已创建目标和里程碑' },
    ])
    expect(JSON.parse(body!.messages[3].content).instruction).toBe('再添加风险节点')
  })

  it('maps the mind map thinking setting and leaves automatic effort to the model', async () => {
    connection()
    const xml = '<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="topic" value="Plan" vertex="1" parent="1"/></root></mxGraphModel></diagram></mxfile>'
    const bodies: Array<{ reasoning_effort?: string }> = []
    globalThis.fetch = mock(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ choices: [{ message: { content: JSON.stringify({ xml, summary: '已更新' }) } }] })
    }) as unknown as typeof fetch
    const invoke = harness()
    await invoke(RPC_CHANNELS.studio.GENERATE_MIND_MAP, { connectionSlug: 'gptimage', model: 'gpt-6-sol', prompt: '添加节点', thinkingLevel: 'off' })
    await invoke(RPC_CHANNELS.studio.GENERATE_MIND_MAP, { connectionSlug: 'gptimage', model: 'gpt-6-sol', prompt: '添加节点', thinkingLevel: 'auto' })
    expect(bodies[0]?.reasoning_effort).toBe('none')
    expect(bodies[1]).not.toHaveProperty('reasoning_effort')
  })

  it('routes a mind map model through its TokenNest text group', async () => {
    spyOn(config, 'getLlmConnection').mockReturnValue({
      slug: 'tokennest', name: 'TokenNest', providerType: 'pi_compat', authType: 'oauth',
      oauthProvider: 'tokennest', channelGroup: 'astra', createdAt: 1,
      channelGroups: [
        { id: 'astra', name: 'Astra', models: ['gpt-6-astra'] },
        { id: 'text', name: '文本', models: ['gpt-6-sol'] },
      ],
    } as never)
    spyOn(credentials, 'getCredentialManager').mockReturnValue({} as never)
    spyOn(auth, 'getValidTokenNestCredentials').mockResolvedValue({ accessToken: 'oauth-access' } as never)
    const xml = '<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="topic" value="Plan" vertex="1" parent="1"/></root></mxGraphModel></diagram></mxfile>'
    let request: RequestInit | undefined
    globalThis.fetch = mock(async (_url, init) => {
      request = init
      const reply = JSON.stringify({ xml, summary: '已生成导图' })
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(0, 40) } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(40) } }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''), { headers: { 'Content-Type': 'text/event-stream' } })
    }) as unknown as typeof fetch

    expect(await harness()(RPC_CHANNELS.studio.GENERATE_MIND_MAP, {
      connectionSlug: 'tokennest', model: 'gpt-6-sol', channelGroup: 'text', prompt: 'Make a plan',
    })).toEqual({ xml, summary: '已生成导图' })
    expect(new Headers(request?.headers).get('X-TokenNest-Group')).toBe('text')
    expect(JSON.parse(String(request?.body)).stream).toBe(true)
    await expect(harness()(RPC_CHANNELS.studio.GENERATE_MIND_MAP, {
      connectionSlug: 'tokennest', model: 'gpt-6-sol', channelGroup: 'astra', prompt: 'Make a plan',
    })).rejects.toThrow('STUDIO_TOKENNEST_CHANNEL_UNAVAILABLE')
  })

  it('expands compressed draw.io input before asking the model to edit it', async () => {
    connection()
    const graph = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="topic" value="Plan" vertex="1" parent="1"/></root></mxGraphModel>'
    const compressed = deflateRawSync(Buffer.from(encodeURIComponent(graph))).toString('base64')
    let body: { messages: { content: string }[] } | undefined
    globalThis.fetch = mock(async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ choices: [{ message: { content: `<mxfile><diagram>${graph.replace('value="Plan"', 'value="Updated"')}</diagram></mxfile>` } }] })
    }) as unknown as typeof fetch
    await harness()(RPC_CHANNELS.studio.GENERATE_MIND_MAP, { connectionSlug: 'gptimage', model: 'gpt-4.1', prompt: 'Change color', currentXml: `<mxfile><diagram>${compressed}</diagram></mxfile>` })
    expect(JSON.parse(body!.messages[1].content).currentXml).toContain('id="topic"')
  })

  it('does not preserve an empty editor scaffold as diagram content', async () => {
    connection()
    let body: { messages: { content: string }[] } | undefined
    const xml = '<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>'
    const generatedXml = xml.replace('</root>', '<mxCell id="topic" value="Plan" vertex="1" parent="1"/></root>')
    globalThis.fetch = mock(async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ choices: [{ message: { content: generatedXml } }] })
    }) as unknown as typeof fetch
    await harness()(RPC_CHANNELS.studio.GENERATE_MIND_MAP, { connectionSlug: 'gptimage', model: 'gpt-4.1', prompt: 'New plan', currentXml: xml })
    expect(JSON.parse(body!.messages[1].content).currentXml).toBeNull()
  })

  it('does not report an empty or unchanged mind map as applied', async () => {
    connection()
    const empty = '<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>'
    globalThis.fetch = mock(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ xml: empty, summary: '无法读取项目' }) } }] })) as unknown as typeof fetch
    await expect(harness()(RPC_CHANNELS.studio.GENERATE_MIND_MAP, {
      connectionSlug: 'gptimage', model: 'gpt-6-sol', prompt: '生成 ER 图', currentXml: empty,
    })).rejects.toThrow('did not create any editable mind map nodes')

    const existing = empty.replace('</root>', '<mxCell id="topic" value="Plan" vertex="1" parent="1"/></root>')
    globalThis.fetch = mock(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ xml: existing, summary: '已修改' }) } }] })) as unknown as typeof fetch
    await expect(harness()(RPC_CHANNELS.studio.GENERATE_MIND_MAP, {
      connectionSlug: 'gptimage', model: 'gpt-6-sol', prompt: '修改导图', currentXml: existing,
    })).rejects.toThrow('without changes')
  })

  it('answers mind map questions without returning an applied edit', async () => {
    connection()
    globalThis.fetch = mock(async () => Response.json({ choices: [{ message: { content: '当前导图包含项目计划节点。' } }] })) as unknown as typeof fetch
    expect(await harness()(RPC_CHANNELS.studio.GENERATE_MIND_MAP, {
      connectionSlug: 'gptimage', model: 'gpt-6-sol', prompt: '这个导图是什么？', mode: 'ask',
    })).toEqual({ mode: 'ask', summary: '当前导图包含项目计划节点。' })
  })

  it('rejects an invalid mind map response', async () => {
    connection()
    globalThis.fetch = mock(async () => Response.json({ choices: [{ message: { content: '{"title":"Plan","children":[{"title":"A"}]}' } }] })) as unknown as typeof fetch
    await expect(harness()(RPC_CHANNELS.studio.GENERATE_MIND_MAP, { connectionSlug: 'gptimage', model: 'gpt-4.1', prompt: 'Make a plan' }))
      .rejects.toThrow('AI did not return draw.io XML')
  })
})
