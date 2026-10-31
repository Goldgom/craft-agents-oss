import { WorkbenchSelect } from '@/components/ui/workbench-select'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity, ArrowLeft, BookOpen, Bot, BrainCircuit, Check, ChevronDown, ClipboardList, Code2,
  FolderOpen, Layers3, LoaderCircle, MessagesSquare, Plus, RefreshCw,
  Settings2, ShieldCheck, Square, Wrench, Archive, PanelLeftOpen, Database, KeyRound, Zap,
} from 'lucide-react'
import type { SuperAgentCommand, SuperAgentConfig, SuperAgentSnapshot } from '@tokenbird/shared/super-agent'
import { activeSuperAgentNodes, superAgentTaskBlocker } from '@tokenbird/shared/super-agent'
import { superAgentTaskNeedsUserAction } from './super-agent-blockers'
import type { LoadedSource } from '../../../shared/types'
import { useAppShellContext } from '@/context/AppShellContext'
import { useContainerWidth } from '@/hooks/useContainerWidth'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { PageSidebar } from '@/components/app-shell/PageSidebar'
import { usePageSidebar } from '@/context/PageSidebarContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Markdown } from '@/components/markdown'
import { cn } from '@/lib/utils'
import { AgentAvatar, FormField, textareaClass } from './SuperAgentForms'
import { SuperAgentRebuildSettings } from './SuperAgentRebuildSettings'
import { SuperAgentScopedResources, SuperAgentReports, SuperAgentRequirements } from './SuperAgentRebuildData'
import { SuperAgentStatus } from './SuperAgentStatus'
import { NativeCredentialManager } from '@/components/settings/NativeCredentialManager'
import { SuperAgentSharedSkills } from './SuperAgentSharedSkills'
import { SuperAgentScripts } from './SuperAgentResources'
import { SuperAgentLibrary } from './SuperAgentLibrary'
import { NodeCommunication, SharedBoard } from './SuperAgentCollaboration'
import { SuperAgentPlans } from './SuperAgentPlans'
import { SuperAgentHistory } from './SuperAgentHistory'
import { SuperAgentSessionDialog } from './SuperAgentSessionDialog'
import { SuperAgentPermissions } from './SuperAgentPermissions'
import { SuperAgentNodeRecovery } from './SuperAgentNodeRecovery'
import { SuperAgentConversation, SuperAgentPermissionHistory } from './SuperAgentConversation'
import { SuperAgentFileContext } from './SuperAgentFileContext'
import { SuperAgentStatistics } from './SuperAgentStatistics'
import { THINKING_LEVEL_IDS, type ThinkingLevel } from '@tokenbird/shared/agent/thinking-levels'
import { resolveAgentRuntime } from '@tokenbird/shared/config/llm-connections'
import { agentRuntimeLabel } from '../settings/BackendFrameworkSettings'
import { formatTimestamp, useSuperAgentText, withExecuteMode } from './super-agent-ui'
import { recentActivityEntries, taskActivity, tasklessWorkerActivities, visibleActivityText, type SuperAgentActivity } from './super-agent-activity'

export interface SuperAgentPageProps {
  active?: boolean
  onOpenAiSettings?: () => void
}

type SettingsSection = 'settings' | 'team' | 'plans' | 'board' | 'communication' | 'resources' | 'scripts' | 'history' | 'permissionManagement' | 'statistics' | 'archiveLibrary' | 'memoryLibrary' | 'reports' | 'sources' | 'credentials' | 'automations' | 'import' | 'skills'
const settingsSections: Array<{ id: SettingsSection; icon: typeof Bot }> = [
  { id: 'settings', icon: Settings2 }, { id: 'team', icon: Layers3 },
  { id: 'plans', icon: ClipboardList },
  { id: 'permissionManagement', icon: ShieldCheck },
  { id: 'board', icon: ClipboardList }, { id: 'communication', icon: MessagesSquare },
  { id: 'reports', icon: MessagesSquare }, { id: 'skills', icon: BookOpen }, { id: 'sources', icon: Database }, { id: 'credentials', icon: KeyRound }, { id: 'automations', icon: Zap }, { id: 'import', icon: FolderOpen }, { id: 'scripts', icon: Code2 },
  { id: 'archiveLibrary', icon: Archive }, { id: 'memoryLibrary', icon: BrainCircuit },
  { id: 'history', icon: Archive },
  { id: 'statistics', icon: Activity },
]

export default function SuperAgentPage({ active = true, onOpenAiSettings }: SuperAgentPageProps) {
  const text = useSuperAgentText()
  const { t, i18n } = useTranslation()
  const pageSidebar = usePageSidebar()
  const [localSidebarVisible, setLocalSidebarVisible] = useState(true)
  const [localSidebarOpen, setLocalSidebarOpen] = useState(false)
  const {
    activeWorkspaceId, llmConnections, workspaceDefaultLlmConnection,
    pendingPermissions, leadingAction, rightSidebarButton,
  } = useAppShellContext()
  const [snapshot, setSnapshot] = useState<SuperAgentSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'home' | 'settings'>('home')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('settings')
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>()
  const [sources, setSources] = useState<LoadedSource[]>([])
  const [taskDialogNode, setTaskDialogNode] = useState<string | null>(null)
  const [sessionDetails, setSessionDetails] = useState<{ workspaceId: string; sessionId: string } | null>(null)
  const openSessionDetails = useCallback((sessionId: string) => {
    if (activeWorkspaceId) setSessionDetails({ workspaceId: activeWorkspaceId, sessionId })
  }, [activeWorkspaceId])
  const pageRef = useRef<HTMLDivElement>(null)
  const pageWidth = useContainerWidth(pageRef)
  const compact = pageWidth < 920
  const sidebarCompact = pageSidebar?.compact ?? compact
  const sidebarVisible = pageSidebar?.visible ?? localSidebarVisible
  const setSidebarOpen = pageSidebar?.setOpen ?? setLocalSidebarOpen
  const toggleSidebar = pageSidebar?.toggle ?? (() => sidebarCompact ? setLocalSidebarOpen(open => !open) : setLocalSidebarVisible(visible => !visible))
  const requestRef = useRef(0)
  const mutationRef = useRef(false)
  const refreshInFlightRef = useRef(false)
  const errorSourceRef = useRef<'load' | 'action'>('load')
  const workspaceRef = useRef(activeWorkspaceId)
  const snapshotRef = useRef(snapshot)
  workspaceRef.current = activeWorkspaceId
  snapshotRef.current = snapshot

  const refresh = useCallback(async () => {
    if (!activeWorkspaceId || mutationRef.current || refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    const revision = ++requestRef.current
    try {
      const next = await window.electronAPI.getSuperAgent(activeWorkspaceId)
      if (revision === requestRef.current && workspaceRef.current === activeWorkspaceId) {
        setSnapshot(next); setLoading(false)
        if (errorSourceRef.current === 'load') setError('')
      }
    } catch (cause) {
      if (revision === requestRef.current && workspaceRef.current === activeWorkspaceId) {
        errorSourceRef.current = 'load'; setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false)
      }
    } finally { refreshInFlightRef.current = false }
  }, [activeWorkspaceId])

  useEffect(() => {
    ++requestRef.current
    setSnapshot(null); setError(''); setLoading(!!activeWorkspaceId); setView('home'); setSettingsSection('settings'); setSelectedNodeId(undefined); setSources([]); setSessionDetails(null)
  }, [activeWorkspaceId])

  useEffect(() => { if (!active) setSessionDetails(null) }, [active])

  useEffect(() => {
    if (!active || !activeWorkspaceId) return
    let alive = true
    let liveTimer: ReturnType<typeof setTimeout> | undefined
    const queueRefresh = () => {
      if (!alive || liveTimer !== undefined) return
      liveTimer = setTimeout(() => { liveTimer = undefined; readSnapshot() }, 200)
    }
    const readSnapshot = () => {
      if (!alive || document.visibilityState === 'hidden') return
      // An event during an existing read or mutation still needs a fresh snapshot.
      if (mutationRef.current || refreshInFlightRef.current) { queueRefresh(); return }
      void refresh()
    }
    readSnapshot()
    const offEvents = window.electronAPI.onSessionEvent(event => {
      const current = snapshotRef.current
      if (current?.state.nodes.some(node => node.sessionId === event.sessionId)
        || current?.activity?.some(activity => activity.sessionId === event.sessionId)) queueRefresh()
    })
    const timer = setInterval(readSnapshot, 2500)
    const onFocus = () => { readSnapshot() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      alive = false; ++requestRef.current; offEvents(); clearInterval(timer)
      if (liveTimer !== undefined) clearTimeout(liveTimer)
      window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus)
    }
  }, [active, activeWorkspaceId, refresh])

  const workDirectory = snapshot?.config?.environment.workingDirectory
  useEffect(() => {
    if (!activeWorkspaceId || !active) return
    let alive = true
    void Promise.allSettled([
      window.electronAPI.superAgentCommand(activeWorkspaceId, { type: 'resources', operation: 'get' }).then(result => (result.resources as { sources: LoadedSource[] }).sources),
    ]).then(results => {
      if (!alive) return
      if (results[0].status === 'fulfilled') setSources(results[0].value)
    })
    const offSources = window.electronAPI.onSourcesChanged((workspaceId, next) => { if (alive && workspaceId === activeWorkspaceId) setSources(next) })
    return () => { alive = false; offSources() }
  }, [activeWorkspaceId, active])

  async function mutate(action: (workspaceId: string) => Promise<SuperAgentSnapshot>) {
    if (!activeWorkspaceId || mutationRef.current) throw new Error(text('working'))
    const workspaceId = activeWorkspaceId
    mutationRef.current = true; setBusy(true); setError(''); ++requestRef.current
    try {
      const next = await action(workspaceId)
      if (workspaceRef.current === workspaceId) { setSnapshot(next); setLoading(false) }
      return next
    } catch (cause) {
      if (workspaceRef.current === workspaceId) { errorSourceRef.current = 'action'; setError(cause instanceof Error ? cause.message : String(cause)) }
      throw cause
    } finally {
      mutationRef.current = false
      setBusy(false)
    }
  }
  const save = (config: SuperAgentConfig) => mutate(workspaceId => window.electronAPI.saveSuperAgent(workspaceId, withExecuteMode(config)))
  const command = (value: SuperAgentCommand) => mutate(workspaceId => window.electronAPI.superAgentCommand(workspaceId, value))
  const config = snapshot?.config
  const coordinator = config?.nodes.find(node => node.role === 'coordinator')
  const coordinatorStatus = snapshot?.state.nodes.find(node => node.nodeId === coordinator?.id)?.status
  const coordinatorWorking = coordinatorStatus != null && ['working', 'preparing', 'recovering'].includes(coordinatorStatus)
  const teamWorking = snapshot?.state.nodes.some(node => ['working', 'preparing', 'recovering'].includes(node.status))
    || snapshot?.state.tasks.some(task => task.status === 'running' || task.status === 'queued')
  function openNodeSettings(nodeId?: string) { setSelectedNodeId(nodeId); setSettingsSection('settings'); setView('settings') }
  const headerActions = config ? <div className="flex items-center gap-1">
    <label className="mr-2 flex items-center gap-2 text-xs" title={text('continuousWorkHint')}><Switch aria-label={text('continuousWork')} checked={config.continuousWork === true} disabled={busy} onCheckedChange={enabled => { void command({ type: 'continuous-work', enabled }).catch(() => {}) }} />{text('continuousWork')}</label>
    <Button size="icon" variant="ghost" className="size-8" disabled={busy} aria-label={text('refresh')} onClick={() => { setError(''); void refresh() }}><RefreshCw className="size-3.5" /></Button>
    {view === 'home'
      ? <Button size="sm" variant="ghost" onClick={() => openNodeSettings()}><Settings2 className="size-3.5" />{text('settings')}</Button>
      : <Button size="sm" variant="ghost" onClick={() => setView('home')}><ArrowLeft className="size-3.5" />{text('backToAssistant')}</Button>}
  </div> : undefined

  const sidebar = <PageSidebar title={text('title')} visible={sidebarVisible} compact={sidebarCompact}
    open={pageSidebar ? active && pageSidebar.mode === 'super-agent' && pageSidebar.open : localSidebarOpen}
    onOpenChange={setSidebarOpen} onToggle={toggleSidebar}>
    <nav aria-label={text('title')} className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
      <button type="button" aria-current={view === 'home' ? 'page' : undefined}
        className={cn('flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left text-xs font-medium', view === 'home' ? 'bg-primary/8 text-primary' : 'text-muted-foreground hover:bg-accent')}
        onClick={() => { setView('home'); if (sidebarCompact) setSidebarOpen(false) }}><Bot className="size-3.5" />{text('backToAssistant')}</button>
      {config && settingsSections.map(({ id, icon: Icon }) => <button key={id} type="button"
        onClick={() => { setView('settings'); setSettingsSection(id); if (id === 'settings') setSelectedNodeId(undefined); if (sidebarCompact) setSidebarOpen(false) }}
        aria-current={view === 'settings' && settingsSection === id ? 'page' : undefined}
        className={cn('flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left text-xs font-medium', view === 'settings' && settingsSection === id ? 'bg-primary/8 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
        <Icon className="size-3.5 shrink-0" />{['sources', 'credentials', 'automations', 'import', 'skills'].includes(id) ? ({ skills: t('sidebar.skills'), sources: t('sidebar.sources'), credentials: t('settings.credentials.title'), automations: t('sidebar.automations'), import: i18n.language.startsWith('zh') ? '导入 / 导出' : 'Import / Export' } as Record<string, string>)[id] : id === 'reports' ? (i18n.language.startsWith('zh') ? '汇报区' : 'Reports') : text(id === 'settings' ? 'generalSettings' : id as Exclude<SettingsSection, 'settings' | 'credentials' | 'automations' | 'import' | 'skills'>)}
      </button>)}
    </nav>
  </PageSidebar>

  return <SuperAgentFileContext workingDirectory={workDirectory}><div className="flex h-full min-h-0">
    {sidebar}
    <div ref={pageRef} className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
    <PanelHeader title={view === 'settings' ? text('settingsTitle') : config?.name ?? text('title')}
      badge={snapshot?.config ? <SuperAgentStatus snapshot={snapshot} pendingPermissions={pendingPermissions} /> : undefined}
      leadingAction={sidebarCompact || !sidebarVisible ? <button type="button" aria-label={t('menu.toggleSidebar')} title={t('menu.toggleSidebar')} className="flex size-9 items-center justify-center rounded-md hover:bg-accent" onClick={toggleSidebar}><PanelLeftOpen className="size-4" /></button> : leadingAction} rightSidebarButton={rightSidebarButton} actions={headerActions} />
    {!activeWorkspaceId ? <PageNotice icon={FolderOpen} title={text('workspaceRequired')} description={text('workspaceRequiredDescription')} />
      : loading ? <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{text('loading')}</div>
        : !snapshot ? <PageNotice icon={Bot} title={text('loadFailed')} description={error}><Button variant="outline" size="sm" onClick={() => { setError(''); setLoading(true); void refresh() }}>{text('retry')}</Button></PageNotice>
          : !config ? <div className="min-h-0 flex-1"><SuperAgentRebuildSettings connections={llmConnections} defaultConnection={workspaceDefaultLlmConnection}
            onSave={async value => { await save(value) }} onOpenAiSettings={onOpenAiSettings} /></div>
            : <>
              {!snapshot.environment.available && <div role="status" className="flex shrink-0 items-start gap-2 border-b border-amber-500/15 bg-amber-500/8 px-5 py-3 text-xs leading-5 text-amber-700 dark:text-amber-400"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" /><p>{snapshot.environment.detail}</p></div>}
              {error && <div role="alert" className="flex shrink-0 items-start justify-between gap-3 border-b border-destructive/15 bg-destructive/8 px-5 py-3 text-xs leading-5 text-destructive"><span>{error}</span><button type="button" aria-label={text('cancel')} className="shrink-0" onClick={() => setError('')}>×</button></div>}
              <div className="min-h-0 flex-1">
                {view === 'home' && <div className={cn('flex h-full min-h-0', compact ? 'flex-col' : 'flex-row')}>
                  <SuperAgentConversation snapshot={snapshot as SuperAgentSnapshot & { config: SuperAgentConfig }} active={active} busy={busy || !!coordinatorWorking} requestPending={busy} onCommand={async value => { await command(value) }}
                    canStop={!busy && (!!teamWorking || config.continuousWork === true)} onStop={() => { void command({ type: 'cancel' }).catch(() => {}) }}
                    onInspect={async () => { await command({ type: 'inspect' }) }} />
                  <WorkProgress snapshot={snapshot as SuperAgentSnapshot & { config: SuperAgentConfig }} compact={compact} busy={busy}
                    onOpenPlans={() => { setSettingsSection('plans'); setView('settings') }}
                    onCreateTask={() => setTaskDialogNode('')} onCommand={async value => { await command(value) }} onOpenSession={openSessionDetails} />
                </div>}
                {view === 'settings' && <div className={cn('flex h-full min-h-0', compact ? 'flex-col' : 'flex-row')}>
                  <div className="min-h-0 min-w-0 flex-1">
                    {settingsSection === 'team' && <NodeTeam snapshot={snapshot as SuperAgentSnapshot & { config: SuperAgentConfig }} pendingPermissions={pendingPermissions}
                      onEdit={openNodeSettings} onOpenSession={openSessionDetails} onTask={nodeId => setTaskDialogNode(nodeId)} onCommand={async value => { await command(value) }} busy={busy} />}
                    {settingsSection === 'board' && <SharedBoard config={config} items={snapshot.state.board} onCommand={async value => { await command(value) }} />}
                    {settingsSection === 'plans' && <div className="h-full overflow-y-auto"><SuperAgentRequirements state={snapshot.state} /><SuperAgentPlans items={snapshot.state.plans} onCommand={async value => { await command(value) }} /></div>}
                    {settingsSection === 'credentials' && <NativeCredentialManager key={activeWorkspaceId!} workspaceId={activeWorkspaceId!} />}
                    {settingsSection === 'skills' && <SuperAgentSharedSkills key={activeWorkspaceId!} workspaceId={activeWorkspaceId!} workingDirectory={workDirectory} />}
                    {settingsSection === 'reports' && <SuperAgentReports state={snapshot.state} />}
                    {settingsSection === 'permissionManagement' && <SuperAgentPermissions key={activeWorkspaceId!} snapshot={snapshot as SuperAgentSnapshot & { config: SuperAgentConfig }} busy={busy} onCommand={command} />}
                    {settingsSection === 'history' && <SuperAgentHistory key={activeWorkspaceId!} workspaceId={activeWorkspaceId!} snapshot={snapshot} busy={busy} onCommand={command} />}
                    {settingsSection === 'statistics' && <SuperAgentStatistics snapshot={snapshot} />}
                    {settingsSection === 'communication' && <NodeCommunication config={config} messages={snapshot.state.messages} onCommand={async value => { await command(value) }} />}
                    {['resources', 'sources', 'automations', 'import'].includes(settingsSection) && <SuperAgentScopedResources key={activeWorkspaceId + ':' + settingsSection} initialTab={settingsSection === 'resources' ? 'sources' : settingsSection as 'sources' | 'credentials' | 'automations' | 'import'} workspaceId={activeWorkspaceId!} onCommand={command} onSources={next => { if (workspaceRef.current === activeWorkspaceId) setSources(next) }} />}
                    {(settingsSection === 'archiveLibrary' || settingsSection === 'memoryLibrary') && <SuperAgentLibrary key={activeWorkspaceId + ':' + settingsSection} library={settingsSection === 'archiveLibrary' ? 'archive' : 'memory'} snapshot={snapshot} onCommand={async value => { await command(value) }} />}
                    {settingsSection === 'scripts' && <SuperAgentScripts snapshot={snapshot as SuperAgentSnapshot & { config: SuperAgentConfig }} onSave={async value => { await save(value) }} onCommand={async value => { await command(value) }} />}
                    {settingsSection === 'settings' && <SuperAgentRebuildSettings key={activeWorkspaceId!} config={config} connections={llmConnections}
                      onSave={async value => { await save(value) }} onOpenAiSettings={onOpenAiSettings}
                      onReset={async () => { await command({ type: 'reset', confirmed: true }); setView('home') }} />}
                  </div>
                </div>}
              </div>
              <TaskDialog config={config} nodeId={taskDialogNode} onClose={() => setTaskDialogNode(null)} onCommand={async value => { await command(value) }} />
              {active && sessionDetails?.workspaceId === activeWorkspaceId && <SuperAgentSessionDialog key={activeWorkspaceId + ':' + sessionDetails.sessionId}
                sessionId={sessionDetails.sessionId} snapshot={snapshot as SuperAgentSnapshot & { config: SuperAgentConfig }}
                busy={busy} onCommand={command} onClose={() => setSessionDetails(null)} />}
            </>}
  </div></div></SuperAgentFileContext>
}

function PageNotice({ icon: Icon, title, description, children }: { icon: typeof Bot; title: string; description: string; children?: ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center"><Icon className="size-10 text-muted-foreground/35" /><div><h2 className="text-base font-medium">{title}</h2><p className="mt-2 max-w-md text-xs leading-5 text-muted-foreground">{description}</p></div>{children}</div>
}

function WorkProgress({ snapshot, compact, busy, onCreateTask, onOpenPlans, onCommand, onOpenSession }: {
  snapshot: SuperAgentSnapshot & { config: SuperAgentConfig }
  compact: boolean
  busy: boolean
  onCreateTask: () => void
  onOpenPlans: () => void
  onCommand: (command: SuperAgentCommand) => Promise<void>
  onOpenSession?: (sessionId: string) => void
}) {
  const text = useSuperAgentText()
  const tasks = snapshot.state.tasks
  const completed = tasks.filter(task => task.status === 'completed'
    && (!snapshot.config.nodes.some(node => node.role === 'orchestrator') || task.acceptance?.status === 'accepted')).length
  const working = tasks.filter(task => task.status === 'running').length
  const blocked = tasks.filter(task => task.status === 'queued' && superAgentTaskNeedsUserAction(snapshot.state, task)).length
  const queued = tasks.filter(task => task.status === 'queued').length - blocked
  const summary = <span className="text-[11px] text-muted-foreground">{text('progressSummary', { working, queued, completed })}{blocked > 0 && ` · ${text('queueBlockedCount', { count: blocked })}`}</span>
  const tasklessActivities = tasklessWorkerActivities(snapshot)
  const list = <div className="space-y-5">
    {snapshot.state.metrics && <p className="text-[10px] leading-5 text-muted-foreground">{text('continuityMetrics', { turns: snapshot.state.metrics.modelTurns, tools: snapshot.state.metrics.toolCalls, retries: snapshot.state.metrics.retries, resumes: snapshot.state.metrics.resumptions })}</p>}
    {!!snapshot.state.intents?.length && <section aria-label={text('goals')} className="space-y-2">{snapshot.state.intents.filter(goal => goal.status !== 'cancelled').slice(-5).map(goal => <div key={goal.id} className="rounded-lg bg-foreground/5 p-3 text-xs"><p className="font-medium">{goal.goal}</p><p className="mt-1 text-[10px] text-muted-foreground">{goal.status === 'delivered' ? text('goalDelivered') : text('active')} · {text('revision', { revision: goal.revision ?? 1 })}</p></div>)}</section>}
    {snapshot.state.nodes.filter(runtime => ['error', 'recovering'].includes(runtime.status)).map(runtime => <article key={runtime.nodeId} className="space-y-2 rounded-xl border border-amber-500/20 p-3">
      <h3 className="text-xs font-medium">{snapshot.config.nodes.find(node => node.id === runtime.nodeId)?.name ?? runtime.nodeId} · {text(runtime.status)}</h3>
      {runtime.error && <p className="break-words text-xs leading-5 text-destructive">{runtime.error}</p>}
      <SuperAgentNodeRecovery runtime={runtime} nodeName={snapshot.config.nodes.find(node => node.id === runtime.nodeId)?.name} busy={busy} onCommand={onCommand} />
      {runtime.sessionId && onOpenSession && <Button size="sm" variant="ghost" onClick={() => onOpenSession(runtime.sessionId!)}>{text('openSession')}</Button>}
    </article>)}
    <button type="button" onClick={onOpenPlans} className="flex w-full items-center justify-between rounded-lg border border-border/60 p-3 text-xs hover:bg-accent"><span className="flex items-center gap-2"><ClipboardList className="size-3.5" />{text('plans')}</span><span className="text-muted-foreground">{snapshot.state.plans.filter(plan => !['completed', 'cancelled'].includes(plan.status)).length}</span></button>
    {(tasks.length > 0 || !tasklessActivities.length) && <TaskList snapshot={snapshot} busy={busy} onCommand={onCommand} onOpenSession={onOpenSession} />}
    {tasklessActivities.length > 0 && <section className="space-y-3" aria-label={text('nodeActivity')}><h3 className="text-[11px] font-medium text-muted-foreground">{text('nodeActivity')}</h3>
      {tasklessActivities.map(activity => {
        const node = snapshot.config.nodes.find(item => item.id === activity.nodeId)!
        return <article key={activity.nodeId + ':' + activity.sessionId} className="space-y-3 rounded-xl border border-border/60 p-3">
          <div className="flex min-w-0 items-center gap-2"><AgentAvatar avatar={node.avatar} name={node.name} className="size-5 rounded text-[10px]" /><h4 className="truncate text-xs font-medium">{node.name}</h4></div>
          <WorkerActivity activity={activity} />
        </article>
      })}
    </section>}
  </div>
  const addButton = <Button variant="ghost" size="icon" className="size-7" aria-label={text('createTask')} disabled={busy || !snapshot.environment.available} onClick={onCreateTask}><Plus className="size-3.5" /></Button>
  if (compact) return <details className="group shrink-0 border-t border-border/70">
    <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3 text-xs">
      <Activity className="size-3.5" /><span className="font-semibold">{text('workProgress')}</span><span className="min-w-0 flex-1 truncate">{summary}</span><ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180" />
    </summary>
    <div className="flex items-center justify-end px-5 pb-2">{addButton}</div>
    <div className="max-h-64 overflow-y-auto px-5 pb-4">{list}<SuperAgentPermissionHistory snapshot={snapshot} className="mt-6" /></div>
  </details>
  return <aside className="flex min-h-0 w-80 shrink-0 flex-col border-l border-border/70">
    <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-4"><h2 className="flex items-center gap-2 text-xs font-semibold"><Activity className="size-3.5" />{text('workProgress')}</h2>{addButton}</div>
    <div className="space-y-3 px-5 pb-4"><div className="flex items-center justify-between gap-2">{summary}<span className="text-[10px] tabular-nums text-muted-foreground">{completed}/{tasks.length}</span></div>
      <div role="progressbar" aria-label={text('workProgress')} aria-valuemin={0} aria-valuemax={tasks.length || 1} aria-valuenow={completed} className="h-1.5 overflow-hidden rounded-full bg-foreground/5"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: tasks.length ? (completed / tasks.length * 100) + '%' : '0%' }} /></div></div>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{list}</div>
    <SuperAgentPermissionHistory snapshot={snapshot} className="mx-4 mb-4 mt-4 max-h-[40%] shrink-0" />
  </aside>
}

function NodeTeam({ snapshot, pendingPermissions, onEdit, onOpenSession, onTask, onCommand, busy }: {
  snapshot: SuperAgentSnapshot & { config: SuperAgentConfig }
  pendingPermissions: ReturnType<typeof useAppShellContext>['pendingPermissions']
  onEdit: (nodeId: string) => void
  onOpenSession?: (sessionId: string) => void
  onTask: (nodeId: string) => void
  onCommand: (command: SuperAgentCommand) => Promise<void>
  busy: boolean
}) {
  const text = useSuperAgentText()
  const { t } = useTranslation()
  const { llmConnections } = useAppShellContext()
  const { config, state } = snapshot
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-4xl space-y-5 p-6">
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{text('team')}</h2><p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{text('coordinatorRule')}</p></div></div>
    {config.architecture === 'dynamic' && <p className="text-xs leading-5 text-muted-foreground">{text('taskNodeLifetime')}</p>}
    <div className="grid gap-4 lg:grid-cols-2">{activeSuperAgentNodes(config, state).map(node => {
      const runtime = state.nodes.find(item => item.nodeId === node.id)
      const approvalCount = runtime?.sessionId ? pendingPermissions.get(runtime.sessionId)?.length ?? 0 : 0
      const activeTask = state.tasks.find(task => task.id === runtime?.activeTaskId)
      const connection = llmConnections.find(item => item.slug === node.llmConnection)
      const backend = node.agentRuntime ?? (connection ? resolveAgentRuntime(connection) : undefined)
      return <article key={node.id} className="min-w-0 space-y-4 rounded-xl border border-border/70 p-5">
        <div className="flex items-start gap-3"><AgentAvatar avatar={node.avatar} name={node.name} className="size-12 rounded-2xl text-2xl" /><div className="min-w-0 flex-1"><h3 className="truncate text-sm font-semibold">{node.name}</h3><p className="mt-1 truncate text-xs text-muted-foreground">{node.model}</p></div>
          <span className={cn('rounded-full px-2 py-1 text-[10px]', runtime && ['working', 'preparing', 'recovering'].includes(runtime.status) ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : runtime?.status === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400')}>{text(runtime?.status ?? 'idle')}</span></div>
        <p className="text-xs leading-5 text-muted-foreground">{node.description}</p>
        <p className="text-xs text-muted-foreground">{text('nodeBackend')}: {backend ? agentRuntimeLabel(backend, t) : text('inheritBackend')}</p>
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground"><span className="rounded bg-foreground/5 px-2 py-1">{text(node.role)}</span><span className="text-primary">{config.modelPool?.find(entry => entry.id === node.modelEntryId)?.intelligenceScore ?? node.intelligenceRating * 20}/100</span><span>{node.maxCallsPerMinute}/min</span><span>{t(`thinking.${node.thinkingLevel}`)}</span></div>
        {activeTask && <p className="rounded-lg bg-foreground/5 p-3 text-xs leading-5"><span className="font-medium">{text('tasks')}: </span>{activeTask.title}</p>}
        {!!node.skillSlugs?.length && <p className="text-xs text-muted-foreground">Skills: {node.skillSlugs.join(', ')}</p>}
        {!!node.sourceSlugs.length && <p className="text-xs text-muted-foreground">MCP: {node.sourceSlugs.join(', ')}</p>}
        {!!runtime?.workflow?.events.length && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{text('workflowEvents')}</summary>
          <ol className="mt-2 space-y-1 break-words">{runtime.workflow.events.map((event, index) => <li key={index}>{formatTimestamp(event.at, true)} · {event.type}{event.executorId ? ` · ${event.executorId}` : ''}{event.state ? ` · ${event.state}` : ''}</li>)}</ol>
        </details>}
        {runtime?.error && <p className="text-xs leading-5 text-destructive">{runtime.error}</p>}
        {runtime && <SuperAgentNodeRecovery runtime={runtime} nodeName={node.name} busy={busy} onCommand={onCommand} />}
        <div className="flex flex-wrap gap-2 border-t border-border/60 pt-3">
          {!node.dynamic && <Button size="sm" variant="outline" onClick={() => onEdit(node.id)}><Settings2 className="size-3.5" />{text('editNode')}</Button>}
          {runtime?.sessionId && onOpenSession && <Button size="sm" variant="outline" className={approvalCount ? 'border-amber-500/30 text-amber-600 dark:text-amber-400' : ''} onClick={() => onOpenSession(runtime.sessionId!)}><MessagesSquare className="size-3.5" />{text('openSession')}{approvalCount > 0 && <span className="rounded-full bg-amber-500/10 px-1.5 text-[10px]">{approvalCount}</span>}</Button>}
          {node.role === 'worker' && !node.dynamic && <Button size="sm" variant="ghost" disabled={busy || !snapshot.environment.available} onClick={() => onTask(node.id)}><Plus className="size-3.5" />{text('createTask')}</Button>}
        </div>
      </article>
    })}</div>
    <div className="flex flex-wrap justify-between gap-3 rounded-xl bg-foreground/4 px-4 py-3 text-[11px] text-muted-foreground"><span>{text('lastInspection')}: {formatTimestamp(state.lastInspectionAt)}</span><span className="max-w-full truncate">{config.environment.workingDirectory}</span></div>
  </div></div>
}

function TaskList({ snapshot, busy, onCommand, onOpenSession }: {
  snapshot: SuperAgentSnapshot & { config: SuperAgentConfig }
  busy: boolean
  onCommand: (command: SuperAgentCommand) => Promise<void>
  onOpenSession?: (sessionId: string) => void
}) {
  const text = useSuperAgentText()
  const { config, state } = snapshot
  if (!state.tasks.length) return <div className="flex flex-col items-center gap-3 px-4 py-12 text-center"><ClipboardList className="size-6 text-muted-foreground/40" /><p className="text-xs text-muted-foreground">{text('noTasks')}</p></div>
  return <div className="space-y-3">{[...state.tasks].sort((a, b) => b.createdAt - a.createdAt).map(task => {
    const node = config.nodes.find(item => item.id === task.nodeId)
    const sessionId = task.sessionId ?? state.nodes.find(item => item.nodeId === task.nodeId)?.sessionId
    const running = task.status === 'running' || task.status === 'queued'
    const submitted = config.nodes.some(node => node.role === 'orchestrator') && task.status === 'completed'
    const blocker = task.status === 'queued' ? superAgentTaskBlocker(state, task) : undefined
    const needsUserAction = task.status === 'queued' && superAgentTaskNeedsUserAction(state, task)
    const statusLabel = needsUserAction ? 'queueBlocked' : blocker || task.phase === 'waiting' ? 'taskWaiting' : task.phase === 'outcome-unknown' ? 'taskUnknown' : task.acceptance?.status === 'stale' ? 'taskStale'
      : submitted ? task.acceptance?.status === 'accepted' ? 'taskAccepted' : task.acceptance?.status === 'rejected' ? 'taskRejected' : 'taskSubmitted' : task.status
    const activity = taskActivity(snapshot, task)
    return <article key={task.id} className="space-y-3 rounded-xl border border-border/60 p-3">
      <div className="flex items-start gap-2"><h3 className="min-w-0 flex-1 break-words text-xs font-medium leading-5">{task.title}</h3><span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px]', task.acceptance?.status === 'accepted' || (!submitted && task.status === 'completed') ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : task.status === 'failed' || task.acceptance?.status === 'rejected' ? 'bg-destructive/10 text-destructive' : 'bg-foreground/5 text-muted-foreground')}>{text(statusLabel)}</span></div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">{node && <AgentAvatar avatar={node.avatar} name={node.name} className="size-5 rounded text-[10px]" />}<span className="min-w-0 flex-1 truncate">{node?.name ?? task.nodeId}</span><span>{formatTimestamp(task.createdAt)}</span></div>
      {task.error && <p className="text-[11px] leading-5 text-destructive">{task.error}</p>}
      {blocker && needsUserAction && <p className="text-[11px] leading-5 text-amber-700 dark:text-amber-400">{text(blocker.code, { detail: blocker.detail })}</p>}
      {task.checkpoint && <details className="text-[11px]"><summary className="cursor-pointer text-muted-foreground">{text('checkpoint')} · {task.checkpoint.completedSteps.length}</summary><p className="mt-2 whitespace-pre-wrap">{task.checkpoint.nextStep}</p><ul className="mt-2 list-inside list-disc text-muted-foreground">{task.checkpoint.completedSteps.map((step, index) => <li key={index}>{step}</li>)}</ul></details>}
      {task.waiting && <p className="text-[11px] leading-5 text-muted-foreground">{task.waiting.reason}</p>}
      {task.checkpoint && (task.status === 'failed' || task.status === 'queued' && task.phase === 'waiting') && task.phase !== 'outcome-unknown' && <Button size="sm" variant="outline" disabled={busy} onClick={() => { void onCommand({ type: 'task-resume', taskId: task.id }).catch(() => {}) }}>{text('resumeTask')}</Button>}
      {state.artifacts?.filter(artifact => artifact.taskId === task.id).map(artifact => <p key={artifact.id} className="break-all text-[10px] text-muted-foreground">{artifact.path} · {artifact.sha256.slice(0, 12)}{artifact.missing ? ` · ${text('missing')}` : ''}</p>)}
      {!!task.dependsOn?.length && <p className="text-[10px] leading-5 text-muted-foreground">{text('taskDependencies')}: {task.dependsOn.map(id => state.tasks.find(item => item.id === id)?.title ?? id).join(' · ')}</p>}
      {task.acceptance && <p className="text-[11px] leading-5 text-muted-foreground">{task.acceptance.note}</p>}
      {activity && <WorkerActivity activity={activity} />}
      {task.output && <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">{text('result')}</summary><div className="mt-2 max-h-80 overflow-y-auto text-xs leading-5"><Markdown>{task.output}</Markdown></div></details>}
      {(running || (sessionId && onOpenSession)) && <div className="flex flex-wrap gap-1.5">{sessionId && onOpenSession && <button type="button" className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground" onClick={() => onOpenSession(sessionId)}><MessagesSquare className="size-3" />{text('openSession')}</button>}
        {running && <button type="button" disabled={busy} className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-destructive disabled:opacity-50" onClick={() => { void onCommand({ type: 'cancel', taskId: task.id }).catch(() => {}) }}><Square className="size-3" />{text('stop')}</button>}</div>}
    </article>
  })}</div>
}

function WorkerActivity({ activity }: { activity: SuperAgentActivity }) {
  const text = useSuperAgentText()
  const entries = recentActivityEntries(activity)
  const previewEntry = entries.findLast(entry => entry.kind === 'thinking' || entry.kind === 'text') ?? entries.at(-1)
  const preview = visibleActivityText(previewEntry?.text ?? '')
  return <details className="group/worker rounded-lg bg-foreground/3 p-3" aria-label={text('liveActivity')}>
    <summary className="cursor-pointer list-none space-y-2">
      <div className="flex items-center gap-1.5 text-[10px]"><BrainCircuit className="size-3 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 font-medium text-muted-foreground">{text('liveActivity')}</span>
        {['working', 'recovering'].includes(activity.status) && <LoaderCircle className="size-3 animate-spin text-muted-foreground" />}
        {activity.status === 'waiting_permission' && <ShieldCheck className="size-3 text-amber-600 dark:text-amber-400" />}
        <span className={cn(activity.status === 'waiting_permission' || activity.status === 'recovering' ? 'text-amber-600 dark:text-amber-400' : activity.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>{text(activity.status === 'waiting_permission' ? 'waitingPermission' : activity.status)}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground transition-transform group-open/worker:rotate-180" />
      </div>
      {preview && <p className="line-clamp-2 break-words text-[11px] leading-5 text-foreground/75">{preview}</p>}
    </summary>
    {entries.length > 0 && <div className="mt-3 max-h-56 space-y-3 overflow-y-auto border-t border-border/60 pt-3">{entries.map(entry => {
      const content = visibleActivityText(entry.text)
      return <article key={entry.id} className="min-w-0 space-y-1.5">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">{entry.kind === 'tool' ? <Wrench className="size-3 shrink-0" /> : entry.kind === 'thinking' ? <BrainCircuit className="size-3 shrink-0" /> : null}
          <span className="min-w-0 flex-1 truncate">{entry.kind === 'tool' ? entry.toolName ?? text('toolActivity') : entry.kind === 'thinking' ? text('thinkingSummary') : entry.kind === 'error' ? text('error') : text('liveActivity')}</span>
          {entry.status === 'running' ? <LoaderCircle className="size-3 shrink-0 animate-spin" /> : entry.status === 'completed' ? <Check className="size-3 shrink-0" /> : null}
        </div>
        {content && <div className={cn('break-words text-[11px] leading-5', entry.kind === 'error' || entry.status === 'failed' ? 'text-destructive' : 'text-foreground/80')}>
          {entry.kind === 'thinking' || entry.kind === 'text' ? <Markdown>{content}</Markdown> : <p className="whitespace-pre-wrap">{content}</p>}
        </div>}
      </article>
    })}</div>}
  </details>
}

function TaskDialog({ config, nodeId, onClose, onCommand }: {
  config: SuperAgentConfig
  nodeId: string | null
  onClose: () => void
  onCommand: (command: SuperAgentCommand) => Promise<void>
}) {
  const text = useSuperAgentText()
  const [selected, setSelected] = useState('')
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const dynamic = config.architecture === 'dynamic'
  const pool = (config.modelPool ?? []).filter(model => model.enabled)
  const [thinkingLevel, setThinkingLevel] = useState(dynamic ? 'medium' : 'default')
  const [criteria, setCriteria] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const defaultsRef = useRef({ dynamic, nodes: config.nodes, pool })
  defaultsRef.current = { dynamic, nodes: config.nodes, pool }
  useEffect(() => { const { dynamic, nodes, pool } = defaultsRef.current; if (nodeId !== null) { setSelected(dynamic ? nodes.find(node => node.id === nodeId)?.modelEntryId ?? pool[0]?.id ?? '' : nodeId); setTitle(''); setInstructions(''); setThinkingLevel(dynamic ? pool[0]?.supportedThinkingLevels[0] ?? 'medium' : 'default'); setCriteria(''); setError('') } }, [nodeId])
  async function submit() {
    setPending(true); setError('')
    try { await onCommand({ type: 'task', title: title.trim(), instructions: instructions.trim(), ...(dynamic ? { modelEntryId: selected } : { nodeId: selected || undefined }),
      thinkingLevel: thinkingLevel === 'default' ? undefined : thinkingLevel as ThinkingLevel,
      acceptanceCriteria: criteria.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
    }); onClose() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setPending(false) }
  }
  return <Dialog open={nodeId !== null} onOpenChange={open => { if (!open && !pending) onClose() }}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>{text('createTask')}</DialogTitle><DialogDescription>{text('coordinatorRule')}</DialogDescription></DialogHeader>
    <fieldset disabled={pending} className="min-w-0 space-y-4">
      <FormField label={text('taskTitle')}><Input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} /></FormField>
      <FormField label={text('taskInstructions')}><textarea className={textareaClass} rows={6} value={instructions} onChange={event => setInstructions(event.target.value)} /></FormField>
      <FormField label={text('assignedNode')}><WorkbenchSelect value={selected} onValueChange={value => { setSelected(value); if (dynamic) setThinkingLevel(pool.find(model => model.id === value)?.supportedThinkingLevels[0] ?? 'medium'); if (config.nodes.find(node => node.id === value)?.thinkingMode === 'fixed') setThinkingLevel('default') }} options={dynamic ? pool.map(model => ({ value: model.id, label: model.name })) : [{ value: "", label: text('automatic') }, ...config.nodes.filter(node => node.role === 'worker').map(node => ({ value: node.id, label: node.name }))]} /></FormField>
      <FormField label={text('thinking')} hint={text('taskThinkingHint')}><WorkbenchSelect value={thinkingLevel} onValueChange={setThinkingLevel}
        disabled={config.nodes.find(node => node.id === selected)?.thinkingMode === 'fixed'} options={dynamic ? (pool.find(model => model.id === selected)?.supportedThinkingLevels ?? []).map(value => ({ value, label: value })) : [{ value: 'default', label: text('nodeThinkingDefault') }, ...THINKING_LEVEL_IDS.map(value => ({ value, label: value }))]} /></FormField>
      <FormField label={text('taskAcceptance')} hint={text('taskAcceptanceHint')}><textarea className={textareaClass} rows={3} value={criteria} onChange={event => setCriteria(event.target.value)} /></FormField>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" onClick={onClose}>{text('cancel')}</Button><Button type="button" disabled={!title.trim() || !instructions.trim() || (config.workflow?.independentReview && !criteria.trim())} onClick={() => void submit()}>{pending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}{text('createTask')}</Button></DialogFooter>
    </fieldset>
  </DialogContent></Dialog>
}
