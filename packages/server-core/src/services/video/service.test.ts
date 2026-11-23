import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VideoAsset, VideoJob, VideoMemory, VideoProject, VideoProvider, VideoStudioState } from '@tokenbird/shared/video'
import type { CredentialId, StoredCredential } from '@tokenbird/shared/credentials'
import { VideoService, videoGenerationInputHash } from './service'
import * as media from './ffmpeg'
import * as providers from './providers'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'tokenbird-video-test-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
function setup(options: { analyzer?: NonNullable<ConstructorParameters<typeof VideoService>[0]>['analyzer']; providerApi?: typeof providers } = {}) {
  const secrets = new Map<string, StoredCredential>()
  const serialize = (id: CredentialId) => JSON.stringify(id)
  const service = new VideoService({
    resolveWorkspace: id => id === 'workspace' ? { id, rootPath: directory } : null,
    credentials: { get: async id => secrets.get(serialize(id)) ?? null, set: async (id, value) => { secrets.set(serialize(id), value) }, delete: async id => secrets.delete(serialize(id)) },
    media: { probeVideo: async () => ({ durationSeconds: 5, width: 1280, height: 720, hasVideo: true, hasAudio: true }), processVideo: async (input: any) => { await writeFile(input.outputPath, 'edited-video'); return { outputPath: input.outputPath } }, concatVideo: async (_input: any, output: string) => { await writeFile(output, 'complete-movie'); return { outputPath: output } } } as unknown as typeof media,
    providerApi: options.providerApi ?? { ...providers, createVideoTask: async () => ({ id: 'task1', status: 'pending' }), pollVideoTask: async () => ({ id: 'task1', status: 'completed', url: 'https://cdn.example/movie.mp4' }), fetchVideoOutput: async () => new Response('generated-clip'), cancelVideoTask: async () => {} },
    analyzer: options.analyzer,
    pollIntervalMs: 1,
  })
  const execute = (action: Parameters<VideoService['execute']>[1], args: Record<string, unknown> = {}) => service.execute('workspace', action, args)
  return { service, secrets, execute }
}
async function terminal(execute: ReturnType<typeof setup>['execute'], id: string): Promise<VideoJob> {
  for (let i = 0; i < 1000; i++) {
    const job = await execute('job', { jobId: id }) as VideoJob
    if (!['queued', 'running'].includes(job.status)) return job
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('Video job did not terminate')
}
async function savedProvider(execute: ReturnType<typeof setup>['execute']) {
  return execute('save_provider', { kind: 'runway', name: 'Video service', baseUrl: 'https://video.example/v1', model: 'gen4.5', apiKey: 'secret-api-key' }) as Promise<VideoProvider>
}
describe('Video Studio durable workflow', () => {
  it('stores secrets in credentials and preserves keys on ordinary provider edits', async () => {
    const { execute, secrets } = setup()
    const provider = await savedProvider(execute)
    const edited = await execute('save_provider', { id: provider.id, name: 'Renamed', apiKey: '' }) as VideoProvider
    expect(edited.hasApiKey).toBe(true)
    expect(secrets.size).toBe(1)
    expect([...secrets.values()][0]!.value).toBe('secret-api-key')
    expect(await readFile(join(directory, 'video', 'studio.json'), 'utf8')).not.toContain('secret-api-key')
    await expect(execute('save_provider', { id: provider.id, baseUrl: 'https://other.example/v1' })).rejects.toThrow('重新填写密钥')
  })
  it('retains image identity memories across restarts and detaches a deleted provider', async () => {
    const { execute } = setup()
    const provider = await savedProvider(execute)
    const image = await execute('import_asset', { name: 'Alice.png', mimeType: 'image/png', bytesBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') }) as VideoAsset
    const memory = await execute('save_memory', { kind: 'person', name: 'Alice', description: 'Short silver hair and round glasses', imageAssetIds: [image.id] }) as VideoMemory
    const project = await execute('save_project', { name: 'Alice in the park', providerId: provider.id, model: 'gen4.5', memoryIds: [memory.id] }) as VideoProject
    const reopened = setup()
    const state = await reopened.execute('state') as VideoStudioState
    expect(state.memories[0]!.imageAssetIds).toEqual([image.id])
    expect((await reopened.execute('read_asset', { assetId: image.id }) as any).dataUrl).toStartWith('data:image/png;base64,')
    await execute('delete_provider', { id: provider.id })
    const updated = (await execute('state') as VideoStudioState).projects.find(item => item.id === project.id)!
    expect(updated.providerId).toBeUndefined()
    await expect(execute('save_project', { id: project.id, name: 'Renamed' })).resolves.toBeDefined()
  })
  it('analyzes script, reuses image memories, generates shots and assembles the full movie', async () => {
    let requests = 0
    const adapter = { ...providers, createVideoTask: async (_provider: VideoProvider, _key: string, input: providers.VideoGenerationInput) => { requests++; expect(input.prompt).toContain('round glasses'); expect(input.references).toHaveLength(1); return { id: 'task1', status: 'pending' as const } }, pollVideoTask: async () => ({ id: 'task1', status: 'completed' as const, url: 'https://cdn.example/out.mp4' }), fetchVideoOutput: async () => new Response('clip'), cancelVideoTask: async () => {} }
    const { execute } = setup({ providerApi: adapter, analyzer: async input => {
      input.onSession?.('analysis-session')
      return { memories: [{ existingId: input.memories[0]!.id, kind: 'person', name: 'Alice', description: 'This should not replace the saved identity' }, { kind: 'scene', name: 'Park', description: 'A quiet garden at dawn' }], shots: [{ title: 'Arrival', prompt: 'Alice enters the park', durationSeconds: 5, memoryIds: [input.memories[0]!.id], memoryNames: ['Park'] }], agentSessionId: 'analysis-session' }
    } })
    const provider = await savedProvider(execute)
    const image = await execute('import_asset', { name: 'Alice.png', mimeType: 'image/png', bytesBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') }) as VideoAsset
    const memory = await execute('save_memory', { kind: 'person', name: 'Alice', description: 'Short silver hair and round glasses', imageAssetIds: [image.id] }) as VideoMemory
    const project = await execute('save_project', { name: 'A short film', script: 'Alice walks into a quiet garden at dawn.', providerId: provider.id, memoryIds: [memory.id] }) as VideoProject
    const job = await execute('generate_project', { projectId: project.id, analyzeFirst: true, connectionSlug: 'my-agent' }) as VideoJob
    const result = await terminal(execute, job.id)
    expect(result.status).toBe('completed')
    expect(result.agentSessionId).toBe('analysis-session')
    expect(result.outputAssetId).toBeDefined()
    const state = await execute('state') as VideoStudioState
    expect(state.memories.find(item => item.id === memory.id)!.description).toBe('Short silver hair and round glasses')
    expect(state.projects[0]!.shots[0]!.status).toBe('completed')
    expect((await execute('export_asset', { assetId: result.outputAssetId }) as any).bytesBase64).toBe(Buffer.from('complete-movie').toString('base64'))
    const retry = await execute('generate_project', { projectId: project.id }) as VideoJob
    expect((await terminal(execute, retry.id)).status).toBe('completed')
    expect(requests).toBe(1)
    const refreshed = await execute('generate_shot', { projectId: project.id, shotId: state.projects[0]!.shots[0]!.id, regenerate: true }) as VideoJob
    expect((await terminal(execute, refreshed.id)).status).toBe('completed')
    expect((await execute('state') as VideoStudioState).projects[0]!.outputAssetId).toBeUndefined()
    expect(requests).toBe(2)
  })
  it('resumes the persisted provider task instead of submitting another paid generation', async () => {
    const { execute } = setup()
    const provider = await savedProvider(execute)
    const project = await execute('save_project', { name: 'Resume', providerId: provider.id, shots: [{ title: 'Sunrise', prompt: 'Sunrise over a lake', durationSeconds: 5, memoryIds: [] }] }) as VideoProject
    const path = join(directory, 'video', 'studio.json')
    const saved = JSON.parse(await readFile(path, 'utf8')) as VideoStudioState
    Object.assign(saved.projects[0]!.shots[0]!, { providerTaskId: 'already-paid', providerId: provider.id, status: 'generating', generationInputHash: videoGenerationInputHash(saved.projects[0]!, saved.projects[0]!.shots[0]!, [], provider) })
    await writeFile(path, JSON.stringify(saved))
    let created = 0; let polled = ''
    const resumed = setup({ providerApi: { ...providers, createVideoTask: async () => { created++; throw new Error('Must not create') }, pollVideoTask: async (_provider, _key, id) => { polled = id; return { id, status: 'completed', url: 'https://cdn.example/movie.mp4' } }, fetchVideoOutput: async () => new Response('clip'), cancelVideoTask: async () => {} } })
    // Rehydrate the credential vault independently from the JSON project archive.
    await resumed.execute('save_provider', { id: provider.id, apiKey: 'secret-api-key' })
    const job = await resumed.execute('generate_shot', { projectId: project.id, shotId: project.shots[0]!.id }) as VideoJob
    expect((await terminal(resumed.execute, job.id)).status).toBe('completed')
    expect(created).toBe(0); expect(polled).toBe('already-paid')
  })
  it('serializes project jobs and rejects asset IDs from outside the workspace', async () => {
    const { execute, service } = setup({ analyzer: async (_input, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) })
    const project = await execute('save_project', { name: 'Concurrent', script: 'A scene' }) as VideoProject
    const calls = await Promise.allSettled([execute('analyze', { projectId: project.id }), execute('analyze', { projectId: project.id })])
    expect(calls.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const accepted = calls.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<VideoJob>
    await execute('cancel_job', { jobId: accepted.value.id })
    expect((await terminal(execute, accepted.value.id)).status).toBe('cancelled')
    await expect(execute('read_asset', { assetId: '../secrets' })).rejects.toThrow('无效')
    await expect(service.execute('other-workspace', 'state')).rejects.toThrow('找不到工作区')
  })
  it('preserves ambiguous submission status and requires explicit regeneration before another POST', async () => {
    let submits = 0
    const { execute } = setup({ providerApi: { ...providers, createVideoTask: async () => { submits++; throw Object.assign(new Error('lost connection'), { submissionUnknown: true }) } } })
    const provider = await savedProvider(execute)
    const project = await execute('save_project', { name: 'Unknown submission', providerId: provider.id, shots: [{ title: 'Sunrise', prompt: 'A lake', durationSeconds: 5, memoryIds: [] }] }) as VideoProject
    const args = { projectId: project.id, shotId: project.shots[0]!.id }
    for (let i = 0; i < 2; i++) { const job = await execute('generate_shot', args) as VideoJob; expect((await terminal(execute, job.id)).error).toContain('提交结果不明') }
    expect(submits).toBe(1)
    const current = (await execute('state') as VideoStudioState).projects[0]!
    await execute('save_project', { id: current.id, name: 'Renamed without retry', shots: current.shots })
    const renamedRetry = await execute('generate_shot', args) as VideoJob
    expect((await terminal(execute, renamedRetry.id)).error).toContain('提交结果不明')
    expect(submits).toBe(1)
    const explicit = await execute('generate_shot', { ...args, regenerate: true }) as VideoJob
    await terminal(execute, explicit.id)
    expect(submits).toBe(2)
  })
  it('exports bounded chunks with stable offsets and does not expose arbitrary filesystem reads', async () => {
    const { execute } = setup()
    const asset = await execute('import_asset', { name: 'clip.mp4', mimeType: 'video/mp4', bytesBase64: Buffer.from('abcdefghijk').toString('base64') }) as VideoAsset
    const chunks: Buffer[] = []
    let offset = 0
    while (true) {
      const chunk = await execute('export_asset', { assetId: asset.id, offset, length: 4 }) as any
      const bytes = Buffer.from(chunk.bytesBase64, 'base64'); chunks.push(bytes)
      expect(chunk.offset).toBe(offset); expect(chunk.totalBytes).toBe(11)
      offset += bytes.length
      if (chunk.eof) break
    }
    expect(Buffer.concat(chunks).toString()).toBe('abcdefghijk')
    await expect(execute('export_asset', { assetId: asset.id, offset: -1, length: 4 })).rejects.toThrow('数值')
    await expect(execute('export_asset', { assetId: asset.id, length: 10 * 1024 * 1024 })).rejects.toThrow('数值')
  })
  it('uses a consistent memory snapshot for every shot while later preference edits are saved', async () => {
    let firstStarted!: () => void; const started = new Promise<void>(resolve => { firstStarted = resolve })
    let releaseFirst!: () => void; const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    const prompts: string[] = []
    const adapter = { ...providers, createVideoTask: async (_provider: VideoProvider, _key: string, input: providers.VideoGenerationInput) => { prompts.push(input.prompt); if (prompts.length === 1) firstStarted(); return { id: `task${prompts.length}`, status: 'pending' as const } }, pollVideoTask: async (_provider: VideoProvider, _key: string, id: string) => { if (id === 'task1') await gate; return { id, status: 'completed' as const, url: 'https://cdn.example/clip.mp4' } }, fetchVideoOutput: async () => new Response('clip'), cancelVideoTask: async () => {} }
    const { execute } = setup({ providerApi: adapter })
    const provider = await savedProvider(execute)
    const memory = await execute('save_memory', { kind: 'person', name: 'Alice', description: 'Original blue coat', enabled: false }) as VideoMemory
    const project = await execute('save_project', { name: 'Consistent film', providerId: provider.id, memoryIds: [memory.id], shots: [{ title: 'One', prompt: 'Walk', durationSeconds: 5 }, { title: 'Two', prompt: 'Wave', durationSeconds: 5 }] }) as VideoProject
    const job = await execute('generate_project', { projectId: project.id }) as VideoJob
    await started
    try {
      await execute('save_memory', { id: memory.id, description: 'Later red coat' })
      await expect(execute('save_provider', { id: provider.id, model: 'another-model' })).rejects.toThrow('运行中的任务')
    } finally { releaseFirst() }
    expect((await terminal(execute, job.id)).status).toBe('completed')
    expect(prompts).toHaveLength(2)
    for (const prompt of prompts) { expect(prompt).toContain('Original blue coat'); expect(prompt).not.toContain('Later red coat') }
    expect((await execute('state') as VideoStudioState).memories[0]!.description).toBe('Later red coat')
  })
  it('burns narration captions into the complete movie and saves an editable timed subtitle asset', async () => {
    const { execute } = setup()
    const clip = await execute('import_asset', { name: 'clip.mp4', mimeType: 'video/mp4', bytesBase64: Buffer.from('clip').toString('base64') }) as VideoAsset
    const project = await execute('save_project', { name: 'Captioned film', shots: [{ title: 'First', prompt: 'A park', durationSeconds: 2, assetId: clip.id, narration: 'Alice arrives.' }, { title: 'Second', prompt: 'A lake', durationSeconds: 2, assetId: clip.id, narration: 'She sees a lake.' }] }) as VideoProject
    const job = await execute('render_project', { projectId: project.id }) as VideoJob
    const result = await terminal(execute, job.id)
    expect(result.status).toBe('completed')
    const state = await execute('state') as VideoStudioState
    const captions = state.assets.find(asset => asset.mimeType === 'application/x-subrip')!
    const exported = await execute('export_asset', { assetId: captions.id }) as any
    const content = Buffer.from(exported.bytesBase64, 'base64').toString('utf8')
    expect(content).toContain('00:00:00,000 --> 00:00:05,000\nAlice arrives.')
    expect(content).toContain('00:00:05,000 --> 00:00:10,000\nShe sees a lake.')
    const movie = await execute('export_asset', { assetId: result.outputAssetId }) as any
    expect(Buffer.from(movie.bytesBase64, 'base64').toString()).toBe('edited-video')
  })
  it('saves incomplete draft shots and rejects empty generation prompts before provider submission', async () => {
    let submitted = 0
    const { execute } = setup({ providerApi: { ...providers, createVideoTask: async () => { submitted++; throw new Error('Should not submit') } } })
    const provider = await savedProvider(execute)
    const project = await execute('save_project', { name: 'Draft', providerId: provider.id, shots: [{ title: 'Unwritten shot', prompt: '', durationSeconds: 5 }] }) as VideoProject
    expect(project.shots[0]!.prompt).toBe('')
    const job = await execute('generate_shot', { projectId: project.id, shotId: project.shots[0]!.id }) as VideoJob
    expect((await terminal(execute, job.id)).error).toContain('请先填写分镜')
    expect(submitted).toBe(0)
  })
  it('invalidates the current full movie after content settings change while retaining exported assets', async () => {
    const { execute } = setup()
    const clip = await execute('import_asset', { name: 'clip.mp4', mimeType: 'video/mp4', bytesBase64: Buffer.from('clip').toString('base64') }) as VideoAsset
    const project = await execute('save_project', { name: 'Film', script: 'Original script', shots: [{ title: 'One', prompt: 'A park', durationSeconds: 5, assetId: clip.id }] }) as VideoProject
    const rendered = await terminal(execute, (await execute('render_project', { projectId: project.id }) as VideoJob).id)
    expect(rendered.outputAssetId).toBeDefined()
    const renamed = await execute('save_project', { id: project.id, name: 'Film renamed' }) as VideoProject
    expect(renamed.outputAssetId).toBe(rendered.outputAssetId)
    const changed = await execute('save_project', { id: project.id, script: 'A different script' }) as VideoProject
    expect(changed.outputAssetId).toBeUndefined()
    expect((await execute('state') as VideoStudioState).assets.some(asset => asset.id === rendered.outputAssetId)).toBe(true)
  })
  it('requires explicit regeneration for changed visual inputs but freely reuses title and subtitle edits', async () => {
    let submitted = 0
    const adapter: typeof providers = { ...providers, createVideoTask: async () => ({ id: `task-${++submitted}`, status: 'completed', url: 'https://cdn.example/movie.mp4' }), fetchVideoOutput: async () => new Response('clip') }
    const { execute } = setup({ providerApi: adapter })
    const provider = await savedProvider(execute)
    const memory = await execute('save_memory', { kind: 'person', name: 'Alice', description: 'A blue coat' }) as VideoMemory
    const project = await execute('save_project', { name: 'Guarded film', providerId: provider.id, memoryIds: [memory.id], shots: [{ title: 'Original', prompt: 'Alice waves', durationSeconds: 5 }] }) as VideoProject
    const first = await execute('generate_shot', { projectId: project.id, shotId: project.shots[0]!.id }) as VideoJob
    expect((await terminal(execute, first.id)).status).toBe('completed')
    const generated = (await execute('state') as VideoStudioState).projects[0]!
    expect(generated.shots[0]!.generationInputHash).toMatch(/^[a-f0-9]{64}$/)
    const edited = await execute('save_project', { id: project.id, shots: [{ ...generated.shots[0], title: 'Renamed', narration: 'New subtitle only' }] }) as VideoProject
    expect(edited.shots[0]!.generationInputHash).toBe(generated.shots[0]!.generationInputHash)
    const reused = await execute('generate_project', { projectId: project.id }) as VideoJob
    expect((await terminal(execute, reused.id)).status).toBe('completed')
    expect(submitted).toBe(1)
    await execute('save_memory', { id: memory.id, description: 'A red coat' })
    const stale = await execute('generate_project', { projectId: project.id }) as VideoJob
    expect((await terminal(execute, stale.id)).error).toContain('设置已变化')
    expect(submitted).toBe(1)
    const explicit = await execute('generate_shot', { projectId: project.id, shotId: project.shots[0]!.id, regenerate: true }) as VideoJob
    expect((await terminal(execute, explicit.id)).status).toBe('completed')
    expect(submitted).toBe(2)
    expect((await execute('state') as VideoStudioState).projects[0]!.shots[0]!.generationInputHash).not.toBe(generated.shots[0]!.generationInputHash)
  })
  it('preflights stale shots later in the project before charging for earlier missing shots', async () => {
    let submitted = 0
    const adapter: typeof providers = { ...providers, createVideoTask: async () => ({ id: `task-${++submitted}`, status: 'completed', url: 'https://cdn.example/movie.mp4' }), fetchVideoOutput: async () => new Response('clip') }
    const { execute } = setup({ providerApi: adapter })
    const provider = await savedProvider(execute)
    const project = await execute('save_project', { name: 'Preflight', providerId: provider.id, shots: [{ title: 'Existing shot', prompt: 'A lake', durationSeconds: 5 }] }) as VideoProject
    await terminal(execute, (await execute('generate_shot', { projectId: project.id, shotId: project.shots[0]!.id }) as VideoJob).id)
    const current = (await execute('state') as VideoStudioState).projects[0]!
    await execute('save_project', { id: project.id, preferences: 'A new style', shots: [{ title: 'Missing first shot', prompt: 'A forest', durationSeconds: 5 }, current.shots[0]!] })
    const result = await terminal(execute, (await execute('generate_project', { projectId: project.id }) as VideoJob).id)
    expect(result.error).toContain('Existing shot')
    expect(result.error).toContain('明确重新生成')
    expect(submitted).toBe(1)
  })
  it('requires explicit regeneration for old provider assets without hashes and preserves manual replacements', async () => {
    const { execute } = setup()
    const provider = await savedProvider(execute)
    const project = await execute('save_project', { name: 'Legacy film', providerId: provider.id, shots: [{ title: 'Legacy', prompt: 'A lake', durationSeconds: 5 }] }) as VideoProject
    await terminal(execute, (await execute('generate_shot', { projectId: project.id, shotId: project.shots[0]!.id }) as VideoJob).id)
    const path = join(directory, 'video', 'studio.json')
    const saved = JSON.parse(await readFile(path, 'utf8')) as VideoStudioState
    delete saved.projects[0]!.shots[0]!.generationInputHash
    await writeFile(path, JSON.stringify(saved))
    let submitted = 0
    const reopened = setup({ providerApi: { ...providers, createVideoTask: async () => { submitted++; throw new Error('Must not charge') } } })
    await reopened.execute('save_provider', { id: provider.id, apiKey: 'test-key' })
    const legacy = await terminal(reopened.execute, (await reopened.execute('generate_project', { projectId: project.id }) as VideoJob).id)
    expect(legacy.error).toContain('缺少生成参数记录')
    expect(submitted).toBe(0)
    const manual = await reopened.execute('import_asset', { name: 'manual.mp4', mimeType: 'video/mp4', bytesBase64: Buffer.from('manual clip').toString('base64') }) as VideoAsset
    const current = (await reopened.execute('state') as VideoStudioState).projects[0]!
    const replaced = await reopened.execute('save_project', { id: project.id, preferences: 'Changed preferences', shots: [{ ...current.shots[0], assetId: manual.id }] }) as VideoProject
    expect(replaced.shots[0]!.providerId).toBeUndefined()
    expect(replaced.shots[0]!.generationInputHash).toBeUndefined()
    const result = await terminal(reopened.execute, (await reopened.execute('generate_project', { projectId: project.id }) as VideoJob).id)
    expect(result.status).toBe('completed')
    expect(submitted).toBe(0)
  })
  it('fingerprints all effective visual settings without including subtitles or titles', async () => {
    const provider: VideoProvider = { id: 'provider', name: 'Service', kind: 'seedance', baseUrl: 'https://video.example/v3', model: 'model', hasApiKey: true, createdAt: 1, updatedAt: 1 }
    const memory: VideoMemory = { id: 'person', name: 'Alice', kind: 'person', description: 'Blue coat', enabled: true, imageAssetIds: ['image'], referenceUrl: 'https://images.example/a.png', createdAt: 1, updatedAt: 1 }
    const shot: VideoProject['shots'][number] = { id: 'shot', title: 'One', prompt: 'Walk', durationSeconds: 5, memoryIds: ['person'] }
    const project: VideoProject = { id: 'project', name: 'Film', script: '', preferences: 'Natural light', aspectRatio: '16:9', memoryIds: [], shots: [shot], createdAt: 1, updatedAt: 1 }
    const base = videoGenerationInputHash(project, shot, [memory], provider)
    expect(videoGenerationInputHash({ ...project, name: 'Renamed' }, { ...shot, title: 'Renamed', narration: 'Edited subtitles' }, [memory], { ...provider, name: 'Renamed service' })).toBe(base)
    for (const patch of [{ prompt: 'Run' }, { durationSeconds: 6 }]) expect(videoGenerationInputHash(project, { ...shot, ...patch }, [memory], provider)).not.toBe(base)
    for (const patch of [{ preferences: 'Warm lighting' }, { aspectRatio: '9:16' as const }, { model: 'other-model' }]) expect(videoGenerationInputHash({ ...project, ...patch }, shot, [memory], provider)).not.toBe(base)
    for (const patch of [{ description: 'Red coat' }, { referenceUrl: 'https://images.example/b.png' }, { imageAssetIds: ['different-image'] }, { enabled: false }]) expect(videoGenerationInputHash(project, shot, [{ ...memory, ...patch }], provider)).not.toBe(base)
    for (const patch of [{ id: 'other-provider' }, { model: 'other-model' }, { baseUrl: 'https://other.example/v3' }, { kind: 'runway' as const }]) expect(videoGenerationInputHash(project, shot, [memory], { ...provider, ...patch })).not.toBe(base)
  })
  it('enforces host analysis constraints at execution time while ordinary workbench analysis remains available', async () => {
    let analyzed = 0
    const { service, execute } = setup({ analyzer: async () => { analyzed++; return { memories: [], shots: [{ title: 'A scene', prompt: 'A lake', durationSeconds: 5, memoryIds: [] }] } } })
    const project = await execute('save_project', { name: 'Agent boundary', script: 'A scene' }) as VideoProject
    await expect(service.execute('workspace', 'analyze', { projectId: project.id, allowAgentAnalysis: true }, { allowAgentAnalysis: false })).rejects.toThrow('additional Agent')
    const context = { allowAgentAnalysis: false }
    const pending = service.execute('workspace', 'generate_project', { projectId: project.id, analyzeFirst: true, hostContext: { allowAgentAnalysis: true } }, context)
    context.allowAgentAnalysis = true
    const denied = await terminal(execute, (await pending as VideoJob).id)
    expect(denied.status).toBe('failed')
    expect(denied.error).toContain('additional Agent')
    expect(analyzed).toBe(0)
    const normal = await terminal(execute, (await execute('analyze', { projectId: project.id }) as VideoJob).id)
    expect(normal.status).toBe('completed')
    expect(analyzed).toBe(1)
  })
  it('keeps the project locked after cancellation until delayed Agent cleanup has actually finished', async () => {
    let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve })
    let release!: () => void; const cleanup = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const { execute } = setup({ analyzer: async (_input, signal) => {
      if (++calls > 1) return { memories: [], shots: [{ title: 'Replacement', prompt: 'A lake', durationSeconds: 5, memoryIds: [] }] }
      started()
      try { return await new Promise<never>((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); if (signal.aborted) reject(new Error('cancelled')) }) }
      finally { await cleanup }
    } })
    const project = await execute('save_project', { name: 'Cleanup lock', script: 'A scene' }) as VideoProject
    const job = await execute('analyze', { projectId: project.id }) as VideoJob
    await entered
    try {
      const cancelled = await execute('cancel_job', { jobId: job.id }) as VideoJob
      expect(cancelled.status).toBe('cancelled')
      await expect(execute('analyze', { projectId: project.id })).rejects.toThrow('停止中')
      await expect(execute('save_project', { id: project.id, script: 'Changed too early' })).rejects.toThrow('停止清理')
      await expect(execute('delete_project', { id: project.id })).rejects.toThrow('停止中的任务')
      expect(calls).toBe(1)
    } finally { release() }
    expect((await terminal(execute, job.id)).status).toBe('cancelled')
    const replacement = await execute('analyze', { projectId: project.id }) as VideoJob
    expect((await terminal(execute, replacement.id)).status).toBe('completed')
    expect(calls).toBe(2)
  })
})
