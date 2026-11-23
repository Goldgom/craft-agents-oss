import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, BookImage, Check, Clapperboard, Download, Film, FolderPlus, ImagePlus, Layers3, LoaderCircle, PanelLeftOpen, Play, Plus, RefreshCw, Save, Scissors, Settings2, Square, Trash2, Upload, WandSparkles } from 'lucide-react'
import type { VideoAction, VideoAsset, VideoExecuteRequest, VideoJob, VideoMemory, VideoMemoryKind, VideoProject, VideoProvider, VideoProviderKind, VideoShot, VideoStudioState } from '@tokenbird/shared/video'
import { VIDEO_PROVIDER_PRESETS } from '@tokenbird/shared/video'
import { useAppShellContext } from '@/context/AppShellContext'
import { usePageSidebar } from '@/context/PageSidebarContext'
import { PageSidebar } from '@/components/app-shell/PageSidebar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { navigate, routes } from '@/lib/navigate'
import { fetchVideoAssetBlob, isActiveVideoJob, moveVideoShot, videoFileBase64, videoFileMime, videoText, type VideoTextKey } from './video-ui'

type Tab = 'storyboard' | 'memories' | 'media' | 'providers' | 'jobs'
type ProviderDraft = Omit<VideoProvider, 'id' | 'hasApiKey' | 'createdAt' | 'updatedAt'> & { id?: string; apiKey: string; hasApiKey?: boolean }
type MemoryDraft = Omit<VideoMemory, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
type VideoResponseFile = { dataUrl: string; name: string; mimeType: string }
type Execute = <T>(action: VideoAction, args?: Record<string, unknown>) => Promise<T>
const fieldClass = 'min-h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
const emptyState: VideoStudioState = { version: 1, providers: [], memories: [], projects: [], assets: [], jobs: [] }
const activeTabs: Array<{ id: Tab; Icon: typeof Film }> = [
  { id: 'storyboard', Icon: Layers3 }, { id: 'memories', Icon: BookImage }, { id: 'media', Icon: Scissors }, { id: 'providers', Icon: Settings2 }, { id: 'jobs', Icon: Film },
]

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid min-w-0 gap-1.5 text-xs font-medium text-muted-foreground">{label}{children}</label>
}

export default function StudioVideo({ active = true, onOpenAiSettings }: { active?: boolean; onOpenAiSettings?: () => void }) {
  const { i18n } = useTranslation()
  const text = videoText(i18n.language)
  const { activeWorkspaceId, llmConnections, workspaceDefaultLlmConnection } = useAppShellContext()
  const sidebar = usePageSidebar()
  const [state, setState] = useState<VideoStudioState>(emptyState)
  const [project, setProject] = useState<VideoProject | null>(null)
  const projectRef = useRef(project); projectRef.current = project
  const dirtyRef = useRef(false)
  const [dirty, setDirty] = useState(false)
  const [tab, setTab] = useState<Tab>('storyboard')
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [connectionSlug, setConnectionSlug] = useState(workspaceDefaultLlmConnection ?? '')
  const [analysisModel, setAnalysisModel] = useState('')
  const [providerDraft, setProviderDraft] = useState<ProviderDraft | null>(null)
  const [memoryDraft, setMemoryDraft] = useState<MemoryDraft | null>(null)
  const [preview, setPreview] = useState<VideoResponseFile | null>(null)
  const [deleteRequest, setDeleteRequest] = useState<{ action: VideoAction; id: string; name: string } | null>(null)
  const [resubmitShotId, setResubmitShotId] = useState('')
  const [localSidebarVisible, setLocalSidebarVisible] = useState(true)
  const [localSidebarOpen, setLocalSidebarOpen] = useState(false)
  const [selectedAssets, setSelectedAssets] = useState<string[]>([])
  const workspaceRef = useRef(activeWorkspaceId); workspaceRef.current = activeWorkspaceId
  const requestRevision = useRef(0)
  const connections = llmConnections.filter(item => item.isAuthenticated)
  const connection = connections.find(item => item.slug === connectionSlug)
  const analysisModels = connection ? [...new Set((connection.models ?? []).map(model => typeof model === 'string' ? model : model.id))] : []
  const runningJobs = state.jobs.filter(isActiveVideoJob)
  const projectBusy = !!project && runningJobs.some(job => job.projectId === project.id)

  useEffect(() => () => { if (preview?.dataUrl.startsWith('blob:')) URL.revokeObjectURL(preview.dataUrl) }, [preview])

  useEffect(() => {
    if (!connections.some(item => item.slug === connectionSlug)) setConnectionSlug(connections.find(item => item.slug === workspaceDefaultLlmConnection)?.slug ?? connections[0]?.slug ?? '')
  }, [llmConnections, workspaceDefaultLlmConnection, connectionSlug])
  useEffect(() => {
    if (!analysisModel || (analysisModels.length > 0 && !analysisModels.includes(analysisModel))) setAnalysisModel(connection?.defaultModel && analysisModels.includes(connection.defaultModel) ? connection.defaultModel : analysisModels[0] ?? '')
  }, [connectionSlug, connection, analysisModels.join('|'), analysisModel])

  const execute = useCallback<Execute>(async <T,>(action: VideoAction, args: Record<string, unknown> = {}) => {
    if (!activeWorkspaceId) throw new Error(text('missingWorkspace'))
    const result = await window.electronAPI.executeVideo({ action, args: { ...args, workspaceId: activeWorkspaceId } } satisfies VideoExecuteRequest)
    if (workspaceRef.current !== activeWorkspaceId) throw new Error('Workspace changed')
    return result as T
  }, [activeWorkspaceId, i18n.language])

  const refresh = useCallback(async () => {
    if (!activeWorkspaceId) { setLoading(false); return }
    const revision = ++requestRevision.current
    const snapshot = await execute<VideoStudioState>('state')
    if (revision !== requestRevision.current) return
    setState(snapshot)
    if (!dirtyRef.current) setProject(previous => snapshot.projects.find(item => item.id === previous?.id) ?? snapshot.projects[0] ?? null)
    setLoading(false)
  }, [execute, activeWorkspaceId])

  useEffect(() => {
    requestRevision.current += 1
    dirtyRef.current = false; setDirty(false); setProject(null); setState(emptyState); setError(''); setLoading(true)
    setSelectedAssets([]); setPreview(null); setMemoryDraft(null); setProviderDraft(null); setDeleteRequest(null); setBusy('')
    void refresh().catch(cause => { if (workspaceRef.current === activeWorkspaceId) { setError(String(cause)); setLoading(false) } })
  }, [activeWorkspaceId])
  useEffect(() => {
    if (!active && !runningJobs.length) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { await refresh() } catch (cause) { if (!stopped) setError(String(cause)) }
      if (!stopped) timer = setTimeout(poll, runningJobs.length ? 2000 : 8000)
    }
    timer = setTimeout(poll, runningJobs.length ? 2000 : 8000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [active, runningJobs.length, refresh])

  function changeProject(patch: Partial<VideoProject>) {
    dirtyRef.current = true; setDirty(true)
    setProject(value => value ? { ...value, ...patch } : value)
  }
  async function saveProject(): Promise<VideoProject> {
    const draft = projectRef.current
    if (!draft) throw new Error(text('emptyProject'))
    if (!dirtyRef.current) return draft
    const saved = await execute<VideoProject>('save_project', { ...draft })
    dirtyRef.current = false; setDirty(false); setProject(saved); projectRef.current = saved
    return saved
  }
  async function run(label: string, operation: () => Promise<void>) {
    if (busy) return
    const workspace = activeWorkspaceId
    setBusy(label); setError(''); setNotice('')
    try { await operation(); if (workspaceRef.current === workspace) await refresh() }
    catch (cause) { if (workspaceRef.current === workspace) setError(cause instanceof Error && cause.message === 'VIDEO_FILE_TOO_LARGE' ? text('limitFile') : String(cause)) }
    finally { if (workspaceRef.current === workspace) setBusy('') }
  }
  async function createProject() {
    await run('new', async () => {
      if (projectRef.current && dirtyRef.current) await saveProject()
      const next = await execute<VideoProject>('save_project', { name: text('untitled'), script: '', preferences: '', aspectRatio: '16:9', memoryIds: [], shots: [], providerId: state.providers[0]?.id })
      setProject(next); projectRef.current = next; setTab('storyboard')
    })
  }
  async function selectProject(id: string) {
    await run('select', async () => {
      if (dirtyRef.current) await saveProject()
      const next = state.projects.find(item => item.id === id)
      if (next) { setProject(next); projectRef.current = next; setTab('storyboard'); sidebar?.setOpen(false) }
    })
  }
  async function importFile(file: File): Promise<VideoAsset> {
    return execute<VideoAsset>('import_asset', { name: file.name, mimeType: videoFileMime(file.name, file.type), bytesBase64: await videoFileBase64(file) })
  }
  async function importScript(file: File) {
    await run('import_script', async () => {
      if (file.size > 1024 * 1024) throw new Error(text('limitFile'))
      const script = await file.text()
      if (!script.trim()) throw new Error(text('emptyScript'))
      const draft = projectRef.current
      if (!draft) throw new Error(text('emptyProject'))
      const saved = await execute<VideoProject>('save_project', { ...draft, script, shots: [], outputAssetId: '' })
      dirtyRef.current = false; setDirty(false); setProject(saved); projectRef.current = saved
      if (connectionSlug && analysisModel) await execute<VideoJob>('analyze', { projectId: saved.id, connectionSlug, model: analysisModel })
      else setNotice(text('importedChooseAgent'))
    })
  }
  async function showAsset(assetId: string) {
    await run('preview', async () => {
      const file = await fetchVideoAssetBlob(assetId, args => execute('export_asset', args))
      setPreview({ name: file.name, mimeType: file.mimeType, dataUrl: URL.createObjectURL(file.blob) })
    })
  }
  async function downloadAsset(assetId: string) {
    await run('download', async () => {
      const file = await fetchVideoAssetBlob(assetId, args => execute('export_asset', args))
      const url = URL.createObjectURL(file.blob)
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    })
  }
  async function projectAction(action: 'analyze' | 'generate_project' | 'generate_shot' | 'render_project', shotId?: string, regenerate = false) {
    await run(action, async () => {
      const saved = await saveProject()
      if ((action === 'analyze' || (action === 'generate_project' && !saved.shots.length)) && !saved.script.trim()) throw new Error(text('emptyScript'))
      if ((action === 'analyze' || (action === 'generate_project' && !saved.shots.length)) && (!connectionSlug || !analysisModel)) throw new Error(text('needAgent'))
      if ((action === 'generate_project' || action === 'generate_shot') && !saved.providerId) throw new Error(text('needProvider'))
      await execute<VideoJob>(action, { projectId: saved.id, shotId, connectionSlug, model: analysisModel, ...(action === 'generate_shot' && (regenerate || saved.shots.find(shot => shot.id === shotId)?.assetId) ? { regenerate: true } : {}) })
    })
  }
  const sidebarVisible = sidebar?.visible ?? localSidebarVisible
  const sidebarCompact = sidebar?.compact ?? false
  const toggleSidebar = sidebar?.toggle ?? (() => setLocalSidebarVisible(value => !value))
  const canMutate = !busy && !projectBusy

  return <div data-studio-editor="video" className="flex h-full min-w-0 bg-background text-foreground">
    <PageSidebar title={text('projects')} visible={sidebarVisible} compact={sidebarCompact} open={sidebar?.open ?? localSidebarOpen} onOpenChange={sidebar?.setOpen ?? setLocalSidebarOpen} onToggle={toggleSidebar}>
      <div className="p-3"><Button className="w-full" size="sm" onClick={createProject} disabled={!!busy}><Plus />{text('newProject')}</Button></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {state.projects.map(item => <div key={item.id} className={cn('group mb-1 flex items-center rounded-lg', project?.id === item.id && 'bg-accent')}>
          <button className="min-w-0 flex-1 truncate px-3 py-2.5 text-left text-sm hover:text-primary" onClick={() => selectProject(item.id)} disabled={!!busy}>{item.name}</button>
          <button className="mr-1 rounded p-1.5 text-muted-foreground opacity-0 hover:text-destructive focus:opacity-100 group-hover:opacity-100" aria-label={text('delete')} disabled={!!busy || runningJobs.some(job => job.projectId === item.id)} onClick={() => setDeleteRequest({ action: 'delete_project', id: item.id, name: item.name })}><Trash2 className="size-3.5" /></button>
        </div>)}
      </div>
    </PageSidebar>
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-h-14 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {(!sidebarVisible || sidebarCompact) && <Button variant="ghost" size="icon" aria-label={text('projects')} onClick={() => sidebarCompact ? (sidebar?.setOpen ?? setLocalSidebarOpen)(true) : toggleSidebar()}><PanelLeftOpen /></Button>}
          <Clapperboard className="size-5 text-primary" /><h1 className="text-sm font-semibold">{text('title')}</h1>
          <span className="hidden text-xs text-muted-foreground sm:inline">{project?.name}</span>
        </div>
        <div className="flex items-center gap-2">
          {dirty && <span className="text-xs text-muted-foreground">{text('unsaved')}</span>}
          {busy && <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label={text('working')} />}
          <Button variant="ghost" size="icon" disabled={!!busy} aria-label={text('refresh')} onClick={() => run('refresh', refresh)}><RefreshCw /></Button>
          {project && <Button variant="outline" size="sm" disabled={!!busy || !dirty || projectBusy} onClick={() => run('save', async () => { await saveProject() })}><Save />{text('save')}</Button>}
        </div>
      </header>
      <nav aria-label={text('title')} className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-2">
        {activeTabs.map(({ id, Icon }) => <button key={id} type="button" className={cn('flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-colors', tab === id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted')} aria-pressed={tab === id} onClick={() => setTab(id)}><Icon className="size-3.5" />{text(id)}{id === 'jobs' && runningJobs.length > 0 && <span className="rounded bg-primary px-1.5 text-primary-foreground">{runningJobs.length}</span>}</button>)}
      </nav>
      {error && <div role="alert" className="flex items-start justify-between gap-3 border-b border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"><span className="break-words">{error}</span><button onClick={() => setError('')} aria-label={text('close')}>×</button></div>}
      {notice && <div role="status" className="flex items-center justify-between gap-3 border-b border-primary/20 bg-primary/5 px-4 py-3 text-sm"><span>{notice}</span><Button size="sm" variant="outline" onClick={onOpenAiSettings}>{text('configureAgent')}</Button></div>}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
        {loading ? <div role="status" className="flex h-40 items-center justify-center"><LoaderCircle className="size-5 animate-spin" /></div> : <div className="mx-auto grid max-w-6xl gap-5">
          {tab === 'storyboard' && (!project ? <div className="grid min-h-64 place-content-center justify-items-center gap-4 rounded-xl border border-dashed border-border p-8 text-center"><Clapperboard className="size-10 text-muted-foreground" /><p className="max-w-sm text-sm text-muted-foreground">{text('emptyProject')}</p><Button onClick={createProject}><FolderPlus />{text('newProject')}</Button></div> : <>
            <div className="grid gap-4 rounded-xl border border-border bg-muted/10 p-4 md:grid-cols-2">
              <Field label={text('name')}><Input value={project.name} disabled={!canMutate} onChange={event => changeProject({ name: event.target.value })} /></Field>
              <div className="grid grid-cols-[1fr_110px] gap-3">
                <Field label={text('chooseProvider')}><select className={fieldClass} value={project.providerId ?? ''} disabled={!canMutate} onChange={event => changeProject({ providerId: event.target.value, model: '' })}><option value="">{text('chooseProvider')}</option>{state.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}{provider.hasApiKey ? '' : ` · ${text('keyMissing')}`}</option>)}</select></Field>
                <Field label={text('aspectRatio')}><select className={fieldClass} value={project.aspectRatio} disabled={!canMutate} onChange={event => changeProject({ aspectRatio: event.target.value as VideoProject['aspectRatio'] })}>{['16:9', '9:16', '1:1'].map(value => <option key={value}>{value}</option>)}</select></Field>
              </div>
              <Field label={text('preferences')}><textarea className={fieldClass} rows={3} value={project.preferences} placeholder={text('preferencesHint')} disabled={!canMutate} onChange={event => changeProject({ preferences: event.target.value })} /></Field>
              <div className="grid gap-2"><Field label={text('analysisAgent')}><select className={fieldClass} value={connectionSlug} disabled={!!busy} onChange={event => { setConnectionSlug(event.target.value); setAnalysisModel('') }}><option value="">{text('chooseConnection')}</option>{connections.map(item => <option key={item.slug} value={item.slug}>{item.name}</option>)}</select></Field><div className="flex gap-2"><Input className="flex-1" list="video-analysis-models" value={analysisModel} aria-label={text('model')} placeholder={text('model')} onChange={event => setAnalysisModel(event.target.value)} /><datalist id="video-analysis-models">{analysisModels.map(model => <option key={model} value={model} />)}</datalist>{!connections.length && <Button variant="outline" size="sm" onClick={onOpenAiSettings}>{text('configureAgent')}</Button>}</div></div>
              <div className="md:col-span-2"><MemoryChoices memories={state.memories} ids={project.memoryIds} text={text} disabled={!canMutate} onChange={memoryIds => changeProject({ memoryIds })} /></div>
            </div>
            <div className="grid gap-3 rounded-xl border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">{text('script')}</h2><label className={cn('inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs', !canMutate && 'pointer-events-none opacity-50')}><Upload className="size-3.5" />{text('importScript')}<input className="sr-only" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" disabled={!canMutate} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importScript(file) }} /></label></div>
              <textarea className={cn(fieldClass, 'min-h-36')} value={project.script} disabled={!canMutate} onChange={event => changeProject({ script: event.target.value })} placeholder={text('scriptHint')} />
              <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => projectAction('analyze')} disabled={!canMutate || !project.script.trim()}><WandSparkles />{text('analyze')}</Button><Button onClick={() => projectAction('generate_project')} disabled={!canMutate || (!project.script.trim() && !project.shots.length)}><Play />{text('makeMovie')}</Button><Button variant="outline" onClick={() => projectAction('render_project')} disabled={!canMutate || !project.shots.length || project.shots.some(shot => !shot.assetId)}><Film />{text('render')}</Button></div>
              {projectBusy && <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />{runningJobs.find(job => job.projectId === project.id)?.message}</div>}
            </div>
            {project.outputAssetId && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4"><div className="flex items-center gap-2 text-sm font-semibold"><Check className="size-4 text-primary" />{text('finalVideo')}</div><AssetActions assetId={project.outputAssetId} text={text} busy={!!busy} onPreview={showAsset} onDownload={downloadAsset} /></div>}
            <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{text('shots')} <span className="text-muted-foreground">{project.shots.length}</span></h2><Button variant="outline" size="sm" disabled={!canMutate} onClick={() => changeProject({ shots: [...project.shots, { id: crypto.randomUUID(), title: `${text('shot')} ${project.shots.length + 1}`, prompt: '', durationSeconds: 5, memoryIds: [], status: 'draft' }] })}><Plus />{text('addShot')}</Button></div>
            {!project.shots.length && <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{text('noShots')}</p>}
            {project.shots.map((shot, index) => <section key={shot.id} className="grid gap-3 rounded-xl border border-border p-4">
              <div className="flex items-center gap-2"><span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold">{index + 1}</span><Input className="flex-1 border-transparent shadow-none" value={shot.title} aria-label={text('name')} disabled={!canMutate} onChange={event => changeProject({ shots: project.shots.map(item => item.id === shot.id ? { ...item, title: event.target.value } : item) })} /><Button size="icon" variant="ghost" aria-label={text('up')} disabled={!canMutate || index === 0} onClick={() => changeProject({ shots: moveVideoShot(project.shots, shot.id, -1) })}><ArrowUp /></Button><Button size="icon" variant="ghost" aria-label={text('down')} disabled={!canMutate || index === project.shots.length - 1} onClick={() => changeProject({ shots: moveVideoShot(project.shots, shot.id, 1) })}><ArrowDown /></Button><Button size="icon" variant="ghost" aria-label={text('delete')} disabled={!canMutate} onClick={() => changeProject({ shots: project.shots.filter(item => item.id !== shot.id) })}><Trash2 /></Button></div>
              <ShotEditor shot={shot} memories={state.memories} assets={state.assets} text={text} disabled={!canMutate} onChange={patch => changeProject({ shots: project.shots.map(item => item.id === shot.id ? { ...item, ...patch } : item) })} />
              {shot.error && <p className="text-xs text-destructive">{shot.error}</p>}
              <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!canMutate || !shot.prompt.trim()} onClick={() => shot.error?.startsWith('提交结果不明') ? setResubmitShotId(shot.id) : projectAction('generate_shot', shot.id)}><WandSparkles />{text(shot.assetId ? 'retry' : shot.providerTaskId && shot.status !== 'failed' ? 'resumeTask' : 'generate')}</Button>{shot.providerTaskId && !shot.assetId && <Button size="sm" variant="outline" disabled={!canMutate || !shot.prompt.trim()} onClick={() => setResubmitShotId(shot.id)}><RefreshCw />{text('retry')}</Button>}</div>{shot.assetId ? <AssetActions assetId={shot.assetId} text={text} busy={!!busy} onPreview={showAsset} onDownload={downloadAsset} /> : <span className="text-xs text-muted-foreground">{shot.status === 'generating' ? text('generating') : text('noAsset')}</span>}</div>
            </section>)}
          </>)}
          {tab === 'providers' && <>
            <SectionHeader title={text('providers')} description={text('providerHint')} action={<Button size="sm" onClick={() => setProviderDraft({ ...VIDEO_PROVIDER_PRESETS.runway, kind: 'runway', apiKey: '' })}><Plus />{text('addProvider')}</Button>} />
            {!state.providers.length && <Empty>{text('noProviders')}</Empty>}
            {state.providers.map(provider => <section key={provider.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4"><div className="min-w-0"><h3 className="font-medium">{provider.name}</h3><p className="mt-1 break-all text-xs text-muted-foreground">{provider.kind} · {provider.model}</p><p className="mt-1 text-xs text-muted-foreground">{text(provider.hasApiKey ? 'keyPresent' : 'keyMissing')}</p></div><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setProviderDraft({ ...provider, apiKey: '' })}>{text('edit')}</Button><Button variant="ghost" size="icon" disabled={!!busy} aria-label={text('delete')} onClick={() => setDeleteRequest({ action: 'delete_provider', id: provider.id, name: provider.name })}><Trash2 /></Button></div></section>)}
          </>}
          {tab === 'memories' && <>
            <SectionHeader title={text('memories')} description={text('memoryHint')} action={<Button size="sm" onClick={() => setMemoryDraft({ kind: 'person', name: '', description: '', imageAssetIds: [], enabled: true })}><Plus />{text('addMemory')}</Button>} />
            {!state.memories.length && <Empty>{text('noMemories')}</Empty>}
            <div className="grid gap-4 md:grid-cols-2">{state.memories.map(memory => <section key={memory.id} className="grid gap-3 rounded-xl border border-border p-4"><div className="flex items-start justify-between gap-3"><div><span className="mb-1 inline-block rounded bg-muted px-2 py-0.5 text-[10px]">{text(memory.kind)}</span><h3 className="font-medium">{memory.name}</h3></div><div className="flex gap-1"><Button variant="ghost" size="sm" onClick={() => setMemoryDraft({ ...memory })}>{text('edit')}</Button><Button variant="ghost" size="icon" disabled={!!busy} aria-label={text('delete')} onClick={() => setDeleteRequest({ action: 'delete_memory', id: memory.id, name: memory.name })}><Trash2 /></Button></div></div><p className="whitespace-pre-wrap text-sm text-muted-foreground">{memory.description}</p><div className="flex flex-wrap gap-2">{memory.imageAssetIds.map(assetId => <AssetThumbnail key={assetId} assetId={assetId} execute={execute} label={memory.name} onPreview={() => showAsset(assetId)} />)}</div>{memory.enabled && <span className="flex items-center gap-1 text-xs text-primary"><Check className="size-3" />{text('enabled')}</span>}</section>)}</div>
          </>}
          {tab === 'media' && <>
            <SectionHeader title={text('media')} description={text('mediaHint')} action={<label className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-foreground px-3 py-2 text-xs font-medium text-background"><Upload className="size-3.5" />{text('importMedia')}<input className="sr-only" type="file" multiple accept="video/*,audio/*,image/*,.srt,.vtt,.ass" disabled={!!busy} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void run('import_media', async () => { for (const file of files) await importFile(file) }) }} /></label>} />
            <p className="text-xs text-muted-foreground">{text('ffmpegHint')}</p>
            <MediaEditor assets={state.assets} selectedAssets={selectedAssets} setSelectedAssets={setSelectedAssets} text={text} busy={!!busy} onRun={args => run('edit', async () => { await execute('edit', args) })} onPreview={showAsset} onDownload={downloadAsset} />
          </>}
          {tab === 'jobs' && <><SectionHeader title={text('jobs')} />{!state.jobs.length && <Empty>{text('noJobs')}</Empty>}{[...state.jobs].reverse().map(job => <section key={job.id} className="grid gap-3 rounded-xl border border-border p-4"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2 text-sm font-medium">{isActiveVideoJob(job) && <LoaderCircle className="size-4 animate-spin" />}{text(job.kind === 'analyze' ? 'analyzing' : job.kind === 'edit' ? 'editing' : job.kind === 'render_project' ? 'assembling' : 'generating')}<span className={cn('rounded px-2 py-0.5 text-[10px]', job.status === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground')}>{text(job.status)}</span></div>{isActiveVideoJob(job) && <Button variant="outline" size="sm" disabled={!!busy} onClick={() => run('cancel', async () => { await execute('cancel_job', { jobId: job.id }) })}><Square />{text('cancel')}</Button>}</div><p className="break-words text-xs text-muted-foreground">{job.message}</p>{job.error && <p className="break-words text-xs text-destructive">{job.error}</p>}<progress className="h-1.5 w-full accent-primary" value={job.progress} max={100} aria-label={job.message} /><div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><time>{new Date(job.createdAt).toLocaleString(i18n.language)}</time><div className="flex gap-2">{job.agentSessionId && <Button size="sm" variant="ghost" onClick={() => { window.dispatchEvent(new CustomEvent('tokenbird:studio-mode', { detail: 'agent' })); navigate(routes.view.allSessions(job.agentSessionId)) }}>{text('openAgent')}</Button>}{job.outputAssetId && <AssetActions assetId={job.outputAssetId} text={text} busy={!!busy} onPreview={showAsset} onDownload={downloadAsset} />}</div></div></section>)}</>}
        </div>}
      </div>
    </main>
    <Dialog open={!!providerDraft} onOpenChange={open => { if (!open && !busy) setProviderDraft(null) }}><DialogContent><DialogHeader><DialogTitle>{text('addProvider')}</DialogTitle><DialogDescription>{text('providerHint')}</DialogDescription></DialogHeader>{providerDraft && <div className="grid gap-4"><Field label={text('kind')}><select className={fieldClass} value={providerDraft.kind} onChange={event => { const kind = event.target.value as VideoProviderKind; setProviderDraft({ ...providerDraft, ...VIDEO_PROVIDER_PRESETS[kind], kind }) }}>{Object.entries(VIDEO_PROVIDER_PRESETS).map(([kind, preset]) => <option key={kind} value={kind}>{preset.name}</option>)}</select></Field><Field label={text('name')}><Input value={providerDraft.name} onChange={event => setProviderDraft({ ...providerDraft, name: event.target.value })} /></Field><Field label={text('endpoint')}><Input value={providerDraft.baseUrl} onChange={event => setProviderDraft({ ...providerDraft, baseUrl: event.target.value })} placeholder="https://" /></Field><Field label={text('model')}><Input value={providerDraft.model} onChange={event => setProviderDraft({ ...providerDraft, model: event.target.value })} /></Field><Field label={text('apiKey')}><Input type="password" autoComplete="new-password" value={providerDraft.apiKey} placeholder={providerDraft.hasApiKey ? text('apiKeySaved') : ''} onChange={event => setProviderDraft({ ...providerDraft, apiKey: event.target.value })} /></Field><DialogFooter><Button variant="outline" disabled={!!busy} onClick={() => setProviderDraft(null)}>{text('cancel')}</Button><Button disabled={!!busy || !providerDraft.name.trim() || !providerDraft.baseUrl.trim() || !providerDraft.model.trim() || (!providerDraft.hasApiKey && !providerDraft.apiKey.trim())} onClick={() => run('save_provider', async () => { await execute('save_provider', { ...providerDraft }); setProviderDraft(null) })}>{text('save')}</Button></DialogFooter></div>}</DialogContent></Dialog>
    <Dialog open={!!memoryDraft} onOpenChange={open => { if (!open && !busy) setMemoryDraft(null) }}><DialogContent className="max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>{text('addMemory')}</DialogTitle><DialogDescription>{text('referenceHint')}</DialogDescription></DialogHeader>{memoryDraft && <div className="grid gap-4"><div className="grid grid-cols-[110px_1fr] gap-3"><Field label={text('kind')}><select className={fieldClass} value={memoryDraft.kind} onChange={event => setMemoryDraft({ ...memoryDraft, kind: event.target.value as VideoMemoryKind })}>{(['person', 'scene', 'style'] as const).map(kind => <option key={kind} value={kind}>{text(kind)}</option>)}</select></Field><Field label={text('name')}><Input value={memoryDraft.name} onChange={event => setMemoryDraft({ ...memoryDraft, name: event.target.value })} /></Field></div><Field label={text('description')}><textarea rows={4} className={fieldClass} value={memoryDraft.description} onChange={event => setMemoryDraft({ ...memoryDraft, description: event.target.value })} /></Field><Field label={text('referenceUrl')}><Input type="url" value={memoryDraft.referenceUrl ?? ''} onChange={event => setMemoryDraft({ ...memoryDraft, referenceUrl: event.target.value })} /></Field><div className="flex flex-wrap items-center gap-2">{memoryDraft.imageAssetIds.map(id => <div key={id} className="relative"><AssetThumbnail assetId={id} execute={execute} label={memoryDraft.name} onPreview={() => showAsset(id)} /><button className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-background text-destructive ring-1 ring-border" aria-label={text('delete')} onClick={() => setMemoryDraft({ ...memoryDraft, imageAssetIds: memoryDraft.imageAssetIds.filter(item => item !== id) })}>×</button></div>)}<label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-xs"><ImagePlus className="size-4" />{text('uploadImages')}<input type="file" accept="image/png,image/jpeg,image/webp" multiple className="sr-only" disabled={!!busy} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void run('import_image', async () => { const ids: string[] = []; for (const file of files) { if (file.size > 20 * 1024 * 1024) throw new Error(text('limitFile')); ids.push((await importFile(file)).id) } setMemoryDraft(current => current ? { ...current, imageAssetIds: [...current.imageAssetIds, ...ids] } : current) }) }} /></label></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={memoryDraft.enabled} onChange={event => setMemoryDraft({ ...memoryDraft, enabled: event.target.checked })} />{text('enabled')}</label><DialogFooter><Button variant="outline" disabled={!!busy} onClick={() => setMemoryDraft(null)}>{text('cancel')}</Button><Button disabled={!!busy || !memoryDraft.name.trim() || !memoryDraft.description.trim()} onClick={() => run('save_memory', async () => { await execute('save_memory', { ...memoryDraft }); setMemoryDraft(null) })}>{text('save')}</Button></DialogFooter></div>}</DialogContent></Dialog>
    <Dialog open={!!preview} onOpenChange={open => { if (!open) setPreview(null) }}><DialogContent className="sm:max-w-3xl"><DialogHeader><DialogTitle>{preview?.name}</DialogTitle></DialogHeader>{preview && (preview.mimeType.startsWith('image/') ? <img src={preview.dataUrl} alt={preview.name} className="max-h-[65vh] w-full object-contain" /> : preview.mimeType.startsWith('audio/') ? <audio className="w-full" src={preview.dataUrl} controls /> : <video src={preview.dataUrl} controls className="max-h-[65vh] w-full rounded-md bg-black" />)}</DialogContent></Dialog>
    <Dialog open={!!deleteRequest} onOpenChange={open => { if (!open && !busy) setDeleteRequest(null) }}><DialogContent><DialogHeader><DialogTitle>{text('confirmDelete')}</DialogTitle><DialogDescription>{deleteRequest?.name} · {text('deleteHint')}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={!!busy} onClick={() => setDeleteRequest(null)}>{text('cancel')}</Button><Button variant="destructive" disabled={!!busy} onClick={() => { if (deleteRequest) void run('delete', async () => { await execute(deleteRequest.action, { id: deleteRequest.id }); if (deleteRequest.id === project?.id) { dirtyRef.current = false; setDirty(false); setProject(null) } setDeleteRequest(null) }) }}>{text('delete')}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!resubmitShotId} onOpenChange={open => { if (!open) setResubmitShotId('') }}><DialogContent><DialogHeader><DialogTitle>{text('resubmit')}</DialogTitle><DialogDescription>{text(project?.shots.find(shot => shot.id === resubmitShotId)?.error?.startsWith('提交结果不明') ? 'unknownSubmission' : 'regenerateHint')}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setResubmitShotId('')}>{text('cancel')}</Button><Button onClick={() => { const shotId = resubmitShotId; setResubmitShotId(''); void projectAction('generate_shot', shotId, true) }}>{text('resubmit')}</Button></DialogFooter></DialogContent></Dialog>
  </div>
}

function SectionHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="flex flex-wrap items-start justify-between gap-3"><div className="max-w-2xl"><h2 className="text-base font-semibold">{title}</h2>{description && <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</p>}</div>{action}</div>
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{children}</p>
}
function MemoryChoices({ memories, ids, onChange, text, disabled }: { memories: VideoMemory[]; ids: string[]; onChange: (ids: string[]) => void; text: ReturnType<typeof videoText>; disabled: boolean }) {
  if (!memories.length) return null
  return <fieldset className="grid gap-2"><legend className="mb-2 text-xs font-medium text-muted-foreground">{text('memorySelection')}</legend><div className="flex flex-wrap gap-2">{memories.map(memory => <label key={memory.id} className={cn('flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs', ids.includes(memory.id) ? 'border-primary/40 bg-primary/5' : 'border-border')}><input type="checkbox" checked={ids.includes(memory.id)} disabled={disabled} onChange={event => onChange(event.target.checked ? [...ids, memory.id] : ids.filter(id => id !== memory.id))} />{memory.name}</label>)}</div><small className="text-[10px] text-muted-foreground">{text('allEnabled')}</small></fieldset>
}
function ShotEditor({ shot, memories, assets, onChange, text, disabled }: { shot: VideoShot; memories: VideoMemory[]; assets: VideoAsset[]; onChange: (patch: Partial<VideoShot>) => void; text: ReturnType<typeof videoText>; disabled: boolean }) {
  return <><Field label={text('prompt')}><textarea rows={3} className={fieldClass} value={shot.prompt} disabled={disabled} onChange={event => onChange({ prompt: event.target.value })} /></Field><div className="grid gap-3 md:grid-cols-[130px_1fr_1fr]"><Field label={text('duration')}><Input type="number" min={1} max={30} step={1} value={shot.durationSeconds} disabled={disabled} onChange={event => onChange({ durationSeconds: Number(event.target.value) || 1 })} /></Field><Field label={text('narration')}><Input value={shot.narration ?? ''} disabled={disabled} onChange={event => onChange({ narration: event.target.value })} /></Field><Field label={text('useAsset')}><select className={fieldClass} value={shot.assetId ?? ''} disabled={disabled} onChange={event => onChange({ assetId: event.target.value, status: event.target.value ? 'completed' : 'draft' })}><option value="">{text('noAsset')}</option>{assets.filter(asset => asset.mimeType.startsWith('video/')).map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></Field></div><MemoryChoices memories={memories} ids={shot.memoryIds} onChange={memoryIds => onChange({ memoryIds })} text={text} disabled={disabled} /></>
}
function AssetActions({ assetId, text, onPreview, onDownload, busy }: { assetId: string; text: ReturnType<typeof videoText>; onPreview: (id: string) => void; onDownload: (id: string) => void; busy: boolean }) {
  return <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={busy} onClick={() => onPreview(assetId)}><Play />{text('preview')}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => onDownload(assetId)}><Download />{text('download')}</Button></div>
}
function AssetThumbnail({ assetId, execute, label, onPreview }: { assetId: string; execute: Execute; label: string; onPreview: () => void }) {
  const [src, setSrc] = useState('')
  useEffect(() => { let alive = true; void execute<VideoResponseFile>('read_asset', { assetId }).then(file => { if (alive) setSrc(file.dataUrl) }).catch(() => {}); return () => { alive = false } }, [assetId, execute])
  return <button className="flex size-16 items-center justify-center overflow-hidden rounded-md border border-border bg-muted" onClick={onPreview} aria-label={label}>{src ? <img src={src} alt={label} className="size-full object-cover" /> : <BookImage className="size-5 text-muted-foreground" />}</button>
}

function MediaEditor({ assets, selectedAssets, setSelectedAssets, text, busy, onRun, onPreview, onDownload }: { assets: VideoAsset[]; selectedAssets: string[]; setSelectedAssets: (ids: string[]) => void; text: ReturnType<typeof videoText>; busy: boolean; onRun: (args: Record<string, unknown>) => void; onPreview: (id: string) => void; onDownload: (id: string) => void }) {
  const [operation, setOperation] = useState('trim')
  const [start, setStart] = useState('0')
  const [end, setEnd] = useState('5')
  const [width, setWidth] = useState('1280')
  const [height, setHeight] = useState('720')
  const [x, setX] = useState('0')
  const [y, setY] = useState('0')
  const [factor, setFactor] = useState('1')
  const [degrees, setDegrees] = useState('90')
  const [secondaryAsset, setSecondaryAsset] = useState('')
  const operations: VideoTextKey[] = ['trim', 'concat', 'resize', 'crop', 'rotate', 'speed', 'mute', 'volume', 'extract_audio', 'extract_frame', 'transcode', 'subtitles', 'overlay', 'music']
  function editArgs(): Record<string, unknown> {
    return {
      operation, inputAssetIds: selectedAssets,
      format: operation === 'extract_audio' ? 'mp3' : operation === 'extract_frame' ? 'png' : 'mp4',
      ...(['trim', 'extract_frame'].includes(operation) ? { startSeconds: Number(start) } : {}),
      ...(operation === 'trim' ? { durationSeconds: Number(end) - Number(start) } : {}),
      ...(operation === 'resize' ? { width: Number(width), height: Number(height) } : {}),
      ...(operation === 'crop' ? { crop: { x: Number(x), y: Number(y), width: Number(width), height: Number(height) } } : {}),
      ...(operation === 'rotate' ? { rotation: Number(degrees) } : {}),
      ...(operation === 'speed' ? { speed: Number(factor) } : {}),
      ...(['volume', 'music'].includes(operation) ? { volume: Number(factor) } : {}),
      ...(operation === 'subtitles' ? { subtitlesAssetId: secondaryAsset } : {}),
      ...(operation === 'overlay' ? { watermarkAssetId: secondaryAsset } : {}),
      ...(operation === 'music' ? { musicAssetId: secondaryAsset } : {}),
    }
  }
  const validInput = operation === 'concat' ? selectedAssets.length > 1 : selectedAssets.length === 1
  const validTime = operation !== 'trim' || (Number.isFinite(Number(start)) && Number(start) >= 0 && Number(end) > Number(start))
  const numeric = (label: VideoTextKey, value: string, set: (value: string) => void) => <Field label={text(label)}><Input type="number" value={value} onChange={event => set(event.target.value)} /></Field>
  return <>
    <div className="grid gap-4 rounded-xl border border-border p-4"><Field label={text('operation')}><select className={fieldClass} value={operation} onChange={event => setOperation(event.target.value)}>{operations.map(value => <option key={value} value={value}>{text(value)}</option>)}</select></Field>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{['trim', 'extract_frame'].includes(operation) && numeric('start', start, setStart)}{operation === 'trim' && numeric('end', end, setEnd)}{['resize', 'crop'].includes(operation) && <>{numeric('width', width, setWidth)}{numeric('height', height, setHeight)}</>}{operation === 'crop' && <>{numeric('x', x, setX)}{numeric('y', y, setY)}</>}{['speed', 'volume', 'music'].includes(operation) && numeric('factor', factor, setFactor)}{operation === 'rotate' && <Field label={text('degrees')}><select className={fieldClass} value={degrees} onChange={event => setDegrees(event.target.value)}>{['90', '180', '270'].map(value => <option key={value}>{value}</option>)}</select></Field>}</div>
      {['subtitles', 'overlay', 'music'].includes(operation) && <Field label={text('secondaryAsset')}><select className={fieldClass} value={secondaryAsset} onChange={event => setSecondaryAsset(event.target.value)}><option value="">{text('select')}</option>{assets.filter(asset => operation === 'subtitles' ? /\.(srt|ass|vtt)$/i.test(asset.name) : operation === 'overlay' ? asset.mimeType.startsWith('image/') : asset.mimeType.startsWith('audio/')).map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></Field>}
      <p className="text-xs text-muted-foreground">{text('selectMedia')}{selectedAssets.length > 0 && ` · ${selectedAssets.map(id => assets.find(asset => asset.id === id)?.name).join(' → ')}`}</p>
      <div className="flex flex-wrap gap-2"><Button disabled={busy || !validInput || !validTime || (['subtitles', 'overlay', 'music'].includes(operation) && !secondaryAsset)} onClick={() => onRun(editArgs())}><Scissors />{text('process')}</Button><Button variant="ghost" disabled={!selectedAssets.length} onClick={() => setSelectedAssets([])}>{text('resetSelection')}</Button></div>
    </div>
    {!assets.length && <Empty>{text('noMedia')}</Empty>}
    <div className="grid gap-3">{[...assets].reverse().map(asset => <section key={asset.id} className={cn('flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3', selectedAssets.includes(asset.id) ? 'border-primary/40 bg-primary/5' : 'border-border')}><label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"><input type="checkbox" disabled={!asset.mimeType.startsWith('video/')} checked={selectedAssets.includes(asset.id)} onChange={event => setSelectedAssets(event.target.checked ? [...selectedAssets, asset.id] : selectedAssets.filter(id => id !== asset.id))} /><div className="min-w-0"><p className="truncate text-sm font-medium">{asset.name}</p><small className="text-muted-foreground">{asset.mimeType} · {(asset.bytes / 1024 / 1024).toFixed(1)} MB{asset.durationSeconds ? ` · ${asset.durationSeconds.toFixed(1)}s` : ''}{selectedAssets.includes(asset.id) ? ` · #${selectedAssets.indexOf(asset.id) + 1}` : ''}</small></div></label><AssetActions assetId={asset.id} text={text} busy={busy} onPreview={onPreview} onDownload={onDownload} /></section>)}</div>
  </>
}
