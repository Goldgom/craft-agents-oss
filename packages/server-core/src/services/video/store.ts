import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { VideoStudioState } from '@tokenbird/shared/video'

export const VIDEO_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/
export function videoId(value: unknown, label = 'ID'): string {
  if (typeof value !== 'string' || !VIDEO_ID.test(value)) throw new Error(`无效的${label}`)
  return value
}
export function text(value: unknown, label: string, max = 4000, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw new Error(`${label}不能为空且不能超过 ${max} 个字符`)
  return value.trim()
}
export function ids(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100) throw new Error('无效的记忆或素材列表')
  return [...new Set(value.map(item => videoId(item)))]
}
export async function noSymlink(path: string): Promise<void> {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('视频存储路径不能使用符号链接') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
export class VideoStore {
  readonly root: string
  readonly assetRoot: string
  state: VideoStudioState
  private chain = Promise.resolve()
  private constructor(root: string, state: VideoStudioState) { this.root = root; this.assetRoot = join(root, 'assets'); this.state = state }
  static async open(workspaceRoot: string): Promise<VideoStore> {
    const workspace = await realpath(workspaceRoot)
    const root = join(workspace, 'video')
    await noSymlink(root); await mkdir(root, { recursive: true })
    await noSymlink(join(root, 'assets')); await mkdir(join(root, 'assets'), { recursive: true })
    const path = join(root, 'studio.json')
    await noSymlink(path)
    let state: VideoStudioState = { version: 1, providers: [], memories: [], projects: [], assets: [], jobs: [] }
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as VideoStudioState
      if (raw.version !== 1 || ['providers', 'memories', 'projects', 'assets', 'jobs'].some(key => !Array.isArray(raw[key as keyof VideoStudioState]))) throw new Error('视频工作台存档格式无效')
      state = raw
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const store = new VideoStore(root, state)
    let changed = false
    for (const job of state.jobs) {
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'interrupted'; job.message = '应用已重启。再次执行可从已保存的视频任务和分镜继续。'; job.updatedAt = Date.now(); changed = true
      }
    }
    if (changed) await store.update(() => {})
    return store
  }
  async update<T>(fn: (state: VideoStudioState) => T | Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      await noSymlink(this.root); await noSymlink(this.assetRoot); await noSymlink(join(this.root, 'studio.json'))
      const next = structuredClone(this.state)
      const result = await fn(next)
      const temp = join(this.root, `${randomUUID()}.tmp`)
      await writeFile(temp, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx' })
      await rename(temp, join(this.root, 'studio.json'))
      this.state = next
      return result
    })
    this.chain = run.then(() => {}, () => {})
    return run
  }
  async assetPath(assetId: string): Promise<string> {
    videoId(assetId, '素材 ID')
    const asset = this.state.assets.find(item => item.id === assetId)
    if (!asset) throw new Error('找不到视频素材')
    await noSymlink(this.root); await noSymlink(this.assetRoot); await noSymlink(asset.path)
    const resolved = await realpath(asset.path)
    const sub = relative(this.assetRoot, resolved)
    if (!sub || sub.startsWith('..') || isAbsolute(sub)) throw new Error('视频素材不属于当前工作区')
    return resolved
  }
  async newAssetPath(extension: string): Promise<{ id: string; path: string }> {
    await noSymlink(this.root); await noSymlink(this.assetRoot)
    const id = randomUUID()
    if (!/^\.[a-z0-9]{1,8}$/i.test(extension)) throw new Error('无效的素材格式')
    return { id, path: join(this.assetRoot, `${id}${extension}`) }
  }
}
