import type { VideoJob, VideoShot } from '@tokenbird/shared/video'

const labels = {
  title: ['视频制作', 'Video Studio'], projects: ['视频项目', 'Video projects'], newProject: ['新建项目', 'New project'],
  untitled: ['未命名视频', 'Untitled video'], name: ['名称', 'Name'], save: ['保存', 'Save'], saved: ['已保存', 'Saved'], unsaved: ['有未保存修改', 'Unsaved changes'],
  delete: ['删除', 'Delete'], cancel: ['取消', 'Cancel'], close: ['关闭', 'Close'], refresh: ['刷新', 'Refresh'],
  storyboard: ['脚本与分镜', 'Script & storyboard'], memories: ['人物 / 场景记忆', 'Characters & scenes'], providers: ['生成服务', 'Generation services'],
  media: ['素材与剪辑', 'Media & editing'], jobs: ['任务记录', 'Jobs'], emptyProject: ['新建项目，导入脚本，即可开始制作视频。', 'Create a project and import a script to start making a video.'],
  script: ['视频脚本', 'Video script'], importScript: ['导入脚本并分镜', 'Import script & storyboard'], scriptHint: ['粘贴文字，或导入 TXT / Markdown 脚本。Agent 会提取人物、场景与逐镜提示词。', 'Paste text or import a TXT / Markdown script. The agent extracts characters, scenes and shot prompts.'],
  preferences: ['视频偏好', 'Video preferences'], preferencesHint: ['画风、节奏、运镜、色调、需保持的人物或场景特征…', 'Style, pacing, camera movement, color and features to preserve…'],
  analyze: ['Agent 一键分镜', 'Create storyboard with agent'], makeMovie: ['一键生成完整视频', 'Make full video'], render: ['合并现有分镜成片', 'Assemble existing shots'],
  analysisAgent: ['脚本分析 Agent', 'Script analysis agent'], configureAgent: ['配置 AI 连接', 'Configure AI connection'], chooseConnection: ['选择 AI 连接', 'Choose AI connection'], model: ['模型', 'Model'],
  chooseProvider: ['选择视频生成服务', 'Choose video generation service'], aspectRatio: ['画面比例', 'Aspect ratio'], shots: ['分镜', 'Shots'], addShot: ['添加分镜', 'Add shot'],
  noShots: ['导入脚本后点击“一键分镜”，也可以手动添加。', 'Import a script and create a storyboard, or add shots manually.'], shot: ['镜头', 'Shot'], prompt: ['生成提示词', 'Generation prompt'],
  duration: ['时长（秒）', 'Duration (seconds)'], narration: ['镜头字幕', 'Shot subtitles'], generate: ['生成此镜头', 'Generate shot'], retry: ['重新生成', 'Regenerate'], up: ['上移', 'Move up'], down: ['下移', 'Move down'],
  useAsset: ['使用现有视频素材', 'Use existing video'], noAsset: ['尚未生成', 'No video yet'], preview: ['预览', 'Preview'], download: ['导出文件', 'Export file'], finalVideo: ['完整视频', 'Final video'],
  addMemory: ['新增记忆', 'Add memory'], memoryHint: ['保存参考图片与描述，生成时会自动带入启用的记忆。可在项目和分镜中指定记忆。', 'Save reference images and descriptions. Enabled memories are included in generation; projects and shots can select specific memories.'],
  person: ['人物', 'Character'], scene: ['场景', 'Scene'], style: ['风格', 'Style'], kind: ['类型', 'Type'], description: ['描述', 'Description'], referenceImages: ['参考图片', 'Reference images'],
  referenceUrl: ['公开参考图片 URL（可选）', 'Public reference image URL (optional)'], referenceHint: ['部分服务要求可公开访问的 HTTPS 图片。参考图可改善一致性，具体效果取决于服务与模型。', 'Some services require a public HTTPS image. Reference images help consistency; results depend on the service and model.'],
  uploadImages: ['添加参考图片', 'Add reference images'], enabled: ['后续生成默认使用', 'Use in future generations'], noMemories: ['还没有记忆。上传人物或场景图片，并填写要保留的特征。', 'No memories yet. Upload a character or scene image and describe the features to preserve.'],
  addProvider: ['添加生成服务', 'Add generation service'], edit: ['编辑', 'Edit'], apiKey: ['API Key', 'API key'], apiKeySaved: ['已保存密钥；留空保持当前密钥', 'Key saved; leave blank to keep it'], endpoint: ['API 地址', 'API endpoint'],
  providerHint: ['密钥由工作区服务端加密保存。视频生成会使用所选服务账户并产生该服务的费用。', 'Keys are encrypted on the workspace server. Generation uses the selected service account and its billing.'],
  noProviders: ['先添加一个视频生成服务，再生成分镜。', 'Add a video generation service before generating shots.'], keyMissing: ['未配置密钥', 'Missing API key'], keyPresent: ['已配置密钥', 'API key saved'],
  importMedia: ['导入素材', 'Import media'], mediaHint: ['导入视频、音频、图片和字幕，选择素材后执行剪辑。生成的视频也会出现在这里。', 'Import video, audio, images and subtitles. Select media to edit it. Generated videos also appear here.'],
  noMedia: ['还没有素材。', 'No media yet.'], selectMedia: ['选择视频素材：拼接按点击顺序排列，其他操作选择一个视频。', 'Select videos: joining follows selection order; other operations use one video.'], operation: ['处理操作', 'Operation'], process: ['开始处理', 'Process media'],
  trim: ['裁剪时间片段', 'Trim'], concat: ['拼接视频', 'Join videos'], resize: ['调整分辨率', 'Resize'], crop: ['裁切画面', 'Crop'], rotate: ['旋转', 'Rotate'], speed: ['调整速度', 'Change speed'],
  mute: ['去除声音', 'Mute'], volume: ['调整音量', 'Change volume'], extract_audio: ['提取音频', 'Extract audio'], extract_frame: ['提取画面', 'Extract frame'], transcode: ['转码为 MP4', 'Convert to MP4'],
  subtitles: ['烧录字幕', 'Burn subtitles'], overlay: ['右下角图片水印', 'Bottom-right image watermark'], music: ['添加背景音乐', 'Add background music'],
  start: ['开始秒数', 'Start seconds'], end: ['结束秒数', 'End seconds'], width: ['宽度', 'Width'], height: ['高度', 'Height'], x: ['横向位置', 'X position'], y: ['纵向位置', 'Y position'],
  factor: ['倍速 / 音量系数', 'Speed / volume multiplier'], degrees: ['旋转角度', 'Rotation degrees'], secondaryAsset: ['字幕 / 图片 / 音乐素材', 'Subtitle / image / music asset'],
  processingOrder: ['处理顺序', 'Processing order'], working: ['处理中…', 'Working…'], noJobs: ['还没有任务记录。', 'No jobs yet.'], running: ['正在运行', 'Running'], completed: ['已完成', 'Completed'], failed: ['失败', 'Failed'],
  cancelled: ['已取消', 'Cancelled'], interrupted: ['已中断，可重新发起', 'Interrupted; start again to retry'], queued: ['排队中', 'Queued'], analyzing: ['分析脚本', 'Analyze script'], editing: ['视频剪辑', 'Edit media'],
  generating: ['生成视频', 'Generate video'], assembling: ['合并成片', 'Assemble video'], missingWorkspace: ['请先选择工作区。', 'Select a workspace first.'], requestFailed: ['操作未完成', 'Action could not complete'],
  confirmDelete: ['确定删除此项？', 'Delete this item?'], deleteHint: ['此操作会移除保存的记录。', 'This removes the saved record.'], emptyScript: ['请先输入视频脚本。', 'Enter a video script first.'],
  needProvider: ['请选择已配置的视频生成服务。', 'Choose a configured video generation service.'], needAgent: ['请选择脚本分析的 AI 连接和模型。', 'Choose an AI connection and model for script analysis.'],
  limitFile: ['文件过大：素材上限 64 MB，记忆图片上限 20 MB，脚本上限 1 MB。', 'File too large: media limit 64 MB, memory images 20 MB, scripts 1 MB.'], invalidScript: ['仅支持 TXT / Markdown / 纯文本脚本。', 'Choose a TXT / Markdown / plain text script.'],
  select: ['选择', 'Select'], resetSelection: ['清空选择', 'Clear selection'], sourceVideo: ['视频源素材', 'Source video'], imageAttached: ['已添加图片', 'Image attached'],
  openAgent: ['打开 Agent 会话', 'Open agent session'], memorySelection: ['使用的记忆', 'Memories to use'], allEnabled: ['未指定时使用默认启用的记忆', 'Uses enabled memories when none are selected'],
  ffmpegHint: ['本地处理使用内置 FFmpeg；任务在当前工作区所在的服务端执行。', 'Local processing uses bundled FFmpeg on the server hosting this workspace.'],
  importedChooseAgent: ['脚本已导入并保存。选择上方的 AI 连接与模型，然后点击“Agent 一键分镜”。', 'Script imported and saved. Choose an AI connection and model above, then create the storyboard.'],
  resubmit: ['确认重新提交', 'Confirm new submission'], unknownSubmission: ['上次提交结果不明。请先在供应商控制台核实任务；确认后会提交新的生成任务，可能再次计费。', 'The previous submission has an unknown outcome. Check the provider console first. Confirming submits a new generation task and may incur another charge.'],
  resumeTask: ['继续查询原任务', 'Continue saved task'], regenerateHint: ['将使用当前提示词、偏好与记忆提交新的生成任务。原任务可能仍在供应商端运行，新任务会按该服务的规则计费。', 'A new generation task will use the current prompt, preferences and memories. The previous task may still be running at the provider; the new task is billed under that service’s rules.'],
} as const

export type VideoTextKey = keyof typeof labels
export function videoText(language: string) {
  const index = language.toLowerCase().startsWith('zh') ? 0 : 1
  return (key: VideoTextKey) => labels[key][index]
}

export interface VideoExportChunk { name: string; mimeType: string; bytesBase64: string; offset: number; totalBytes: number; eof: boolean }

/** Fetch bounded RPC frames so a complete movie never exceeds a WebSocket message. */
export async function fetchVideoAssetBlob(assetId: string, readChunk: (args: { assetId: string; offset: number; length: number }) => Promise<VideoExportChunk>): Promise<{ blob: Blob; name: string; mimeType: string }> {
  const chunks: BlobPart[] = []
  let offset = 0
  let metadata: VideoExportChunk | undefined
  while (true) {
    const result = await readChunk({ assetId, offset, length: 4 * 1024 * 1024 })
    if (result.offset !== offset || !Number.isSafeInteger(result.totalBytes) || result.totalBytes <= 0 || result.totalBytes > 512 * 1024 * 1024 || (metadata && (metadata.totalBytes !== result.totalBytes || metadata.name !== result.name || metadata.mimeType !== result.mimeType))) throw new Error('Invalid video download chunk')
    metadata ??= result
    const bytes = Uint8Array.from(atob(result.bytesBase64), value => value.charCodeAt(0))
    if (!bytes.length || bytes.length > 4 * 1024 * 1024 || offset + bytes.length > result.totalBytes) throw new Error('Incomplete video download')
    chunks.push(bytes); offset += bytes.length
    if (result.eof) {
      if (offset !== result.totalBytes) throw new Error('Incomplete video download')
      return { blob: new Blob(chunks, { type: result.mimeType }), name: result.name, mimeType: result.mimeType }
    }
    if (offset >= result.totalBytes) throw new Error('Invalid video download continuation')
  }
}

export function moveVideoShot(shots: VideoShot[], id: string, delta: -1 | 1): VideoShot[] {
  const from = shots.findIndex(shot => shot.id === id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= shots.length) return shots
  const result = [...shots]
  ;[result[from], result[to]] = [result[to]!, result[from]!]
  return result
}

export function isActiveVideoJob(job: VideoJob): boolean {
  return job.status === 'queued' || job.status === 'running'
}

/** Desktop browsers often leave MIME blank for MKV and subtitle files. */
export function videoFileMime(name: string, browserMime: string): string {
  const extensions: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', srt: 'application/x-subrip', vtt: 'text/vtt', ass: 'text/x-ssa' }
  return extensions[name.toLowerCase().split('.').pop() ?? ''] ?? (browserMime || 'application/octet-stream')
}

export async function videoFileBase64(file: File, limit = 64 * 1024 * 1024): Promise<string> {
  if (file.size > limit) throw new Error('VIDEO_FILE_TOO_LARGE')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })
}
