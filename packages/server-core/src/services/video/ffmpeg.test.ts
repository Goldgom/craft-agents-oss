import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { concatVideo, probeVideo, processVideo, resolveVideoExecutable, runVideoCommand } from './ffmpeg'

const root = resolve(import.meta.dir, '../../../../..')
const runtime = join(root, 'apps', 'electron', 'resources', 'bin', `${process.platform}-${process.arch}`)
const suffix = process.platform === 'win32' ? '.exe' : ''
const available = existsSync(join(runtime, `ffmpeg${suffix}`)) && existsSync(join(runtime, `ffprobe${suffix}`))

describe('bundled FFmpeg editing', () => {
  let directory: string
  let video: string
  let silent: string
  let image: string
  const oldFfmpeg = process.env.TOKENBIRD_FFMPEG_PATH
  const oldFfprobe = process.env.TOKENBIRD_FFPROBE_PATH
  beforeAll(async () => {
    if (!available) return
    directory = await mkdtemp(join(tmpdir(), "tokenbird video 'unicode 中文-"))
    process.env.TOKENBIRD_FFMPEG_PATH = join(runtime, `ffmpeg${suffix}`)
    process.env.TOKENBIRD_FFPROBE_PATH = join(runtime, `ffprobe${suffix}`)
    video = join(directory, "source 'clip 中文.mp4")
    silent = join(directory, 'silent.mp4')
    image = join(directory, 'watermark.png')
    await runVideoCommand('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:r=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'mpeg4', '-c:a', 'aac', video])
    await runVideoCommand('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=c=green:s=240x320:r=15', '-t', '1', '-c:v', 'mpeg4', silent])
    await runVideoCommand('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'color=c=red:s=30x20', '-frames:v', '1', image])
  }, 60_000)
  afterAll(async () => {
    if (oldFfmpeg === undefined) delete process.env.TOKENBIRD_FFMPEG_PATH; else process.env.TOKENBIRD_FFMPEG_PATH = oldFfmpeg
    if (oldFfprobe === undefined) delete process.env.TOKENBIRD_FFPROBE_PATH; else process.env.TOKENBIRD_FFPROBE_PATH = oldFfprobe
    if (directory) await rm(directory, { recursive: true, force: true })
  }, 30_000)

  it('honors explicit runtime overrides without silently falling back', () => {
    const old = process.env.TOKENBIRD_FFMPEG_PATH
    process.env.TOKENBIRD_FFMPEG_PATH = join(root, '.tmp', 'nonexistent-video-binary.exe')
    try { expect(() => resolveVideoExecutable('ffmpeg')).toThrow('TOKENBIRD_FFMPEG_PATH does not exist') }
    finally { if (old === undefined) delete process.env.TOKENBIRD_FFMPEG_PATH; else process.env.TOKENBIRD_FFMPEG_PATH = old }
  })
  it.skipIf(!available)('handles trim, resize, crop, rotation, speed and volume using actual local media', async () => {
    const trim = await processVideo({ operation: 'trim', inputPaths: [video], outputPath: join(directory, 'trim.mp4'), startSeconds: .2, durationSeconds: .4 })
    expect(trim.metadata.durationSeconds).toBeGreaterThan(.3); expect(trim.metadata.durationSeconds).toBeLessThan(.65)
    const resize = await processVideo({ operation: 'resize', inputPaths: [video], outputPath: join(directory, 'resize.mp4'), width: 160, height: 90 })
    expect([resize.metadata.width, resize.metadata.height]).toEqual([160, 90])
    const crop = await processVideo({ operation: 'crop', inputPaths: [video], outputPath: join(directory, 'crop.mp4'), crop: { x: 10, y: 10, width: 100, height: 80 } })
    expect([crop.metadata.width, crop.metadata.height]).toEqual([100, 80])
    const rotate = await processVideo({ operation: 'rotate', inputPaths: [video], outputPath: join(directory, 'rotate.mp4'), rotation: 90 })
    expect([rotate.metadata.width, rotate.metadata.height]).toEqual([180, 320])
    const speed = await processVideo({ operation: 'speed', inputPaths: [video], outputPath: join(directory, 'speed.mp4'), speed: 2 })
    expect(speed.metadata.durationSeconds).toBeLessThan(.7); expect(speed.metadata.hasAudio).toBe(true)
    const volume = await processVideo({ operation: 'volume', inputPaths: [video], outputPath: join(directory, 'volume.mp4'), volume: .5 })
    expect(volume.metadata.hasAudio).toBe(true)
  }, 60_000)
  it.skipIf(!available)('normalizes portrait silent and landscape audio segments before concatenating', async () => {
    const result = await concatVideo([video, silent], join(directory, 'concat.mp4'), { width: 320, height: 180, fps: 24 })
    expect(result.metadata.width).toBe(320); expect(result.metadata.height).toBe(180)
    expect(result.metadata.hasAudio).toBe(true); expect(result.metadata.durationSeconds).toBeGreaterThan(1.9); expect(result.metadata.durationSeconds).toBeLessThan(2.3)
  }, 60_000)
  it.skipIf(!available)('extracts audio and frames, mutes, overlays images and mixes music', async () => {
    const audio = await processVideo({ operation: 'extract_audio', inputPaths: [video], outputPath: join(directory, 'audio.wav') })
    expect(audio.metadata.hasAudio).toBe(true); expect(audio.metadata.hasVideo).toBe(false)
    const frame = await processVideo({ operation: 'extract_frame', inputPaths: [video], outputPath: join(directory, 'frame.png'), startSeconds: .2 })
    expect(frame.metadata.width).toBe(320)
    const mute = await processVideo({ operation: 'mute', inputPaths: [video], outputPath: join(directory, 'mute.mp4') })
    expect(mute.metadata.hasAudio).toBe(false)
    const overlay = await processVideo({ operation: 'overlay', inputPaths: [video], outputPath: join(directory, 'overlay.mp4'), watermarkPath: image })
    expect(overlay.metadata.hasVideo).toBe(true)
    const music = await processVideo({ operation: 'music', inputPaths: [silent], outputPath: join(directory, 'music.mp4'), musicPath: audio.outputPath, volume: .3 })
    expect(music.metadata.hasAudio).toBe(true); expect(music.metadata.durationSeconds).toBeLessThan(1.2)
  }, 60_000)
  it.skipIf(!available)('burns Chinese subtitles from a filename containing apostrophes and spaces', async () => {
    const subtitles = join(directory, "中文 ' captions.srt")
    await writeFile(subtitles, '1\n00:00:00,000 --> 00:00:00,900\n你好，词元鸟。\n')
    const output = await processVideo({ operation: 'subtitles', inputPaths: [video], outputPath: join(directory, 'subtitled.mp4'), subtitlesPath: subtitles })
    expect(output.metadata.durationSeconds).toBeGreaterThan(.9)
  }, 60_000)
  it.skipIf(!available)('rejects unsafe/invalid arguments and preserves existing output', async () => {
    await expect(processVideo({ operation: 'resize', inputPaths: [video], outputPath: join(directory, 'invalid.mp4'), width: 101, height: 100 })).rejects.toThrow('even integer')
    await expect(processVideo({ operation: 'trim', inputPaths: [video], outputPath: video, durationSeconds: .4 })).rejects.toThrow('Output must differ')
    await expect(probeVideo('https://example.com/video.mp4')).rejects.toThrow('local media file')
    const cancelled = new AbortController(); cancelled.abort()
    await expect(processVideo({ operation: 'transcode', inputPaths: [video], outputPath: join(directory, 'cancelled.mp4') }, { signal: cancelled.signal })).rejects.toThrow()
  })
})
