import { readFile, writeFile, stat, open, unlink } from 'node:fs/promises'
import { extname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { getWorkspaceByNameOrId } from '@tokenbird/shared/config'
import { getCredentialManager } from '@tokenbird/shared/credentials'
import type { CredentialId, StoredCredential } from '@tokenbird/shared/credentials'
import { VIDEO_PROVIDER_PRESETS, type VideoAction, type VideoAnalyzer, type VideoAsset, type VideoJob, type VideoMemory, type VideoProject, type VideoProvider, type VideoProviderKind, type VideoShot } from '@tokenbird/shared/video'
import { VideoStore, ids, text, videoId } from './store'
import * as providerApi from './providers'
import * as ffmpeg from './ffmpeg'

type Args = Record<string, unknown>
interface VideoCredentialStore {
  get(id: CredentialId): Promise<StoredCredential | null>
  set(id: CredentialId, value: StoredCredential): Promise<void>
  delete(id: CredentialId): Promise<boolean>
}
interface VideoServiceOptions {
  analyzer?: VideoAnalyzer
  resolveWorkspace?: (id: string) => { id: string; rootPath: string } | null
  credentials?: VideoCredentialStore
  media?: typeof ffmpeg
  providerApi?: typeof providerApi
  pollIntervalMs?: number
}
/** Host-only execution constraints. Model arguments never grant permission to create an Agent. */
export interface VideoExecutionContext { allowAgentAnalysis?: boolean }
const MIME_EXTENSIONS: Record<string, string> = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'text/plain': '.srt', 'application/x-subrip': '.srt', 'text/vtt': '.vtt', 'text/x-ssa': '.ass' }
const MAX_UPLOAD = 64 * 1024 * 1024
const MAX_DOWNLOAD = 512 * 1024 * 1024
const ACTIVE = new Set(['running', 'queued'])
function finite(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`数值必须在 ${min} 到 ${max} 之间`)
  return value
}
function optionalText(value: unknown, label: string, max = 4000): string { return value === undefined ? '' : text(value, label, max, true) }
function keyId(workspaceId: string, providerId: string): CredentialId { return { type: 'source_apikey', workspaceId, sourceId: `video-provider-${providerId}` } }
function clone<T>(value: T): T { return structuredClone(value) }
function selectedMemories(project: VideoProject, shot: VideoShot, memories: VideoMemory[]): VideoMemory[] {
  const selected = new Set([...project.memoryIds, ...shot.memoryIds])
  return memories.filter(memory => selected.size ? selected.has(memory.id) : memory.enabled)
}
/** Only visual generation inputs participate: titles and subtitle text can change without another paid call. */
export function videoGenerationInputHash(project: VideoProject, shot: VideoShot, memories: VideoMemory[], provider: VideoProvider): string {
  const input = { version: 1, provider: { id: provider.id, kind: provider.kind, baseUrl: provider.baseUrl, model: project.model || provider.model },
    prompt: shot.prompt, durationSeconds: shot.durationSeconds, aspectRatio: project.aspectRatio, preferences: project.preferences,
    memories: selectedMemories(project, shot, memories).map(memory => ({ id: memory.id, kind: memory.kind, name: memory.name, description: memory.description,
      enabled: memory.enabled, referenceUrl: memory.referenceUrl ?? '', imageAssetIds: memory.imageAssetIds })).sort((a, b) => a.id.localeCompare(b.id)),
  }
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}
function checkGenerationReuse(project: VideoProject, shot: VideoShot, memories: VideoMemory[], provider: VideoProvider, regenerate: boolean): string {
  const hash = videoGenerationInputHash(project, shot, memories, provider)
  if (regenerate) { if (!shot.prompt.trim()) throw new Error(`请先填写分镜「${shot.title}」的提示词`); return hash }
  if (!shot.providerTaskId && shot.error?.startsWith('提交结果不明')) throw new Error(`分镜「${shot.title}」提交结果不明：请先在视频供应商控制台确认，再明确重新生成，避免重复计费。`)
  if (shot.providerId || shot.providerTaskId) {
    if (!shot.generationInputHash) throw new Error(`分镜「${shot.title}」来自旧的视频任务，缺少生成参数记录。请明确重新生成该分镜后再制作成片；此操作可能产生新的服务费用。`)
    if (shot.generationInputHash !== hash) throw new Error(`分镜「${shot.title}」的提示词、偏好、记忆、画幅或服务设置已变化。请明确重新生成受影响的分镜后再制作成片；此操作可能产生新的服务费用。`)
  }
  if (!shot.assetId && !shot.prompt.trim()) throw new Error(`请先填写分镜「${shot.title}」的提示词`)
  return hash
}
function find<T extends { id: string }>(items: T[], value: unknown, label: string): T {
  const id = videoId(value, `${label} ID`); const item = items.find(item => item.id === id)
  if (!item) throw new Error(`找不到${label}`)
  return item
}
function checkUrl(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  const url = new URL(text(value, '参考图片 URL', 4000))
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('参考图片应使用无凭据的 HTTPS 地址')
  return url.toString()
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('已取消')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

export class VideoService {
  private stores = new Map<string, Promise<VideoStore>>()
  private active = new Map<string, { controller: AbortController; workspaceId: string; provider?: VideoProvider; taskId?: string }>()
  private running = new Map<string, Promise<void>>()
  private options: VideoServiceOptions
  constructor(options: VideoServiceOptions = {}) { this.options = options }
  setAnalyzer(analyzer: VideoAnalyzer): void { this.options.analyzer = analyzer }
  private get media() { return this.options.media ?? ffmpeg }
  private get providers() { return this.options.providerApi ?? providerApi }
  private get credentials() { return this.options.credentials ?? getCredentialManager() }
  private isJobRunning(job: VideoJob): boolean { return ACTIVE.has(job.status) || this.running.has(job.id) }
  private projectHasRunningJob(state: VideoStore['state'], projectId: string, exceptJobId?: string): boolean {
    return state.jobs.some(job => job.projectId === projectId && job.id !== exceptJobId && this.isJobRunning(job))
  }
  private async store(workspaceId: string): Promise<VideoStore> {
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new Error('请先选择工作区')
    const workspace = (this.options.resolveWorkspace ?? getWorkspaceByNameOrId)(workspaceId)
    if (!workspace) throw new Error('找不到工作区')
    let store = this.stores.get(workspace.id)
    if (!store) {
      store = VideoStore.open(workspace.rootPath)
      this.stores.set(workspace.id, store)
      store.catch(() => { this.stores.delete(workspace.id) })
    }
    return store
  }
  async execute(workspaceId: string, action: VideoAction, args: Args = {}, hostContext: VideoExecutionContext = {}): Promise<unknown> {
    const execution = Object.freeze({ allowAgentAnalysis: hostContext.allowAgentAnalysis !== false })
    const store = await this.store(workspaceId)
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('无效的视频操作参数')
    switch (action) {
      case 'state': return clone(store.state)
      case 'save_provider': return this.saveProvider(workspaceId, store, args)
      case 'delete_provider': {
        const item = find(store.state.providers, args.id, '视频服务')
        if (store.state.jobs.some(job => this.isJobRunning(job) && store.state.projects.find(project => project.id === job.projectId)?.providerId === item.id)) throw new Error('服务仍有运行或停止中的任务，请先等待任务清理完成')
        await store.update(async state => {
          if (state.jobs.some(job => this.isJobRunning(job) && state.projects.find(project => project.id === job.projectId)?.providerId === item.id)) throw new Error('服务仍有运行或停止中的任务，请先等待任务清理完成')
          await this.credentials.delete(keyId(workspaceId, item.id))
          state.providers = state.providers.filter(value => value.id !== item.id)
          for (const project of state.projects) if (project.providerId === item.id) { project.providerId = undefined; project.model = undefined; project.updatedAt = Date.now() }
        })
        return { deleted: true }
      }
      case 'save_memory': return this.saveMemory(store, args)
      case 'delete_memory': {
        const item = find(store.state.memories, args.id, '记忆')
        await store.update(state => {
          state.memories = state.memories.filter(value => value.id !== item.id)
          for (const project of state.projects) { project.memoryIds = project.memoryIds.filter(id => id !== item.id); for (const shot of project.shots) shot.memoryIds = shot.memoryIds.filter(id => id !== item.id) }
        })
        return { deleted: true }
      }
      case 'save_project': return this.saveProject(store, args)
      case 'delete_project': {
        const item = find(store.state.projects, args.id, '视频项目')
        if (this.projectHasRunningJob(store.state, item.id)) throw new Error('项目仍有运行或停止中的任务，请先等待任务清理完成')
        await store.update(state => {
          if (this.projectHasRunningJob(state, item.id)) throw new Error('项目仍有运行或停止中的任务，请先等待任务清理完成')
          state.projects = state.projects.filter(value => value.id !== item.id)
        })
        return { deleted: true }
      }
      case 'import_asset': return this.importAsset(store, args)
      case 'read_asset': case 'export_asset': {
        const item = find(store.state.assets, args.assetId, '素材')
        const path = await store.assetPath(item.id)
        const size = (await stat(path)).size
        if (action === 'export_asset' && (args.offset !== undefined || args.length !== undefined)) {
          const offset = finite(args.offset, 0, 0, size)
          const length = finite(args.length, 4 * 1024 * 1024, 1, 4 * 1024 * 1024)
          if (!Number.isInteger(offset) || !Number.isInteger(length)) throw new Error('素材分块参数必须为整数')
          const file = await open(path, 'r')
          try {
            const buffer = Buffer.alloc(Math.min(length, size - offset))
            const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
            return { name: item.name, mimeType: item.mimeType, bytesBase64: buffer.subarray(0, bytesRead).toString('base64'), offset, totalBytes: size, eof: offset + bytesRead >= size }
          } finally { await file.close() }
        }
        if (size > 64 * 1024 * 1024) throw new Error('素材超过 64 MB，请使用分块下载接口读取')
        const bytesBase64 = (await readFile(path)).toString('base64')
        return action === 'read_asset' ? { name: item.name, mimeType: item.mimeType, dataUrl: `data:${item.mimeType};base64,${bytesBase64}` } : { name: item.name, mimeType: item.mimeType, bytesBase64 }
      }
      case 'probe': return this.media.probeVideo(await store.assetPath(videoId(args.assetId)))
      case 'job': {
        const job = find(store.state.jobs, args.jobId, '任务')
        if (!ACTIVE.has(job.status)) await this.running.get(job.id)
        return clone(find(store.state.jobs, args.jobId, '任务'))
      }
      case 'cancel_job': {
        const job = find(store.state.jobs, args.jobId, '任务')
        const active = this.active.get(job.id)
        if (!active) return clone(job)
        active.controller.abort(new Error('用户已取消任务'))
        if (active.provider && active.taskId) {
          const provider = active.provider; const taskId = active.taskId
          void this.credentials.get(keyId(workspaceId, provider.id)).then(token => token ? this.providers.cancelVideoTask(provider, token.value, taskId) : undefined).catch(() => {})
        }
        return clone(await this.patchJob(store, job.id, { status: 'cancelled', message: '已取消本地处理；已生成素材与任务 ID 已保留，服务端是否停止及计费以供应商状态为准' }))
      }
      case 'analyze': case 'generate_shot': case 'generate_project': case 'render_project': {
        if (action === 'analyze' && !execution.allowAgentAnalysis) throw new Error('This execution context cannot launch an additional Agent; create the storyboard in the current model turn with save_project.')
        const project = find(store.state.projects, args.projectId, '视频项目')
        if (this.projectHasRunningJob(store.state, project.id)) throw new Error('此项目已有任务正在运行或停止中，请等待清理完成')
        if (action === 'generate_shot') find(project.shots, args.shotId, '分镜')
        return this.startJob(workspaceId, store, action, args, project.id, execution)
      }
      case 'edit': return this.startJob(workspaceId, store, 'edit', args)
      default: throw new Error('未知的视频操作')
    }
  }
  private async saveProvider(workspaceId: string, store: VideoStore, args: Args): Promise<VideoProvider> {
    const old = args.id ? find(store.state.providers, args.id, '视频服务') : undefined
    if (old && store.state.jobs.some(job => this.isJobRunning(job) && store.state.projects.find(project => project.id === job.projectId)?.providerId === old.id)) throw new Error('视频服务仍有运行中的任务或停止清理尚未完成，请稍后修改配置')
    const kind = (args.kind ?? old?.kind) as VideoProviderKind
    if (!Object.hasOwn(VIDEO_PROVIDER_PRESETS, kind)) throw new Error('不支持的视频服务类型')
    const preset = VIDEO_PROVIDER_PRESETS[kind]
    const now = Date.now()
    const item: VideoProvider = { id: old?.id ?? randomUUID(), kind, name: text(args.name ?? old?.name ?? preset.name, '服务名称', 160), baseUrl: text(args.baseUrl ?? old?.baseUrl ?? preset.baseUrl, 'API 地址', 4000).replace(/\/$/, ''), model: text(args.model ?? old?.model ?? preset.model, '视频模型', 200), hasApiKey: old?.hasApiKey ?? false, createdAt: old?.createdAt ?? now, updatedAt: now }
    this.providers.videoEndpoint(item.baseUrl, 'validate')
    if (old && (old.baseUrl !== item.baseUrl || old.kind !== item.kind) && !args.apiKey) throw new Error('修改服务地址或类型时请重新填写密钥，避免旧密钥被发送到新地址')
    const apiKey = args.apiKey !== undefined && args.apiKey !== '' ? text(args.apiKey, 'API 密钥', 16000) : undefined
    await store.update(async state => {
      if (old && state.jobs.some(job => this.isJobRunning(job) && state.projects.find(project => project.id === job.projectId)?.providerId === old.id)) throw new Error('视频服务仍有运行中的任务或停止清理尚未完成，请稍后修改配置')
      if (apiKey) { await this.credentials.set(keyId(workspaceId, item.id), { value: apiKey }); item.hasApiKey = true }
      const index = state.providers.findIndex(value => value.id === item.id); if (index < 0) state.providers.push(item); else state.providers[index] = item
    })
    return clone(item)
  }
  private async saveMemory(store: VideoStore, args: Args): Promise<VideoMemory> {
    const old = args.id ? find(store.state.memories, args.id, '记忆') : undefined
    const kind = args.kind ?? old?.kind ?? 'person'
    if (!['person', 'scene', 'style'].includes(String(kind))) throw new Error('无效的记忆类型')
    const imageAssetIds = args.imageAssetIds === undefined ? old?.imageAssetIds ?? [] : ids(args.imageAssetIds)
    for (const id of imageAssetIds) { const asset = find(store.state.assets, id, '图片'); if (!asset.mimeType.startsWith('image/')) throw new Error('记忆只能关联图片素材') }
    const now = Date.now()
    const item: VideoMemory = { id: old?.id ?? randomUUID(), kind: kind as VideoMemory['kind'], name: text(args.name ?? old?.name, '记忆名称', 160), description: text(args.description ?? old?.description, '记忆描述', 8000), imageAssetIds, ...(checkUrl(args.referenceUrl ?? old?.referenceUrl) ? { referenceUrl: checkUrl(args.referenceUrl ?? old?.referenceUrl) } : {}), enabled: args.enabled === undefined ? old?.enabled ?? true : args.enabled === true, createdAt: old?.createdAt ?? now, updatedAt: now }
    await store.update(state => { const index = state.memories.findIndex(value => value.id === item.id); if (index < 0) state.memories.push(item); else state.memories[index] = item })
    return clone(item)
  }
  private normalizeShot(store: VideoStore, raw: Args, old?: VideoShot): VideoShot {
    const memoryIds = ids(raw.memoryIds ?? old?.memoryIds)
    for (const id of memoryIds) find(store.state.memories, id, '记忆')
    const shot: VideoShot = { id: raw.id ? videoId(raw.id, '分镜 ID') : randomUUID(), title: text(raw.title ?? old?.title ?? '分镜', '分镜标题', 240), prompt: optionalText(raw.prompt ?? old?.prompt, '分镜提示词', 12000), durationSeconds: finite(raw.durationSeconds, old?.durationSeconds ?? 5, 1, 30), memoryIds, ...(optionalText(raw.narration ?? old?.narration, '旁白字幕', 8000) ? { narration: optionalText(raw.narration ?? old?.narration, '旁白字幕', 8000) } : {}), status: 'draft' }
    if (raw.assetId) { find(store.state.assets, raw.assetId, '分镜视频'); shot.assetId = videoId(raw.assetId); shot.status = 'completed' }
    if (old) {
      shot.providerTaskId = old.providerTaskId; shot.providerId = old.providerId
      shot.generationInputHash = old.generationInputHash
      shot.status = old.status ?? 'draft'
      shot.error = old.error
      if (raw.assetId === undefined && old.assetId) { shot.assetId = old.assetId; shot.status = old.status }
      else if (!shot.assetId && old.status === 'generating') shot.status = old.status
    }
    if (raw.assetId && raw.assetId !== old?.assetId) { shot.providerTaskId = undefined; shot.providerId = undefined; shot.generationInputHash = undefined; shot.status = 'completed'; shot.error = undefined }
    if (raw.assetId === '') { shot.assetId = undefined; shot.providerTaskId = undefined; shot.providerId = undefined; shot.generationInputHash = undefined; shot.status = 'draft' }
    return shot
  }
  private async saveProject(store: VideoStore, args: Args): Promise<VideoProject> {
    const old = args.id ? find(store.state.projects, args.id, '视频项目') : undefined
    if (old && this.projectHasRunningJob(store.state, old.id)) throw new Error('项目正在处理或停止清理，请稍后再编辑')
    const memoryIds = ids(args.memoryIds ?? old?.memoryIds)
    for (const id of memoryIds) find(store.state.memories, id, '记忆')
    const providerId = args.providerId === '' ? undefined : args.providerId ?? old?.providerId
    if (providerId) find(store.state.providers, providerId, '视频服务')
    const aspectRatio = args.aspectRatio ?? old?.aspectRatio ?? '16:9'
    if (!['16:9', '9:16', '1:1'].includes(String(aspectRatio))) throw new Error('不支持的视频画幅')
    if (args.shots !== undefined && (!Array.isArray(args.shots) || args.shots.length > 120)) throw new Error('分镜不能超过 120 个')
    const shots = args.shots === undefined ? old?.shots ?? [] : (args.shots as Args[]).map(raw => this.normalizeShot(store, raw, old?.shots.find(shot => shot.id === raw.id)))
    if (new Set(shots.map(shot => shot.id)).size !== shots.length) throw new Error('分镜 ID 不能重复')
    const now = Date.now()
    const item: VideoProject = { id: old?.id ?? randomUUID(), name: text(args.name ?? old?.name ?? '新视频', '项目名称', 160), script: optionalText(args.script ?? old?.script, '脚本文本', 100000), preferences: optionalText(args.preferences ?? old?.preferences, '制作偏好', 8000), ...(providerId ? { providerId: String(providerId) } : {}), ...(optionalText(args.model ?? old?.model, '视频模型', 200) ? { model: optionalText(args.model ?? old?.model, '视频模型', 200) } : {}), aspectRatio: aspectRatio as VideoProject['aspectRatio'], memoryIds, shots, createdAt: old?.createdAt ?? now, updatedAt: now }
    if (old?.outputAssetId && JSON.stringify(old.shots) === JSON.stringify(shots) && old.aspectRatio === item.aspectRatio
      && old.script === item.script && old.preferences === item.preferences && old.providerId === item.providerId
      && old.model === item.model && JSON.stringify(old.memoryIds) === JSON.stringify(item.memoryIds)) item.outputAssetId = old.outputAssetId
    await store.update(state => {
      if (this.projectHasRunningJob(state, item.id)) throw new Error('项目正在处理或停止清理，请稍后再编辑')
      const index = state.projects.findIndex(value => value.id === item.id); if (index < 0) state.projects.push(item); else state.projects[index] = item
    })
    return clone(item)
  }
  private async importAsset(store: VideoStore, args: Args): Promise<VideoAsset> {
    const name = text(args.name, '素材名称', 240)
    const mimeType = text(args.mimeType, '素材格式', 100)
    const extension = MIME_EXTENSIONS[mimeType]
    if (!extension) throw new Error('不支持此素材格式，请导入 MP4/WebM/MOV/MKV、PNG/JPEG/WebP、音频或 SRT/VTT')
    const encoded = args.bytesBase64
    const max = mimeType.startsWith('image/') ? 20 * 1024 * 1024 : MAX_UPLOAD
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(max / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('素材内容无效或超过大小限制（视频 64 MB，图片 20 MB）')
    const bytes = Buffer.from(encoded, 'base64')
    if (!bytes.length || bytes.length > max) throw new Error('素材为空或超过大小限制')
    if (mimeType.startsWith('image/')) {
      const valid = mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
      if (!valid) throw new Error('图片格式与实际内容不匹配')
    }
    const target = await store.newAssetPath(extension)
    await writeFile(target.path, bytes, { flag: 'wx' })
    const asset: VideoAsset = { id: target.id, path: target.path, name, mimeType, bytes: bytes.length, createdAt: Date.now() }
    await store.update(state => { state.assets.push(asset) })
    return clone(asset)
  }
  private async patchJob(store: VideoStore, jobId: string, patch: Partial<VideoJob>): Promise<VideoJob> {
    return store.update(state => { const job = find(state.jobs, jobId, '任务'); Object.assign(job, patch, { updatedAt: Date.now() }); return clone(job) })
  }
  private async startJob(workspaceId: string, store: VideoStore, kind: VideoJob['kind'], args: Args, projectId?: string, execution: Readonly<VideoExecutionContext> = {}): Promise<VideoJob> {
    const now = Date.now()
    const job: VideoJob = { id: randomUUID(), kind, status: 'queued', progress: 0, message: '等待处理', ...(projectId ? { projectId } : {}), ...(kind === 'generate_shot' ? { shotId: videoId(args.shotId) } : {}), createdAt: now, updatedAt: now }
    const controller = new AbortController()
    this.active.set(job.id, { controller, workspaceId })
    try {
      await store.update(state => {
        if (projectId && this.projectHasRunningJob(state, projectId, job.id)) throw new Error('此项目已有任务正在运行或停止中，请等待清理完成')
        state.jobs.push(job); if (state.jobs.length > 300) state.jobs = state.jobs.filter(value => this.isJobRunning(value) || value.id === job.id).concat(state.jobs.filter(value => !this.isJobRunning(value) && value.id !== job.id).slice(-200))
      })
    } catch (error) { this.active.delete(job.id); throw error }
    // Jobs keep running after navigation or an RPC timeout; only explicit cancellation stops them.
    const running = this.runJob(workspaceId, store, job, args, controller.signal, execution)
    this.running.set(job.id, running)
    void running.then(() => this.running.delete(job.id), () => this.running.delete(job.id))
    return clone(job)
  }
  private async runJob(workspaceId: string, store: VideoStore, job: VideoJob, args: Args, signal: AbortSignal, execution: Readonly<VideoExecutionContext>): Promise<void> {
    try {
      await this.patchJob(store, job.id, { status: 'running', message: '正在处理' })
      signal.throwIfAborted()
      if (job.kind === 'analyze') await this.analyze(workspaceId, store, job, args, signal, execution)
      else if (job.kind === 'edit') await this.edit(store, job, args, signal)
      else {
        let project = find(store.state.projects, job.projectId, '视频项目')
        if (job.kind === 'generate_project' && (args.analyzeFirst === true || !project.shots.length)) {
          await this.analyze(workspaceId, store, job, args, signal, execution)
          project = find(store.state.projects, job.projectId, '视频项目')
        }
        if (!project.shots.length) throw new Error('请先添加分镜或导入脚本进行分析')
        if (job.kind !== 'render_project') {
          const shots = job.kind === 'generate_shot' ? [find(project.shots, args.shotId, '分镜')] : project.shots
          const provider = clone(find(store.state.providers, project.providerId, '视频服务'))
          const credential = await this.credentials.get(keyId(workspaceId, provider.id))
          if (!credential?.value) throw new Error(`请为 ${provider.name} 配置 API 密钥`)
          const snapshot = { project: clone(project), memories: clone(store.state.memories), provider, token: credential.value }
          // Inspect every planned shot before submitting any paid task, including stale clips later in the order.
          for (const shot of shots) checkGenerationReuse(snapshot.project, shot, snapshot.memories, snapshot.provider, args.regenerate === true)
          for (let i = 0; i < shots.length; i++) {
            signal.throwIfAborted()
            await this.patchJob(store, job.id, { progress: Math.round(10 + i / shots.length * 75), message: `正在生成分镜 ${i + 1}/${shots.length}: ${shots[i]!.title}` })
            await this.generateShot(workspaceId, store, job, shots[i]!.id, signal, args.regenerate === true, snapshot)
          }
        }
        if (job.kind === 'generate_project' || job.kind === 'render_project') await this.render(store, job, signal)
      }
      signal.throwIfAborted()
      await this.patchJob(store, job.id, { status: 'completed', progress: 100, message: job.kind === 'analyze' ? '脚本分析与分镜已保存' : '处理完成' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.patchJob(store, job.id, { status: signal.aborted ? 'cancelled' : 'failed', message: signal.aborted ? '任务已取消，已完成的素材和服务端任务 ID 已保留' : '处理失败', error: message.slice(0, 1200) }).catch(() => {})
    } finally { this.active.delete(job.id) }
  }
  private async analyze(workspaceId: string, store: VideoStore, job: VideoJob, args: Args, signal: AbortSignal, execution: Readonly<VideoExecutionContext>): Promise<void> {
    if (execution.allowAgentAnalysis === false) throw new Error('This execution context cannot launch an additional Agent; create the storyboard in the current model turn with save_project.')
    if (!this.options.analyzer) throw new Error('当前宿主尚未启用视频脚本 Agent')
    const project = clone(find(store.state.projects, job.projectId, '视频项目'))
    if (!project.script.trim()) throw new Error('请先导入或填写脚本')
    await this.patchJob(store, job.id, { message: 'Agent 正在分析人物、场景与分镜', progress: 3 })
    const provider = store.state.providers.find(item => item.id === project.providerId)
    const selectedMemories = new Set([...project.memoryIds, ...project.shots.flatMap(shot => shot.memoryIds)])
    const result = await this.options.analyzer({ workspaceId, project, memories: clone(store.state.memories.filter(item => item.enabled || selectedMemories.has(item.id))), ...(provider ? { provider: clone(provider) } : {}), ...(typeof args.connectionSlug === 'string' ? { connectionSlug: args.connectionSlug } : {}), ...(typeof args.model === 'string' ? { model: args.model } : {}), onSession: sessionId => { void this.patchJob(store, job.id, { agentSessionId: sessionId }).catch(() => {}) } }, signal)
    signal.throwIfAborted()
    if (!Array.isArray(result.memories) || result.memories.length > 100 || !Array.isArray(result.shots) || !result.shots.length || result.shots.length > 120) throw new Error('Agent 返回了无效的记忆或分镜')
    await store.update(state => {
      const current = find(state.projects, project.id, '视频项目')
      const byName = new Map(state.memories.map(item => [item.name, item.id]))
      for (const raw of result.memories) {
        if (!['person', 'scene', 'style'].includes(raw.kind)) throw new Error('Agent 返回的记忆类型无效')
        const existing = raw.existingId ? state.memories.find(item => item.id === raw.existingId) : state.memories.find(item => item.name === raw.name && item.kind === raw.kind)
        // Existing image/identity descriptions remain authoritative; analysis only creates missing memories.
        if (existing) { byName.set(raw.name, existing.id); continue }
        const now = Date.now(); const memory: VideoMemory = { id: randomUUID(), kind: raw.kind, name: text(raw.name, '记忆名称', 160), description: text(raw.description, '记忆描述', 8000), imageAssetIds: [], enabled: true, createdAt: now, updatedAt: now }
        state.memories.push(memory); byName.set(memory.name, memory.id)
      }
      current.shots = result.shots.map(raw => {
        const memoryIds = [...new Set([...ids(raw.memoryIds).filter(id => state.memories.some(memory => memory.id === id)), ...(raw.memoryNames ?? []).map(name => byName.get(name)).filter((id): id is string => !!id)])]
        return { id: randomUUID(), title: text(raw.title, '分镜标题', 240), prompt: text(raw.prompt, '分镜提示词', 12000), durationSeconds: finite(raw.durationSeconds, 5, 1, 30), memoryIds, ...(raw.narration ? { narration: text(raw.narration, '旁白字幕', 8000) } : {}), status: 'draft' as const }
      })
      current.outputAssetId = undefined; current.updatedAt = Date.now()
    })
    if (result.agentSessionId) await this.patchJob(store, job.id, { agentSessionId: result.agentSessionId })
  }
  private async references(store: VideoStore, memories: VideoMemory[], provider: VideoProvider): Promise<providerApi.VideoReference[]> {
    const references: providerApi.VideoReference[] = []
    for (const memory of memories) {
      if (memory.referenceUrl) { references.push({ name: memory.name, url: memory.referenceUrl }); continue }
      for (const assetId of memory.imageAssetIds) {
        const asset = find(store.state.assets, assetId, '参考图片')
        const bytes = await readFile(await store.assetPath(assetId))
        if (bytes.length > 20 * 1024 * 1024) throw new Error('参考图片不能超过 20 MB')
        references.push({ name: memory.name, url: `data:${asset.mimeType};base64,${bytes.toString('base64')}` })
      }
    }
    return references
  }
  private async generateShot(workspaceId: string, store: VideoStore, job: VideoJob, shotId: string, signal: AbortSignal, regenerate: boolean, snapshot: { project: VideoProject; memories: VideoMemory[]; provider: VideoProvider; token: string }): Promise<void> {
    const project = snapshot.project
    const shot = clone(find(project.shots, shotId, '分镜'))
    const generationInputHash = checkGenerationReuse(project, shot, snapshot.memories, snapshot.provider, regenerate)
    if (shot.assetId && !regenerate) return
    if (!shot.prompt.trim()) throw new Error(`请先填写分镜「${shot.title}」的提示词`)
    const provider = snapshot.provider
    const credential = { value: snapshot.token }
    const model = project.model || provider.model
    const memories = selectedMemories(project, shot, snapshot.memories)
    const references = await this.references(store, memories, provider)
    const prompt = [shot.prompt, project.preferences ? `Production preferences: ${project.preferences}` : '', ...memories.map(memory => `Keep ${memory.kind} "${memory.name}" consistent: ${memory.description}`)].filter(Boolean).join('\n\n')
    if (prompt.length > 16000) throw new Error('合并后的分镜和记忆提示词过长，请精简记忆描述')
    let task: providerApi.ProviderTask
    try {
      if (!shot.providerTaskId && shot.error?.startsWith('提交结果不明') && !regenerate) throw new Error('提交结果不明：请先在视频供应商控制台确认是否已创建任务，再明确重新生成，避免重复计费。')
      if (shot.providerTaskId && shot.providerId === provider.id && shot.status !== 'failed' && !regenerate) task = await this.providers.pollVideoTask(provider, credential.value, shot.providerTaskId, signal)
      else {
        try { task = await this.providers.createVideoTask(provider, credential.value, { prompt, model, durationSeconds: shot.durationSeconds, aspectRatio: project.aspectRatio, references }, signal) }
        catch (error) {
          if ((error as { submissionUnknown?: boolean })?.submissionUnknown) {
            await store.update(state => { find(find(state.projects, project.id, '视频项目').shots, shotId, '分镜').error = '提交结果不明：服务未返回任务 ID，请先在供应商控制台确认，再明确重新生成，避免重复计费。' })
            throw new Error('提交结果不明：服务未返回任务 ID，请先在供应商控制台确认，再明确重新生成，避免重复计费。')
          }
          throw error
        }
      }
      const active = this.active.get(job.id)
      if (active) { active.provider = provider; active.taskId = task.id }
      await store.update(state => { const value = find(find(state.projects, project.id, '视频项目').shots, shotId, '分镜'); value.providerTaskId = task.id; value.providerId = provider.id; value.generationInputHash = generationInputHash; value.status = 'generating'; value.error = undefined })
      const deadline = Date.now() + 2 * 60 * 60 * 1000
      while (task.status === 'pending') {
        if (Date.now() > deadline) throw new Error('视频服务仍在处理。任务 ID 已保存，再次执行将继续查询同一任务，不重复提交。')
        await wait(this.options.pollIntervalMs ?? 5000, signal)
        task = await this.providers.pollVideoTask(provider, credential.value, task.id, signal)
      }
      if (task.status === 'failed') {
        await store.update(state => { const value = find(find(state.projects, project.id, '视频项目').shots, shotId, '分镜'); value.status = 'failed'; value.error = task.error ?? '生成失败' })
        throw new Error(task.error ?? '视频服务生成失败')
      }
      const response = await this.providers.fetchVideoOutput(provider, credential.value, task, signal)
      const asset = await this.downloadAsset(store, response, `${project.name}-${shot.title}.mp4`, signal)
      await store.update(state => {
        const current = find(state.projects, project.id, '视频项目'); const value = find(current.shots, shotId, '分镜')
        value.assetId = asset.id; value.status = 'completed'; value.error = undefined
        current.outputAssetId = undefined; current.updatedAt = Date.now()
      })
      if (job.kind === 'generate_shot') await this.patchJob(store, job.id, { outputAssetId: asset.id })
    } catch (error) {
      if (!signal.aborted) await store.update(state => { const value = find(find(state.projects, project.id, '视频项目').shots, shotId, '分镜'); value.error = (error instanceof Error ? error.message : String(error)).slice(0, 1200) })
      throw error
    }
  }
  private async downloadAsset(store: VideoStore, response: Response, name: string, signal: AbortSignal): Promise<VideoAsset> {
    if (!response.ok || !response.body) throw new Error(`无法下载生成视频 (${response.status})`)
    if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD) throw new Error('生成视频超过 512 MB 下载限制')
    const target = await store.newAssetPath('.mp4')
    const file = await open(target.path, 'wx')
    let bytes = 0
    try {
      const reader = response.body.getReader()
      try {
        while (true) {
          signal.throwIfAborted()
          const result = await reader.read(); if (result.done) break
          bytes += result.value.byteLength
          if (bytes > MAX_DOWNLOAD) throw new Error('生成视频超过 512 MB 下载限制')
          let written = 0
          while (written < result.value.byteLength) { const part = await file.write(result.value, written, result.value.byteLength - written); if (!part.bytesWritten) throw new Error('无法写入视频文件'); written += part.bytesWritten }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    } catch (error) { await file.close(); await unlink(target.path).catch(() => {}); throw error }
    await file.close()
    if (!bytes) { await unlink(target.path).catch(() => {}); throw new Error('视频服务返回空视频') }
    let metadata: ffmpeg.VideoMetadata
    try { metadata = await this.media.probeVideo(target.path, { signal }); if (!metadata.hasVideo) throw new Error('视频服务下载内容没有有效的视频流') }
    catch (error) { await unlink(target.path).catch(() => {}); throw error }
    const asset: VideoAsset = { id: target.id, path: target.path, name, mimeType: 'video/mp4', bytes, createdAt: Date.now(), durationSeconds: metadata.durationSeconds, width: metadata.width, height: metadata.height }
    await store.update(state => { state.assets.push(asset) })
    return asset
  }
  private async render(store: VideoStore, job: VideoJob, signal: AbortSignal): Promise<void> {
    const project = find(store.state.projects, job.projectId, '视频项目')
    const paths = []
    for (const shot of project.shots) { if (!shot.assetId) throw new Error(`分镜「${shot.title}」尚未生成或导入视频`); paths.push(await store.assetPath(shot.assetId)) }
    const target = await store.newAssetPath('.mp4')
    const size = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [960, 960] }[project.aspectRatio]!
    await this.patchJob(store, job.id, { message: 'FFmpeg 正在统一画幅并合成成片', progress: 90 })
    let captions: VideoAsset | undefined
    const intermediate = project.shots.some(shot => shot.narration?.trim()) ? await store.newAssetPath('.mp4') : undefined
    try {
      if (intermediate) {
        const captionFile = await store.newAssetPath('.srt')
        let elapsed = 0; let index = 0; const lines: string[] = []
        const timestamp = (seconds: number) => {
          const ms = Math.max(0, Math.round(seconds * 1000))
          return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
        }
        for (let i = 0; i < project.shots.length; i++) {
          const duration = (await this.media.probeVideo(paths[i]!, { signal })).durationSeconds
          if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法确定分镜时长，不能生成同步字幕')
          const narration = project.shots[i]!.narration?.replace(/<[^>]*>/g, '').replace(/\r/g, '').trim()
          if (narration) lines.push(`${++index}\n${timestamp(elapsed)} --> ${timestamp(elapsed + duration)}\n${narration}\n`)
          elapsed += duration
        }
        const content = lines.join('\n')
        await writeFile(captionFile.path, content, { flag: 'wx', encoding: 'utf8' })
        captions = { id: captionFile.id, path: captionFile.path, name: `${project.name}.srt`, mimeType: 'application/x-subrip', bytes: Buffer.byteLength(content, 'utf8'), createdAt: Date.now() }
      }
      await this.media.concatVideo(paths, intermediate?.path ?? target.path, { width: size[0], height: size[1], fps: 30, signal })
      if (intermediate && captions) {
        await this.patchJob(store, job.id, { message: '正在为成片添加脚本旁白字幕', progress: 96 })
        await this.media.processVideo({ operation: 'subtitles', inputPaths: [intermediate.path], outputPath: target.path, subtitlesPath: captions.path, format: 'mp4' }, { signal })
      }
    } catch (error) {
      await unlink(target.path).catch(() => {})
      if (captions) await unlink(captions.path).catch(() => {})
      throw error
    } finally { if (intermediate) await unlink(intermediate.path).catch(() => {}) }
    signal.throwIfAborted()
    const asset: VideoAsset = { id: target.id, path: target.path, name: `${project.name}.mp4`, mimeType: 'video/mp4', bytes: (await stat(target.path)).size, createdAt: Date.now(), width: size[0], height: size[1] }
    await store.update(state => { state.assets.push(asset); if (captions) state.assets.push(captions); const current = find(state.projects, project.id, '视频项目'); current.outputAssetId = asset.id; current.updatedAt = Date.now() })
    await this.patchJob(store, job.id, { outputAssetId: asset.id })
  }
  private async edit(store: VideoStore, job: VideoJob, args: Args, signal: AbortSignal): Promise<void> {
    const inputPaths = await Promise.all(ids(args.inputAssetIds).map(id => store.assetPath(id)))
    if (!inputPaths.length) throw new Error('请先选择视频素材')
    const format = args.format === undefined ? 'mp4' : text(args.format, '导出格式', 12)
    if (!['mp4', 'mp3', 'wav', 'm4a', 'aac', 'png', 'jpg', 'jpeg', 'webp'].includes(format)) throw new Error('不支持此导出格式；视频使用 MP4，音频使用 MP3/WAV/M4A/AAC，截图使用 PNG/JPEG/WebP')
    const target = await store.newAssetPath(`.${format}`)
    const operation = text(args.operation, '剪辑操作', 80)
    const input = { operation, inputPaths, outputPath: target.path,
      ...(args.startSeconds !== undefined ? { startSeconds: args.startSeconds } : {}), ...(args.durationSeconds !== undefined ? { durationSeconds: args.durationSeconds } : {}),
      ...(args.width !== undefined ? { width: args.width } : {}), ...(args.height !== undefined ? { height: args.height } : {}), ...(args.crop !== undefined ? { crop: args.crop } : {}),
      ...(args.rotation !== undefined ? { rotation: args.rotation } : {}), ...(args.speed !== undefined ? { speed: args.speed } : {}), ...(args.volume !== undefined ? { volume: args.volume } : {}), ...(args.mute !== undefined ? { mute: args.mute } : {}), format,
      ...(args.watermarkAssetId ? { watermarkPath: await store.assetPath(videoId(args.watermarkAssetId)) } : {}), ...(args.subtitlesAssetId ? { subtitlesPath: await store.assetPath(videoId(args.subtitlesAssetId)) } : {}), ...(args.musicAssetId ? { musicPath: await store.assetPath(videoId(args.musicAssetId)) } : {}),
    }
    await this.media.processVideo(input as Parameters<typeof ffmpeg.processVideo>[0], { signal })
    signal.throwIfAborted()
    const mimeType = format === 'jpeg' ? 'image/jpeg' : Object.entries(MIME_EXTENSIONS).find(([, extension]) => extension === `.${format}`)?.[0] ?? 'application/octet-stream'
    const asset: VideoAsset = { id: target.id, path: target.path, name: `edited-${Date.now()}.${format}`, mimeType, bytes: (await stat(target.path)).size, createdAt: Date.now() }
    await store.update(state => { state.assets.push(asset) }); await this.patchJob(store, job.id, { outputAssetId: asset.id })
  }
}
let service: VideoService | undefined
export function getVideoService(): VideoService { return service ??= new VideoService() }
export function setVideoAnalyzer(analyzer: VideoAnalyzer): void { getVideoService().setAnalyzer(analyzer) }
