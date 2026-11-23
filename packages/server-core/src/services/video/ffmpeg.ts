import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, copyFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, extname, join, resolve, delimiter } from 'node:path'
import { getBundledAssetsDir } from '@tokenbird/shared/utils'

export type VideoOperation = 'trim' | 'concat' | 'resize' | 'crop' | 'rotate' | 'speed' | 'mute' | 'volume'
  | 'extract_audio' | 'extract_frame' | 'transcode' | 'subtitles' | 'overlay' | 'music'
export interface VideoMetadata {
  durationSeconds: number
  width?: number
  height?: number
  hasVideo: boolean
  hasAudio: boolean
  format: string
  bytes: number
  streams: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>
}
export interface VideoProcessInput {
  operation: VideoOperation
  inputPaths: string[]
  outputPath: string
  startSeconds?: number
  durationSeconds?: number
  width?: number
  height?: number
  crop?: { x: number; y: number; width: number; height: number }
  rotation?: 90 | 180 | 270
  speed?: number
  volume?: number
  mute?: boolean
  watermarkPath?: string
  subtitlesPath?: string
  musicPath?: string
  format?: string
}
export interface VideoRunOptions { signal?: AbortSignal; timeoutMs?: number }
export interface VideoProcessResult { outputPath: string; metadata: VideoMetadata }

/** Resolve each executable independently so an explicit override is never silently ignored. */
export function resolveVideoExecutable(tool: 'ffmpeg' | 'ffprobe'): string {
  const envName = tool === 'ffmpeg' ? 'TOKENBIRD_FFMPEG_PATH' : 'TOKENBIRD_FFPROBE_PATH'
  const override = process.env[envName]
  if (override) {
    if (!existsSync(override)) throw new Error(`${envName} does not exist`)
    return resolve(override)
  }
  const binary = `${tool}${process.platform === 'win32' ? '.exe' : ''}`
  const target = `${process.platform}-${process.arch}`
  const bundledBin = getBundledAssetsDir(`bin/${target}`)
  if (bundledBin && existsSync(join(bundledBin, binary))) return join(bundledBin, binary)
  const resourceRoots = [
    process.env.TOKENBIRD_BUNDLED_ASSETS_ROOT,
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    join(process.cwd(), 'apps', 'electron'),
    process.cwd(),
    // Standalone compiled server installs can put runtime assets beside the binary.
    dirname(process.execPath),
  ].filter((item): item is string => !!item)
  for (const root of resourceRoots) {
    for (const candidate of [join(root, 'resources', 'bin', target, binary), join(root, 'bin', target, binary), join(root, 'app', 'resources', 'bin', target, binary)]) {
      if (existsSync(candidate)) return candidate
    }
  }
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(entry, binary)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`Bundled ${tool} is unavailable. Rebuild application resources or set ${envName}.`)
}

/** No shell, no arbitrary FFmpeg arguments, finite output buffers, and cancellation kills the child. */
export function runVideoCommand(tool: 'ffmpeg' | 'ffprobe', args: string[], options: VideoRunOptions = {}, cwd?: string): Promise<string> {
  options.signal?.throwIfAborted()
  const executable = resolveVideoExecutable(tool)
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''; let settled = false; let stopping: Error | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolveCommand(stdout)
    }
    const stop = (error: Error) => { stopping = error; child.kill('SIGKILL') }
    const abort = () => stop(new Error('Video operation cancelled', { cause: options.signal?.reason }))
    const timer = setTimeout(() => stop(new Error('Video operation timed out')), options.timeoutMs ?? 30 * 60_000)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
      if (stdout.length > 4_000_000) stop(new Error('Video command output exceeded limit'))
    })
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-12_000) })
    child.once('error', finish)
    child.once('close', code => finish(stopping ?? (code === 0 ? undefined : new Error(`${tool} failed (${code}): ${stderr.slice(-3000)}`))))
  })
}

async function readableLocalFile(path: string): Promise<string> {
  if (!path || path.includes('\0') || /^(?:https?|ftp|file|concat|pipe|lavfi|data):/i.test(path)) throw new Error('A local media file is required')
  const local = resolve(path)
  await access(local)
  if (!(await stat(local)).isFile()) throw new Error('Media input must be a file')
  return local
}

export async function probeVideo(inputPath: string, options: VideoRunOptions = {}): Promise<VideoMetadata> {
  const input = await readableLocalFile(inputPath)
  const raw = JSON.parse(await runVideoCommand('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', input], { ...options, timeoutMs: options.timeoutMs ?? 30_000 })) as { format?: { duration?: string; size?: string; format_name?: string }; streams?: Array<VideoMetadata['streams'][number] & { duration?: string }> }
  const streams = raw.streams ?? []
  const video = streams.find(item => item.codec_type === 'video')
  const duration = Number(raw.format?.duration ?? streams.find(item => Number(item.duration) > 0)?.duration ?? 0)
  return { durationSeconds: Number.isFinite(duration) ? duration : 0, width: video?.width, height: video?.height,
    hasVideo: !!video, hasAudio: streams.some(item => item.codec_type === 'audio'), format: raw.format?.format_name ?? '',
    bytes: Number(raw.format?.size ?? (await stat(input)).size), streams }
}

function numberIn(value: unknown, label: string, low: number, high: number, fallback?: number): number {
  const result = value === undefined ? fallback : value
  if (typeof result !== 'number' || !Number.isFinite(result) || result < low || result > high) throw new Error(`${label} must be between ${low} and ${high}`)
  return result
}
function dimension(value: unknown, label: string, fallback?: number): number {
  const result = numberIn(value, label, 2, 7680, fallback)
  if (!Number.isInteger(result) || result % 2) throw new Error(`${label} must be an even integer`)
  return result
}
const encoderCache = new Map<string, Promise<string>>()
async function videoEncoder(options: VideoRunOptions): Promise<string> {
  const path = resolveVideoExecutable('ffmpeg')
  let value = encoderCache.get(path)
  if (!value) {
    value = runVideoCommand('ffmpeg', ['-hide_banner', '-encoders'], { ...options, timeoutMs: 15_000 }).then(text => {
      if (/\blibx264\b/.test(text)) return 'libx264'
      if (/\blibopenh264\b/.test(text)) return 'libopenh264'
      if (process.platform === 'win32' && /\bh264_mf\b/.test(text)) return 'h264_mf'
      throw new Error('The FFmpeg runtime has no supported H.264 encoder')
    }).catch(error => { encoderCache.delete(path); throw error })
    encoderCache.set(path, value)
  }
  return value
}
async function encodingArgs(options: VideoRunOptions): Promise<string[]> {
  const encoder = await videoEncoder(options)
  return ['-c:v', encoder, ...(encoder === 'libx264' ? ['-preset', 'veryfast', '-crf', '20'] : ['-b:v', '5M']), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']
}
async function prepareOutput(inputPaths: string[], outputPath: string): Promise<{ inputs: string[]; output: string }> {
  if (!Array.isArray(inputPaths) || inputPaths.length < 1 || inputPaths.length > 120) throw new Error('Provide between 1 and 120 input files')
  const inputs = await Promise.all(inputPaths.map(readableLocalFile))
  if (!outputPath || outputPath.includes('\0') || /^(?:https?|ftp|file|pipe|data):/i.test(outputPath)) throw new Error('A local output file is required')
  const output = resolve(outputPath)
  if (inputs.some(input => process.platform === 'win32' ? input.toLowerCase() === output.toLowerCase() : input === output)) throw new Error('Output must differ from every input')
  if (existsSync(output)) throw new Error('Output already exists; choose a new file')
  await mkdir(dirname(output), { recursive: true })
  return { inputs, output }
}

export async function concatVideo(inputPaths: string[], outputPath: string, options: VideoRunOptions & { width?: number; height?: number; fps?: number } = {}): Promise<VideoProcessResult> {
  const { inputs, output } = await prepareOutput(inputPaths, outputPath)
  if (extname(output).toLowerCase() !== '.mp4') throw new Error('Concatenated video output must use .mp4')
  const metadata = await Promise.all(inputs.map(input => probeVideo(input, options)))
  if (metadata.some(item => !item.hasVideo || item.durationSeconds <= 0)) throw new Error('All clips must contain video with a known duration')
  const width = dimension(options.width, 'width', Math.max(2, Math.floor((metadata[0]!.width ?? 1280) / 2) * 2))
  const height = dimension(options.height, 'height', Math.max(2, Math.floor((metadata[0]!.height ?? 720) / 2) * 2))
  const fps = numberIn(options.fps, 'fps', 1, 120, 30)
  const temporary = await mkdtemp(join(dirname(output), '.video-concat-'))
  try {
    const segments: string[] = []
    // Normalize separately: this bounds FFmpeg input handles and fixes mixed audio/silent clips.
    for (let i = 0; i < inputs.length; i++) {
      const segment = join(temporary, `segment-${String(i).padStart(4, '0')}.mp4`)
      const args = ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-protocol_whitelist', 'file,pipe', '-i', inputs[i]!]
      if (!metadata[i]!.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
      args.push('-map', '0:v:0', '-map', metadata[i]!.hasAudio ? '0:a:0' : '1:a:0', '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`, '-af', 'aresample=48000,apad', '-ac', '2', '-ar', '48000', '-t', String(metadata[i]!.durationSeconds), ...await encodingArgs(options), segment)
      await runVideoCommand('ffmpeg', args, options)
      segments.push(segment)
    }
    const listPath = join(temporary, 'clips.txt')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(listPath, segments.map((_segment, i) => `file 'segment-${String(i).padStart(4, '0')}.mp4'`).join('\n'), 'utf8')
    await runVideoCommand('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '1', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', output], options)
    return { outputPath: output, metadata: await probeVideo(output, options) }
  } catch (error) { await rm(output, { force: true }); throw error }
  finally { await rm(temporary, { recursive: true, force: true }) }
}

export async function processVideo(input: VideoProcessInput, options: VideoRunOptions = {}): Promise<VideoProcessResult> {
  const operations: VideoOperation[] = ['trim', 'concat', 'resize', 'crop', 'rotate', 'speed', 'mute', 'volume', 'extract_audio', 'extract_frame', 'transcode', 'subtitles', 'overlay', 'music']
  if (!operations.includes(input.operation)) throw new Error('Unsupported video operation')
  if (input.operation === 'concat') return concatVideo(input.inputPaths, input.outputPath, { ...options, width: input.width, height: input.height })
  const { inputs, output } = await prepareOutput(input.inputPaths, input.outputPath)
  if (inputs.length !== 1) throw new Error('This operation requires exactly one input')
  const source = inputs[0]!
  const info = await probeVideo(source, options)
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-n', '-protocol_whitelist', 'file,pipe']
  const filters: string[] = []; const audio: string[] = []
  const start = numberIn(input.startSeconds, 'startSeconds', 0, 604800, 0)
  if (start && (input.operation === 'trim' || input.operation === 'extract_frame')) args.push('-ss', String(start))
  args.push('-i', source)
  if (input.durationSeconds !== undefined) args.push('-t', String(numberIn(input.durationSeconds, 'durationSeconds', .01, 604800)))
  if (input.operation === 'extract_audio') {
    if (!info.hasAudio) throw new Error('Input has no audio stream')
    if (!['.mp3', '.wav', '.m4a', '.aac'].includes(extname(output).toLowerCase())) throw new Error('Audio output must be .mp3, .wav, .m4a or .aac')
    args.push('-vn', ...(extname(output).toLowerCase() === '.mp3' ? ['-c:a', 'libmp3lame', '-q:a', '2'] : []), output)
  } else {
    if (!info.hasVideo) throw new Error('Input has no video stream')
    switch (input.operation) {
      case 'trim':
        if (start >= info.durationSeconds) throw new Error('Trim start is beyond the end of the video')
        if (input.durationSeconds === undefined) throw new Error('Trim requires durationSeconds')
        break
      case 'resize': filters.push(`scale=${dimension(input.width, 'width')}:${dimension(input.height, 'height')},setsar=1`); break
      case 'crop': {
        const crop = input.crop
        if (!crop) throw new Error('Crop coordinates are required')
        const x = numberIn(crop.x, 'crop.x', 0, info.width ?? 7680); const y = numberIn(crop.y, 'crop.y', 0, info.height ?? 7680)
        const w = dimension(crop.width, 'crop.width'); const h = dimension(crop.height, 'crop.height')
        if (x + w > (info.width ?? 0) || y + h > (info.height ?? 0)) throw new Error('Crop exceeds video bounds')
        filters.push(`crop=${w}:${h}:${x}:${y}`); break
      }
      case 'rotate':
        if (![90, 180, 270].includes(input.rotation ?? 0)) throw new Error('Rotation must be 90, 180 or 270')
        filters.push(input.rotation === 180 ? 'hflip,vflip' : `transpose=${input.rotation === 90 ? '1' : '2'}`); break
      case 'speed': {
        const speed = numberIn(input.speed, 'speed', .25, 4)
        filters.push(`setpts=PTS/${speed}`)
        let remaining = speed
        while (remaining > 2) { audio.push('atempo=2'); remaining /= 2 }
        while (remaining < .5) { audio.push('atempo=0.5'); remaining /= .5 }
        audio.push(`atempo=${remaining}`); break
      }
      case 'volume': audio.push(`volume=${numberIn(input.volume, 'volume', 0, 4)}`); break
      case 'overlay': {
        if (!input.watermarkPath) throw new Error('An image watermark is required')
        args.push('-i', await readableLocalFile(input.watermarkPath), '-filter_complex', '[1:v]format=rgba[mark];[0:v][mark]overlay=W-w-16:H-h-16:format=auto[v]', '-map', '[v]', '-map', '0:a?')
        break
      }
      case 'subtitles': break // Copy to a safe relative name below; never interpolate an untrusted path into filters.
      case 'music': {
        if (!input.musicPath) throw new Error('A background music file is required')
        const music = await readableLocalFile(input.musicPath)
        if (!(await probeVideo(music, options)).hasAudio) throw new Error('Background music has no audio stream')
        args.push('-stream_loop', '-1', '-i', music)
        const volume = numberIn(input.volume, 'volume', 0, 4, .3)
        args.push('-filter_complex', info.hasAudio ? `[1:a]volume=${volume}[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=0[a]` : `[1:a]volume=${volume}[a]`, '-map', '0:v:0', '-map', '[a]', '-t', String(info.durationSeconds))
        break
      }
    }
    if (input.operation === 'extract_frame') {
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extname(output).toLowerCase())) throw new Error('Frame output must be an image')
      args.push('-frames:v', '1', '-update', '1', output)
    } else {
      if (extname(output).toLowerCase() !== '.mp4') throw new Error('Video output must use .mp4')
      if (input.operation !== 'overlay') filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2')
      if (filters.length) args.push('-vf', filters.join(','))
      if (audio.length && info.hasAudio) args.push('-af', audio.join(','))
      if (input.operation === 'mute' || input.mute) args.push('-an')
      args.push(...await encodingArgs(options), output)
    }
  }
  let temporary: string | undefined
  try {
    if (input.operation === 'subtitles') {
      if (!input.subtitlesPath || !['.srt', '.ass', '.vtt'].includes(extname(input.subtitlesPath).toLowerCase())) throw new Error('Subtitles require an SRT, ASS or VTT file')
      temporary = await mkdtemp(join(dirname(output), '.video-subtitles-'))
      const safeName = `captions${extname(input.subtitlesPath).toLowerCase()}`
      await copyFile(await readableLocalFile(input.subtitlesPath), join(temporary, safeName))
      const vf = args.indexOf('-vf')
      if (vf >= 0) args[vf + 1] = `subtitles=${safeName},${args[vf + 1]}`
      else args.splice(args.length - 1, 0, '-vf', `subtitles=${safeName}`)
    }
    await runVideoCommand('ffmpeg', args, options, temporary)
    if (!(await stat(output)).size) throw new Error('FFmpeg produced an empty output')
    return { outputPath: output, metadata: await probeVideo(output, options) }
  } catch (error) { await rm(output, { force: true }); throw error }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }) }
}
