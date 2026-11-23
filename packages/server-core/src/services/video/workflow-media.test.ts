import { describe, expect, it } from 'bun:test'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { CredentialId, StoredCredential } from '@tokenbird/shared/credentials'
import type { VideoAsset, VideoJob, VideoMemory, VideoProject, VideoProvider, VideoStudioState } from '@tokenbird/shared/video'
import { probeVideo, runVideoCommand } from './ffmpeg'
import * as providers from './providers'
import { VideoService } from './service'

// This test deliberately requires the packaged runtime rather than proving only a PATH installation.
const repository = resolve(import.meta.dir, '../../../../..')
const runtime = join(repository, 'apps', 'electron', 'resources', 'bin', `${process.platform}-${process.arch}`)
const suffix = process.platform === 'win32' ? '.exe' : ''
const bundled = existsSync(join(runtime, `ffmpeg${suffix}`)) && existsSync(join(runtime, `ffprobe${suffix}`))
const artifactDirectory = process.env.TOKENBIRD_VIDEO_SMOKE_ARTIFACT_DIR

async function finish(service: VideoService, job: VideoJob): Promise<VideoJob> {
  for (let i = 0; i < 900; i++) {
    const current = await service.execute('workspace', 'job', { jobId: job.id }) as VideoJob
    if (!['queued', 'running'].includes(current.status)) {
      if (current.status !== 'completed') throw new Error(`Real-media video workflow failed: ${current.error ?? current.message}`)
      return current
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Real-media video workflow did not complete within 90 seconds')
}

describe('Video Studio with bundled media runtime', () => {
  it.skipIf(!bundled)('turns a remembered person and script into a captioned film, exports chunks and reuses generated shots after restart', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'tokenbird-video-workflow-'))
    const oldRoot = process.env.TOKENBIRD_BUNDLED_ASSETS_ROOT
    const oldFfmpeg = process.env.TOKENBIRD_FFMPEG_PATH
    const oldFfprobe = process.env.TOKENBIRD_FFPROBE_PATH
    process.env.TOKENBIRD_BUNDLED_ASSETS_ROOT = join(repository, 'apps', 'electron')
    process.env.TOKENBIRD_FFMPEG_PATH = join(runtime, `ffmpeg${suffix}`)
    process.env.TOKENBIRD_FFPROBE_PATH = join(runtime, `ffprobe${suffix}`)
    try {
      const workspace = join(temporary, 'workspace')
      await mkdir(workspace)
      const landscape = join(temporary, 'landscape-with-audio.mp4')
      const portrait = join(temporary, 'portrait-silent.mp4')
      const reference = join(temporary, 'reference.png')
      // Fixtures intentionally differ in dimensions, frame rate and audio presence.
      await runVideoCommand('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:r=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'aac', '-shortest', landscape])
      await runVideoCommand('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=c=darkgreen:s=240x320:r=15', '-t', '1', '-c:v', 'mpeg4', '-q:v', '4', '-an', portrait])
      await runVideoCommand('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-n', '-i', landscape, '-frames:v', '1', reference])
      expect((await probeVideo(landscape)).hasAudio).toBe(true)
      expect((await probeVideo(portrait)).hasAudio).toBe(false)

      const vault = new Map<string, StoredCredential>()
      const credentials = {
        get: async (id: CredentialId) => vault.get(JSON.stringify(id)) ?? null,
        set: async (id: CredentialId, value: StoredCredential) => { vault.set(JSON.stringify(id), value) },
        delete: async (id: CredentialId) => vault.delete(JSON.stringify(id)),
      }
      const clips = [await readFile(landscape), await readFile(portrait)]
      let submissions = 0; let analyses = 0
      const submittedPrompts: string[] = []
      const adapter: typeof providers = {
        ...providers,
        createVideoTask: async (_provider, _token, input) => {
          expect(input.references).toHaveLength(1)
          expect(input.references[0]!.url).toStartWith('data:image/png;base64,')
          submittedPrompts.push(input.prompt)
          return { id: `fixture-task-${++submissions}`, status: 'pending' }
        },
        pollVideoTask: async (_provider, _token, taskId) => ({ id: taskId, status: 'completed', url: `https://fixture.example/${taskId}.mp4` }),
        fetchVideoOutput: async (_provider, _token, task) => new Response(clips[Number(task.id.split('-').at(-1)) - 1], { headers: { 'Content-Type': 'video/mp4' } }),
        cancelVideoTask: async () => {},
      }
      const makeService = () => new VideoService({
        resolveWorkspace: id => id === 'workspace' ? { id, rootPath: workspace } : null,
        credentials,
        providerApi: adapter,
        pollIntervalMs: 1,
        analyzer: async input => {
          analyses++
          expect(input.project.script).toContain('小林走进公园')
          const person = input.memories.find(memory => memory.name === '小林')!
          expect(person.imageAssetIds).toHaveLength(1)
          input.onSession?.('fixture-analysis-session')
          return {
            agentSessionId: 'fixture-analysis-session',
            memories: [
              { kind: 'person', name: '小林', existingId: person.id, description: '不可替换用户已有的身份描述' },
              { kind: 'scene', name: '清晨公园', description: '清晨薄雾与绿树，柔和自然光' },
            ],
            shots: [
              { title: '进入公园', prompt: '中景，小林沿小路走进薄雾中的公园', durationSeconds: 5, memoryIds: [person.id], memoryNames: ['清晨公园'], narration: '小林走进清晨的公园。' },
              { title: '望向湖面', prompt: '近景，小林停步望向平静湖面', durationSeconds: 5, memoryIds: [person.id], memoryNames: ['清晨公园'], narration: '微风吹过，湖面泛起涟漪。' },
            ],
          }
        },
      })
      const service = makeService()
      const provider = await service.execute('workspace', 'save_provider', { kind: 'runway', name: 'Fixture provider', baseUrl: 'https://fixture.example/v1', model: 'gen4.5', apiKey: 'fixture-test-key' }) as VideoProvider
      const image = await service.execute('workspace', 'import_asset', { name: '小林参考.png', mimeType: 'image/png', bytesBase64: (await readFile(reference)).toString('base64') }) as VideoAsset
      const memory = await service.execute('workspace', 'save_memory', { kind: 'person', name: '小林', description: '短发，蓝色外套，圆框眼镜', imageAssetIds: [image.id] }) as VideoMemory
      const project = await service.execute('workspace', 'save_project', { name: '公园短片', script: '小林走进公园，沿小路走到湖边。', preferences: '自然光，保持人物一致', providerId: provider.id, aspectRatio: '16:9', memoryIds: [memory.id] }) as VideoProject
      const job = await service.execute('workspace', 'generate_project', { projectId: project.id, analyzeFirst: true, connectionSlug: 'fixture-agent' }) as VideoJob
      const result = await finish(service, job)
      expect(result.agentSessionId).toBe('fixture-analysis-session')
      expect(submissions).toBe(2)
      expect(analyses).toBe(1)
      for (const prompt of submittedPrompts) { expect(prompt).toContain('蓝色外套'); expect(prompt).toContain('清晨薄雾') }

      const state = await service.execute('workspace', 'state') as VideoStudioState
      const output = state.assets.find(asset => asset.id === result.outputAssetId)!
      const metadata = await probeVideo(output.path)
      expect(metadata.width).toBe(1280)
      expect(metadata.height).toBe(720)
      expect(metadata.hasVideo).toBe(true)
      expect(metadata.hasAudio).toBe(true)
      expect(metadata.durationSeconds).toBeGreaterThanOrEqual(1.95)
      expect(metadata.durationSeconds).toBeLessThan(2.3)
      const frameDetails = JSON.parse(await runVideoCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames,r_frame_rate', '-of', 'json', output.path])) as { streams: Array<{ nb_read_frames: string; r_frame_rate: string }> }
      expect(Number(frameDetails.streams[0]!.nb_read_frames)).toBeGreaterThanOrEqual(60)
      expect(frameDetails.streams[0]!.r_frame_rate).toBe('30/1')
      const captions = state.assets.find(asset => asset.mimeType === 'application/x-subrip')!
      const subtitleText = await readFile(captions.path, 'utf8')
      expect(subtitleText).toContain('00:00:00,000 --> 00:00:01,000')
      expect(subtitleText).toContain('00:00:01,000 --> 00:00:02,000')
      expect(subtitleText).toContain('小林走进清晨的公园。')
      expect(state.memories.find(item => item.id === memory.id)!.description).toBe('短发，蓝色外套，圆框眼镜')

      const chunks: Buffer[] = []; let offset = 0
      while (true) {
        const chunk = await service.execute('workspace', 'export_asset', { assetId: output.id, offset, length: 4096 }) as { bytesBase64: string; offset: number; totalBytes: number; eof: boolean }
        expect(chunk.offset).toBe(offset); expect(chunk.totalBytes).toBe(output.bytes)
        const bytes = Buffer.from(chunk.bytesBase64, 'base64'); chunks.push(bytes); offset += bytes.length
        if (chunk.eof) break
      }
      expect(chunks.length).toBeGreaterThan(1)
      expect(Buffer.concat(chunks)).toEqual(await readFile(output.path))

      const restarted = makeService()
      const resumedJob = await restarted.execute('workspace', 'generate_project', { projectId: project.id }) as VideoJob
      await finish(restarted, resumedJob)
      expect(submissions).toBe(2)
      expect(analyses).toBe(1)
      expect((await restarted.execute('workspace', 'state') as VideoStudioState).projects[0]!.shots.every(shot => shot.status === 'completed')).toBe(true)
      if (artifactDirectory) {
        const target = resolve(artifactDirectory)
        await mkdir(target, { recursive: true })
        await copyFile(output.path, join(target, 'video-workflow-smoke.mp4'))
        await copyFile(captions.path, join(target, 'video-workflow-smoke.srt'))
        const frame = join(target, 'video-workflow-smoke.png')
        await rm(frame, { force: true })
        await runVideoCommand('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-n', '-ss', '0.5', '-i', output.path, '-frames:v', '1', frame])
        await writeFile(join(target, 'video-workflow-smoke.json'), JSON.stringify({ metadata, frameDetails, providerSubmissions: submissions, agentAnalyses: analyses, exportedChunks: chunks.length, fixtureProvider: true, fixtureAnalyzer: true, realBundledMedia: true }, null, 2), 'utf8')
      }
    } finally {
      for (const [key, value] of Object.entries({ TOKENBIRD_BUNDLED_ASSETS_ROOT: oldRoot, TOKENBIRD_FFMPEG_PATH: oldFfmpeg, TOKENBIRD_FFPROBE_PATH: oldFfprobe })) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
      await rm(temporary, { recursive: true, force: true })
    }
  }, 120_000)
})
