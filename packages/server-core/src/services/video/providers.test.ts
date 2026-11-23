import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { VideoProvider } from '@tokenbird/shared/video'
import { createVideoTask, pollVideoTask, fetchVideoOutput, type VideoGenerationInput } from './providers'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
function provider(kind: VideoProvider['kind'] = 'runway'): VideoProvider { return { id: 'provider1', kind, name: kind, baseUrl: 'https://provider.example/v1', model: 'gen4.5', hasApiKey: true, createdAt: 1, updatedAt: 1 } }
function input(patch: Partial<VideoGenerationInput> = {}): VideoGenerationInput { return { model: 'gen4.5', prompt: 'Film a quiet sunrise', durationSeconds: 5, aspectRatio: '16:9', references: [], ...patch } }
const signal = () => new AbortController().signal
describe('Video provider protocol adapters', () => {
  it('uses Runway text and image endpoints with versioned requests', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = mock(async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ id: 'task1' }) }) as unknown as typeof fetch
    await createVideoTask(provider(), 'secret', input(), signal())
    await createVideoTask(provider(), 'secret', input({ references: [{ name: 'Alice', url: 'data:image/png;base64,aGVsbG8=' }] }), signal())
    expect(calls.map(call => call.url)).toEqual(['https://provider.example/v1/text_to_video', 'https://provider.example/v1/image_to_video'])
    expect(new Headers(calls[0]!.init?.headers).get('X-Runway-Version')).toBe('2024-11-06')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ model: 'gen4.5', promptText: 'Film a quiet sunrise', ratio: '1280:720', duration: 5 })
    expect(JSON.parse(String(calls[1]!.init?.body)).promptImage).toContain('data:image/png')
  })
  it('rejects missing or unsupported references before making a paid request', async () => {
    const fetcher = mock(async () => Response.json({ id: 'unexpected' }))
    globalThis.fetch = fetcher as unknown as typeof fetch
    await expect(createVideoTask(provider(), 'secret', input({ model: 'gen4_turbo' }), signal())).rejects.toThrow('需要参考图片')
    await expect(createVideoTask(provider(), 'secret', input({ references: [{ name: 'Alice', url: 'https://img.example/a.png' }, { name: 'Park', url: 'https://img.example/b.png' }] }), signal())).rejects.toThrow('仅支持一张参考图')
    await expect(createVideoTask(provider('luma'), 'secret', input({ references: [{ name: 'Alice', url: 'data:image/png;base64,aGVsbG8=' }] }), signal())).rejects.toThrow('HTTPS')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('uses current Luma create route with public keyframe and 5s duration', async () => {
    let call: { url: string; init?: RequestInit } | undefined
    globalThis.fetch = mock(async (url, init) => { call = { url: String(url), init }; return Response.json({ id: 'luma1', state: 'dreaming' }) }) as unknown as typeof fetch
    await createVideoTask(provider('luma'), 'secret', input({ model: 'ray-2', references: [{ name: 'Scene', url: 'https://img.example/a.png' }] }), signal())
    expect(call?.url).toBe('https://provider.example/v1/generations/video')
    expect(JSON.parse(String(call?.init?.body))).toMatchObject({ model: 'ray-2', generation_type: 'video', duration: '5s', keyframes: { frame0: { type: 'image', url: 'https://img.example/a.png' } } })
  })
  it('transmits every selected image memory to a Seedance reference model', async () => {
    let body: Record<string, any> = {}
    globalThis.fetch = mock(async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({ id: 'seedance1' }) }) as unknown as typeof fetch
    await createVideoTask(provider('seedance'), 'secret', input({ model: 'doubao-seedance-2-0-260128', references: [{ name: 'Alice', url: 'https://img.example/a.png' }, { name: 'Park', url: 'https://img.example/b.png' }] }), signal())
    expect(body.content.filter((item: any) => item.role === 'reference_image')).toHaveLength(2)
    expect(body.content[2].image_url.url).toBe('https://img.example/b.png')
  })
  it('queries the task then downloads public video output without provider credentials', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = mock(async (url, init) => {
      calls.push({ url: String(url), init })
      return calls.length === 1 ? Response.json({ id: 'task/one', status: 'SUCCEEDED', output: ['https://cdn.example/movie.mp4'] }) : new Response('movie')
    }) as unknown as typeof fetch
    const task = await pollVideoTask(provider(), 'secret', 'task/one', signal())
    expect(task.status).toBe('completed')
    await fetchVideoOutput(provider(), 'secret', task, signal())
    expect(calls[0]!.url).toEndWith('/tasks/task%2Fone')
    expect(new Headers(calls[0]!.init?.headers).get('Authorization')).toBe('Bearer secret')
    expect(new Headers(calls[1]!.init?.headers).get('Authorization')).toBeNull()
  })
  it('redacts the saved API key from provider errors', async () => {
    globalThis.fetch = mock(async () => Response.json({ error: { message: 'Rejected key key-123' } }, { status: 403 })) as unknown as typeof fetch
    await expect(createVideoTask(provider(), 'key-123', input(), signal())).rejects.toThrow('Rejected key [redacted]')
  })
  it('does not advertise the retired native Sora service as an active integration', async () => {
    const item = { ...provider('openai-compatible'), baseUrl: 'https://api.openai.com/v1' }
    await expect(createVideoTask(item, 'secret', input({ model: 'sora-2' }), signal())).rejects.toThrow('2026-09-24')
  })
})
