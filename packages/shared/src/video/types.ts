/** Browser-safe Video Studio contracts. Credentials and raw provider responses never leave the host. */
export type VideoProviderKind = 'runway' | 'luma' | 'seedance' | 'openai-compatible'
export interface VideoProvider {
  id: string
  name: string
  kind: VideoProviderKind
  baseUrl: string
  model: string
  hasApiKey: boolean
  createdAt: number
  updatedAt: number
}
export type VideoMemoryKind = 'person' | 'scene' | 'style'
export interface VideoMemory {
  id: string
  kind: VideoMemoryKind
  name: string
  description: string
  imageAssetIds: string[]
  /** Public HTTPS reference URL for providers which cannot accept uploaded images. */
  referenceUrl?: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}
export interface VideoAsset {
  id: string
  name: string
  mimeType: string
  bytes: number
  path: string
  createdAt: number
  durationSeconds?: number
  width?: number
  height?: number
}
export interface VideoShot {
  id: string
  title: string
  prompt: string
  durationSeconds: number
  memoryIds: string[]
  narration?: string
  assetId?: string
  providerTaskId?: string
  providerId?: string
  /** SHA-256 of the visual generation inputs; changed inputs require explicit regeneration. */
  generationInputHash?: string
  status?: 'draft' | 'generating' | 'completed' | 'failed'
  error?: string
}
export interface VideoProject {
  id: string
  name: string
  script: string
  preferences: string
  providerId?: string
  model?: string
  aspectRatio: '16:9' | '9:16' | '1:1'
  memoryIds: string[]
  shots: VideoShot[]
  outputAssetId?: string
  createdAt: number
  updatedAt: number
}
export type VideoJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export interface VideoJob {
  id: string
  kind: 'analyze' | 'edit' | 'generate_shot' | 'generate_project' | 'render_project'
  status: VideoJobStatus
  progress: number
  message: string
  projectId?: string
  shotId?: string
  outputAssetId?: string
  error?: string
  /** Actual agent session used to analyze the script, when available. */
  agentSessionId?: string
  createdAt: number
  updatedAt: number
}
export interface VideoStudioState {
  version: 1
  providers: VideoProvider[]
  memories: VideoMemory[]
  projects: VideoProject[]
  assets: VideoAsset[]
  jobs: VideoJob[]
}
export type VideoAction = 'state' | 'save_provider' | 'delete_provider' | 'save_memory' | 'delete_memory'
  | 'save_project' | 'delete_project' | 'import_asset' | 'read_asset' | 'probe' | 'edit' | 'analyze'
  | 'generate_shot' | 'generate_project' | 'render_project' | 'job' | 'cancel_job' | 'export_asset'
export interface VideoExecuteRequest { action: VideoAction; args?: Record<string, unknown> }
export interface VideoAnalysisResult {
  memories: Array<{ kind: VideoMemoryKind; name: string; description: string; existingId?: string }>
  shots: Array<Omit<VideoShot, 'id' | 'assetId' | 'status'> & { id?: string; memoryNames?: string[] }>
  agentSessionId?: string
}
export interface VideoAnalysisInput {
  workspaceId: string
  project: VideoProject
  memories: VideoMemory[]
  provider?: VideoProvider
  connectionSlug?: string
  model?: string
  onSession?: (sessionId: string) => void
}
export type VideoAnalyzer = (input: VideoAnalysisInput, signal: AbortSignal) => Promise<VideoAnalysisResult>
export const VIDEO_PROVIDER_PRESETS: Record<VideoProviderKind, { name: string; baseUrl: string; model: string }> = {
  runway: { name: 'Runway', baseUrl: 'https://api.dev.runwayml.com/v1', model: 'gen4.5' },
  luma: { name: 'Luma Dream Machine', baseUrl: 'https://api.lumalabs.ai/dream-machine/v1', model: 'ray-2' },
  seedance: { name: 'Seedance / 火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedance-2-0-260128' },
  'openai-compatible': { name: 'Compatible Videos API', baseUrl: '', model: '' },
}
