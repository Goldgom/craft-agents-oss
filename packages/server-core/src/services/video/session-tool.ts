import { readFile, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { getSessionExecutionPolicy, getSessionProgramExecutor } from '@tokenbird/shared/agent'
import { VideoToolSchema, VIDEO_PROGRAM_ACTIONS } from '@tokenbird/session-tools-core/video-tools'
import type { VideoAction, VideoAnalyzer, VideoStudioState } from '@tokenbird/shared/video'
import { getVideoService, type VideoExecutionContext } from './service'

type Executor = { execute(workspaceId: string, action: VideoAction, args?: Record<string, unknown>, hostContext?: VideoExecutionContext): Promise<unknown>; setAnalyzer?(analyzer: VideoAnalyzer): void }
const MIMES: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.srt': 'application/x-subrip', '.vtt': 'text/vtt', '.ass': 'text/x-ssa' }

/** Provider hooks authorize the exact call first; this bridge preserves structural runtime limits. */
export async function runVideoSessionTool(workspaceId: string, sessionId: string, request: Record<string, unknown>, options: { workingDirectory: string; analyzer?: VideoAnalyzer; service?: Executor }): Promise<unknown> {
  const parsed = VideoToolSchema.parse(request)
  const args = structuredClone(parsed.args ?? {})
  const policy = getSessionExecutionPolicy(sessionId)
  if (policy && parsed.action === 'analyze') throw new Error('Use the current node model to write the storyboard with save_project; a node cannot launch an additional Agent.')
  if (getSessionProgramExecutor(sessionId) && VIDEO_PROGRAM_ACTIONS.includes(parsed.action)) throw new Error('Run FFmpeg through Bash inside the selected container; the host video service cannot execute in that container.')
  const service = options.service ?? getVideoService()
  if (options.analyzer) service.setAnalyzer?.(options.analyzer)
  if (policy && parsed.action === 'generate_project') {
    if (args.analyzeFirst === true) throw new Error('A node cannot launch an additional script analysis Agent.')
    const state = await service.execute(workspaceId, 'state') as VideoStudioState
    const project = state.projects.find(project => project.id === args.projectId)
    if (!project?.shots.length) throw new Error('Create the storyboard with save_project in the current model turn before generating this project.')
  }
  if (parsed.action === 'import_asset' && args.path !== undefined) {
    if (typeof args.path !== 'string' || args.path.includes('\0')) throw new Error('Invalid video import path')
    const path = resolve(options.workingDirectory, args.path.replace(/^~(?=[\\/])/, homedir()))
    const info = await stat(path)
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('Import a file under 64 MB')
    const mimeType = MIMES[extname(path).toLowerCase()]
    if (!mimeType) throw new Error('Unsupported video, image, audio or subtitle file')
    return service.execute(workspaceId, 'import_asset', { name: basename(path), mimeType, bytesBase64: (await readFile(path)).toString('base64') })
  }
  // Models need file metadata and paths, never a multi-megabyte base64 result in context.
  if (parsed.action === 'read_asset') {
    const state = await service.execute(workspaceId, 'state') as VideoStudioState
    const asset = state.assets.find(asset => asset.id === args.assetId)
    if (!asset) throw new Error('Video asset not found')
    return asset
  }
  return service.execute(workspaceId, parsed.action, args, policy ? { allowAgentAnalysis: false } : undefined)
}
