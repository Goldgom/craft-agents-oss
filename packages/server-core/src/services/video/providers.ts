import type { VideoProvider } from '@tokenbird/shared/video'

export interface VideoReference { name: string; url: string }
export interface VideoGenerationInput {
  prompt: string
  model: string
  durationSeconds: number
  aspectRatio: '16:9' | '9:16' | '1:1'
  references: VideoReference[]
}
export interface ProviderTask { id: string; status: 'pending' | 'completed' | 'failed'; url?: string; error?: string; progress?: number }

/** All provider routes use a saved origin; task IDs can never change the request origin. */
export function videoEndpoint(base: string, path: string): string {
  const url = new URL(base)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('视频 API 地址必须是无凭据的 HTTPS 地址')
  return `${url.toString().replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 300) throw new Error('视频服务没有返回任务 ID')
  return value
}
function headers(provider: VideoProvider, key: string, json = true): Record<string, string> {
  return { Authorization: `Bearer ${key}`, ...(json ? { 'Content-Type': 'application/json' } : {}), ...(provider.kind === 'runway' ? { 'X-Runway-Version': '2024-11-06' } : {}) }
}
async function request(provider: VideoProvider, key: string, path: string, signal: AbortSignal, init?: RequestInit): Promise<Record<string, any>> {
  let response: Response
  try {
    response = await fetch(videoEndpoint(provider.baseUrl, path), { ...init, headers: { ...headers(provider, key, !(init?.body instanceof FormData)), ...init?.headers }, signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), redirect: 'error' })
  } catch (error) {
    if (init?.method === 'POST') throw Object.assign(new Error('视频任务提交连接中断，无法确认服务端是否已创建任务'), { submissionUnknown: true })
    throw error
  }
  const text = await response.text()
  let body: Record<string, any> = {}
  try { body = text ? JSON.parse(text) : {} } catch { /* Never surface non-JSON server bodies, which may contain proxy secrets. */ }
  if (!response.ok) {
    const message = String(body.error?.message ?? body.failure ?? body.message ?? `HTTP ${response.status}`).replaceAll(key, '[redacted]').slice(0, 500)
    throw Object.assign(new Error(`视频服务请求失败 (${response.status}): ${message}`), { submissionUnknown: init?.method === 'POST' && response.status >= 500 })
  }
  return body
}
function validateInput(provider: VideoProvider, input: VideoGenerationInput): void {
  if (!input.model.trim() || !input.prompt.trim()) throw new Error('请填写视频模型和提示词')
  if (input.references.length > 1 && provider.kind !== 'seedance') {
    throw new Error(`${provider.name} 当前适配器仅支持一张参考图。请只选择一个图片记忆，或使用支持多参考图的 Seedance 模型。文字记忆仍可同时使用。`)
  }
  if (provider.kind === 'runway' && /gen4_turbo/.test(input.model) && !input.references.length) throw new Error('Runway gen4_turbo 需要参考图片；纯文字生成请选择支持 text-to-video 的模型，例如 gen4.5')
  if (provider.kind === 'runway' && (!Number.isInteger(input.durationSeconds) || input.durationSeconds < 2 || input.durationSeconds > 10)) throw new Error('Runway 分镜时长必须是 2 到 10 的整数秒，请先调整分镜')
  if (provider.kind === 'runway' && input.prompt.length > 1000) throw new Error('Runway 分镜提示词与记忆合并后不能超过 1000 个字符，请精简描述或减少所选记忆')
  if (provider.kind === 'luma' && input.references.some(ref => !ref.url.startsWith('https://'))) throw new Error('Luma 需要可公开访问的 HTTPS 参考图片地址。请在记忆中填写图片 URL，或切换支持本地图片的服务。')
  if (provider.kind === 'seedance' && input.references.length > 1 && !/seedance-2|seedance.*reference/i.test(input.model)) throw new Error('多个图片记忆需要支持 reference_image 的 Seedance 2 模型；当前模型请只选择一张参考图')
  if (provider.kind === 'seedance' && /seedance-2/.test(input.model) && (!Number.isInteger(input.durationSeconds) || input.durationSeconds < 4 || input.durationSeconds > 15)) throw new Error('Seedance 2 分镜时长必须是 4 到 15 的整数秒，请先调整分镜')
  if (provider.kind === 'openai-compatible' && new URL(provider.baseUrl).hostname === 'api.openai.com') throw new Error('OpenAI Sora 视频 API 已于 2026-09-24 关闭。此适配器仅用于仍提供兼容 Videos 接口的第三方服务，请填写对应服务地址。')
}

export async function createVideoTask(provider: VideoProvider, key: string, input: VideoGenerationInput, signal: AbortSignal): Promise<ProviderTask> {
  validateInput(provider, input)
  let path: string
  let body: string | FormData
  if (provider.kind === 'runway') {
    path = input.references.length ? 'image_to_video' : 'text_to_video'
    const ratio = { '16:9': '1280:720', '9:16': '720:1280', '1:1': '960:960' }[input.aspectRatio]
    body = JSON.stringify({ model: input.model, promptText: input.prompt, ratio, duration: input.durationSeconds, ...(input.references[0] ? { promptImage: input.references[0].url } : {}) })
  } else if (provider.kind === 'luma') {
    path = 'generations/video'
    if (![5, 9].includes(input.durationSeconds)) throw new Error('Luma Ray 视频时长应为 5 或 9 秒，请调整分镜时长')
    body = JSON.stringify({ generation_type: 'video', model: input.model, prompt: input.prompt, duration: `${input.durationSeconds}s`, aspect_ratio: input.aspectRatio, ...(input.references[0] ? { keyframes: { frame0: { type: 'image', url: input.references[0].url } } } : {}) })
  } else if (provider.kind === 'seedance') {
    path = 'contents/generations/tasks'
    body = JSON.stringify({ model: input.model, content: [{ type: 'text', text: input.prompt }, ...input.references.map(ref => ({ type: 'image_url', image_url: { url: ref.url }, role: /seedance-2|seedance.*reference/i.test(input.model) ? 'reference_image' : 'first_frame' }))], ratio: input.aspectRatio, duration: Math.round(input.durationSeconds) })
  } else {
    path = 'videos'
    const sizes = { '16:9': '1280x720', '9:16': '720x1280', '1:1': '1024x1024' }
    const form = new FormData()
    form.set('model', input.model); form.set('prompt', input.prompt); form.set('seconds', String(input.durationSeconds)); form.set('size', sizes[input.aspectRatio])
    if (input.references[0]) {
      const value = input.references[0].url
      const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(value)
      if (match) form.set('input_reference', new Blob([Buffer.from(match[2]!, 'base64')], { type: match[1] }), 'reference.png')
      else form.set('input_reference', value)
    }
    body = form
  }
  const payload = await request(provider, key, path, signal, { method: 'POST', body })
  try { return redactTask(normalizeTask(provider, { ...payload, id: id(payload.id) }), key) }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { submissionUnknown: true }) }
}

function normalizeTask(provider: VideoProvider, body: Record<string, any>): ProviderTask {
  const state = String(body.status ?? body.state ?? '').toLowerCase()
  const completed = ['succeeded', 'completed', 'success'].includes(state)
  const failed = ['failed', 'cancelled', 'canceled', 'expired', 'error'].includes(state)
  const url = provider.kind === 'runway' ? body.output?.[0] : provider.kind === 'luma' ? body.assets?.video : provider.kind === 'seedance' ? body.content?.video_url : body.url ?? body.video_url ?? body.data?.[0]?.url
  return { id: id(body.id), status: failed ? 'failed' : completed ? 'completed' : 'pending', ...(typeof url === 'string' ? { url } : {}), ...(failed ? { error: String(body.error?.message ?? body.failure_reason ?? body.failure ?? '视频生成失败').slice(0, 500) } : {}), ...(typeof body.progress === 'number' ? { progress: body.progress } : {}) }
}
function redactTask(task: ProviderTask, key: string): ProviderTask { return task.error ? { ...task, error: task.error.replaceAll(key, '[redacted]') } : task }
export async function pollVideoTask(provider: VideoProvider, key: string, taskId: string, signal: AbortSignal): Promise<ProviderTask> {
  const part = encodeURIComponent(taskId)
  const path = provider.kind === 'runway' ? `tasks/${part}` : provider.kind === 'luma' ? `generations/${part}` : provider.kind === 'seedance' ? `contents/generations/tasks/${part}` : `videos/${part}`
  return redactTask(normalizeTask(provider, await request(provider, key, path, signal)), key)
}
export async function cancelVideoTask(provider: VideoProvider, key: string, taskId: string): Promise<void> {
  if (provider.kind === 'openai-compatible') return
  const part = encodeURIComponent(taskId)
  const path = provider.kind === 'runway' ? `tasks/${part}` : provider.kind === 'luma' ? `generations/${part}` : `contents/generations/tasks/${part}`
  await request(provider, key, path, AbortSignal.timeout(10_000), { method: 'DELETE' })
}
export async function fetchVideoOutput(provider: VideoProvider, key: string, task: ProviderTask, signal: AbortSignal): Promise<Response> {
  if (!task.url && provider.kind === 'openai-compatible') {
    return fetch(videoEndpoint(provider.baseUrl, `videos/${encodeURIComponent(task.id)}/content`), { headers: headers(provider, key, false), signal, redirect: 'error' })
  }
  if (!task.url) throw new Error('视频任务已完成，但服务没有返回视频下载地址')
  const url = new URL(task.url)
  if (url.protocol !== 'https:' || url.username || url.password || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[?::1\]?$)/i.test(url.hostname)) throw new Error('视频服务返回了无效的下载地址')
  // Output CDNs receive no provider Authorization header.
  return fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]), redirect: 'error' })
}
