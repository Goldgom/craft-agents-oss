import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity, ArrowLeft, BookOpen, Bot, BrainCircuit, Check, ChevronDown, ClipboardList, Code2, ExternalLink,
  FolderOpen, Layers3, LoaderCircle, MessagesSquare, Plus, RefreshCw,
  Settings2, ShieldCheck, Square, Wrench, Archive,
} from 'lucide-react'
import type { SuperAgentCommand, SuperAgentConfig, SuperAgentSnapshot } from '@craft-agent/shared/super-agent'
import type { LoadedSkill, LoadedSource } from '../../../shared/types'
import { useAppShellContext } from '@/context/AppShellContext'
import { useContainerWidth } from '@/hooks/useContainerWidth'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Markdown } from '@/components/markdown'
import { cn } from '@/lib/utils'
import { AgentAvatar, FormField, selectClass, textareaClass } from './SuperAgentForms'
import { SuperAgentSetup } from './SuperAgentSetup'
import { SuperAgentConfiguration } from './SuperAgentConfiguration'
import { SuperAgentResources, SuperAgentScripts } from './SuperAgentResources'
import { NodeCommunication, SharedBoard } from './SuperAgentCollaboration'
import { SuperAgentPlans } from './SuperAgentPlans'
import { SuperAgentHistory } from './SuperAgentHistory'
import { SuperAgentConversation, SuperAgentPermissionHistory } from './SuperAgentConversation'
import { formatTimestamp, useSuperAgentText, withExecuteMode } from './super-agent-ui'
import { recentActivityEntries, taskActivity, tasklessWorkerActivities, visibleActivityText, type SuperAgentActivity } from './super-agent-activity'

export interface SuperAgentPageProps {
  active?: boolean
  onOpenAiSettings?: () => void
  onOpenSession?: (sessionId: string) => void
}

type SettingsSection = 'settings' | 'team' | 'plans' | 'board' | 'communication' | 'resources' | 'scripts' | 'history'
const settingsSections: Array<{ id: SettingsSection; icon: typeof Bot }> = [
  { id: 'settings', icon: Settings2 }, { id: 'team', icon: Layers3 },
  { id: 'plans', icon: ClipboardList },
  { id: 'board', icon: ClipboardList }, { id: 'communication', icon: MessagesSquare },
  { id: 'resources', icon: BookOpen }, { id: 'scripts', icon: Code2 },
  { id: 'history', icon: Archive },
]

export default function SuperAgentPage({ active = true, onOpenAiSettings, onOpenSession }: SuperAgentPageProps) {
  const text = useSuperAgentText()
  const {
    activeWorkspaceId, llmConnections, workspaceDefaultLlmConnection,
    refreshLlmConnections, pendingPermissions, leadingAction, rightSidebarButton,
  } = useAppShellContext()
  const [snapshot, setSnapshot] = useState<SuperAgentSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'home' | 'settings'>('home')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('settings')
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>()
  const [sources, setSources] = useState<LoadedSource[]>([])
  const [skills, setSkills] = useState<LoadedSkill[]>([])
  const [taskDialogNode, setTaskDialogNode] = useState<string | null>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const pageWidth = useContainerWidth(pageRef)
  const compact = pageWidth < 920
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
    setSnapshot(null); setError(''); setLoading(!!activeWorkspaceId); setView('home'); setSettingsSection('settings'); setSelectedNodeId(undefined); setSources([]); setSkills([])
  }, [activeWorkspaceId])

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
      window.electronAPI.getSources(activeWorkspaceId),
      window.electronAPI.getSkills(activeWorkspaceId, workDirectory || undefined),
    ]).then(results => {
      if (!alive) return
      if (results[0].status === 'fulfilled') setSources(results[0].value)
      if (results[1].status === 'fulfilled') setSkills(results[1].value)
    })
    const offSources = window.electronAPI.onSourcesChanged((workspaceId, next) => { if (alive && workspaceId === activeWorkspaceId) setSources(next) })
    const offSkills = window.electronAPI.onSkillsChanged((workspaceId, next) => { if (alive && workspaceId === activeWorkspaceId) setSkills(next) })
    return () => { alive = false; offSources(); offSkills() }
  }, [activeWorkspaceId, workDirectory, active])

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
  async function loginTokenNest() {
    let slug = llmConnections.find(item => item.oauthProvider === 'tokennest')?.slug ?? 'tokennest'
    if (llmConnections.some(item => item.slug === slug && item.oauthProvider !== 'tokennest')) {
      let suffix = 2
      while (llmConnections.some(item => item.slug === 'tokennest-' + suffix)) suffix += 1
      slug = 'tokennest-' + suffix
    }
    const result = await window.electronAPI.startTokenNestOAuth(slug)
    if (!result.success) throw new Error(result.error || text('commandFailed'))
    await refreshLlmConnections()
  }
  async function refreshConnections() {
    await Promise.all(llmConnections.filter(item => item.oauthProvider === 'tokennest' && item.isAuthenticated).map(async item => {
      const result = await window.electronAPI.refreshLlmConnectionModels(item.slug)
      if (!result.success) throw new Error(result.error || text('commandFailed'))
    }))
    await refreshLlmConnections()
  }
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

  return <div ref={pageRef} className="flex h-full min-h-0 flex-col bg-background">
    <PanelHeader title={view === 'settings' ? text('settingsTitle') : config?.name ?? text('title')} leadingAction={leadingAction} rightSidebarButton={rightSidebarButton} actions={headerActions} />
    {!activeWorkspaceId ? <PageNotice icon={FolderOpen} title={text('workspaceRequired')} description={text('workspaceRequiredDescription')} />
      : loading ? <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{text('loading')}</div>
        : !snapshot ? <PageNotice icon={Bot} title={text('loadFailed')} description={error}><Button variant="outline" size="sm" onClick={() => { setError(''); setLoading(true); void refresh() }}>{text('retry')}</Button></PageNotice>
          : !config ? <div className="min-h-0 flex-1"><SuperAgentSetup connections={llmConnections} defaultConnection={workspaceDefaultLlmConnection}
            onSave={async value => { await save(value) }} onOpenAiSettings={onOpenAiSettings} onLoginTokenNest={loginTokenNest} onRefreshConnections={refreshConnections} /></div>
            : <>
              {!snapshot.environment.available && <div role="status" className="flex shrink-0 items-start gap-2 border-b border-amber-500/15 bg-amber-500/8 px-5 py-3 text-xs leading-5 text-amber-700 dark:text-amber-400"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" /><p>{snapshot.environment.detail}</p></div>}
              {error && <div role="alert" className="flex shrink-0 items-start justify-between gap-3 border-b border-destructive/15 bg-destructive/8 px-5 py-3 text-xs leading-5 text-destructive"><span>{error}</span><button type="button" aria-label={text('cancel')} className="shrink-0" onClick={() => setError('')}>×</button></div>}
              <div className="min-h-0 flex-1">
                {view === 'home' && <div className={cn('flex h-full min-h-0', compact ? 'flex-col' : 'flex-row')}>
                  <SuperAgentConversation snapshot={snapshot as SuperAgentSnapshot & { config: SuperAgentConfig }} active={active} busy={busy || !!coordinatorWorking} requestPending={busy} onCommand={async value => { await command(value) }}
                    canStop={!busy && (!!teamWorking || config.continuousWork === true)} onStop={() => { void command({ type: 'cancel' }).catch(() => {}) }}
                    onInspect={() => { void command({ type: 'inspect' }).catch(() => {}) }} />
                  <WorkProgress snapshot={snapshot as SuperAgentSnapshot & { config: SuperAgentConfig }} compact={compact} busy={busy}
                    onOpenPlans={() => { setSettingsSection('plans'); setView('settings') }}
                    onCreateTask={() => setTaskDialogNode('')} onCommand={async value => { await command(value) }} onOpenSession={onOpenSession} />
                </div>}
                {view === 'settings' && <div className={cn('flex h-full min-h-0', compact ? 'flex-col' : 'flex-row')}>
                  <nav aria-label={text('settingsTitle')} className={cn('shrink-0', compact ? 'flex overflow-x-auto border-b border-border/70 px-3' : 'w-48 space-y-1 border-r border-border/70 p-3')}>
                    {settingsSections.map(({ id, icon: Icon }) => <button key={id} type="button" onClick={() => { setSettingsSection(id); if (id === 'settings') setSelectedNodeId(undefined) }}
                      aria-current={settingsSection === id ? 'page' : undefined}
                      className={cn('flex shrink-0 items-center gap-2 rounded-lg px-3 py-3 text-left text-xs font-medium transition-colors', !compact && 'w-full', settingsSection === id ? 'bg-primary/8 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
                      <Icon className="size-3.5 shrink-0" />{text(id === 'settings' ? 'generalSettings' : id)}
                    </button>)}
                  </nav>
                  <div className="min-h-0 min-w-0 flex-1">
                    {settingsSection === 'team' && <NodeTeam snapshot={snapshot as SuperAgentSnapshot & { config: SuperAgentConfig }} pendingPermissions={pendingPermissions}
                      onEdit={openNodeSettings} onOpenSession={onOpenSession} onTask={nodeId => setTaskDialogNode(nodeId)} busy={busy} />}
                    {settingsSection === 'board' && <SharedBoard config={config} items={snapshot.state.board} onCommand={async value => { await command(value) }} />}
                    {settingsSection === 'plans' && <SuperAgentPlans items={snapshot.state.plans} onCommand={async value => { await command(value) }} />}
                    {settingsSection === 'history' && <SuperAgentHistory key={activeWorkspaceId!} workspaceId={activeWorkspaceId!} snapshot={snapshot} busy={busy} onCommand={command} />}
                    {settingsSection === 'communication' && <NodeCommunication config={config} messages={snapshot.state.messages} onCommand={async value => { await command(value) }} />}
                    {settingsSection === 'resources' && <SuperAgentResources config={config} sources={sources} skills={skills} onSave={async value => { await save(value) }} />}
                    {settingsSection === 'scripts' && <SuperAgentScripts snapshot={snapshot as SuperAgentSnapshot & { config: SuperAgentConfig }} onSave={async value => { await save(value) }} onCommand={async value => { await command(value) }} />}
                    {settingsSection === 'settings' && <SuperAgentConfiguration key={activeWorkspaceId + ':' + (selectedNodeId ?? 'settings')} config={config} connections={llmConnections} sources={sources} environmentStatus={snapshot.environment}
                      onContinuousWork={async enabled => { await command({ type: 'continuous-work', enabled }) }}
                      onSave={async value => { await save(value) }} onOpenAiSettings={onOpenAiSettings} initialNodeId={selectedNodeId} />}
                  </div>
                </div>}
              </div>
              <TaskDialog config={config} nodeId={taskDialogNode} onClose={() => setTaskDialogNode(null)} onCommand={async value => { await command(value) }} />
            </>}
  </div>
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
  const completed = tasks.filter(task => task.status === 'completed').length
  const working = tasks.filter(task => task.status === 'running').length
  const queued = tasks.filter(task => task.status === 'queued').length
  const summary = <span className="text-[11px] text-muted-foreground">{text('progressSummary', { working, queued, completed })}</span>
  const tasklessActivities = tasklessWorkerActivities(snapshot)
  const list = <div className="space-y-5">
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

function NodeTeam({ snapshot, pendingPermissions, onEdit, onOpenSession, onTask, busy }: {
  snapshot: SuperAgentSnapshot & { config: SuperAgentConfig }
  pendingPermissions: ReturnType<typeof useAppShellContext>['pendingPermissions']
  onEdit: (nodeId: string) => void
  onOpenSession?: (sessionId: string) => void
  onTask: (nodeId: string) => void
  busy: boolean
}) {
  const text = useSuperAgentText()
  const { t } = useTranslation()
  const { config, state } = snapshot
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-4xl space-y-5 p-6">
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{text('team')}</h2><p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{text('coordinatorRule')}</p></div></div>
    <div className="grid gap-4 lg:grid-cols-2">{config.nodes.map(node => {
      const runtime = state.nodes.find(item => item.nodeId === node.id)
      const approvalCount = runtime?.sessionId ? pendingPermissions.get(runtime.sessionId)?.length ?? 0 : 0
      const activeTask = state.tasks.find(task => task.id === runtime?.activeTaskId)
      return <article key={node.id} className="min-w-0 space-y-4 rounded-xl border border-border/70 p-5">
        <div className="flex items-start gap-3"><AgentAvatar avatar={node.avatar} name={node.name} className="size-12 rounded-2xl text-2xl" /><div className="min-w-0 flex-1"><h3 className="truncate text-sm font-semibold">{node.name}</h3><p className="mt-1 truncate text-xs text-muted-foreground">{node.model}</p></div>
          <span className={cn('rounded-full px-2 py-1 text-[10px]', runtime && ['working', 'preparing', 'recovering'].includes(runtime.status) ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : runtime?.status === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400')}>{text(runtime?.status ?? 'idle')}</span></div>
        <p className="text-xs leading-5 text-muted-foreground">{node.description}</p>
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground"><span className="rounded bg-foreground/5 px-2 py-1">{text(node.role === 'coordinator' ? 'coordinator' : 'worker')}</span><span className="text-amber-500">{'★'.repeat(node.intelligenceRating)}</span><span>{node.maxCallsPerMinute}/min</span><span>{t('thinking.' + node.thinkingLevel)}</span></div>
        {activeTask && <p className="rounded-lg bg-foreground/5 p-3 text-xs leading-5"><span className="font-medium">{text('tasks')}: </span>{activeTask.title}</p>}
        {runtime?.error && <p className="text-xs leading-5 text-destructive">{runtime.error}</p>}
        {runtime?.status === 'recovering' && <p className="text-xs leading-5 text-amber-600 dark:text-amber-400">{text('recoveryNotice', { attempt: runtime.retryAttempt ?? 1 })}</p>}
        <div className="flex flex-wrap gap-2 border-t border-border/60 pt-3">
          <Button size="sm" variant="outline" onClick={() => onEdit(node.id)}><Settings2 className="size-3.5" />{text('editNode')}</Button>
          {runtime?.sessionId && onOpenSession && <Button size="sm" variant="outline" className={approvalCount ? 'border-amber-500/30 text-amber-600 dark:text-amber-400' : ''} onClick={() => onOpenSession(runtime.sessionId!)}><ExternalLink className="size-3.5" />{text('openSession')}{approvalCount > 0 && <span className="rounded-full bg-amber-500/10 px-1.5 text-[10px]">{approvalCount}</span>}</Button>}
          {node.role === 'worker' && <Button size="sm" variant="ghost" disabled={busy || !snapshot.environment.available} onClick={() => onTask(node.id)}><Plus className="size-3.5" />{text('createTask')}</Button>}
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
    const activity = taskActivity(snapshot, task)
    return <article key={task.id} className="space-y-3 rounded-xl border border-border/60 p-3">
      <div className="flex items-start gap-2"><h3 className="min-w-0 flex-1 break-words text-xs font-medium leading-5">{task.title}</h3><span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px]', task.status === 'completed' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : task.status === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-foreground/5 text-muted-foreground')}>{text(task.status)}</span></div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">{node && <AgentAvatar avatar={node.avatar} name={node.name} className="size-5 rounded text-[10px]" />}<span className="min-w-0 flex-1 truncate">{node?.name ?? task.nodeId}</span><span>{formatTimestamp(task.createdAt)}</span></div>
      {task.error && <p className="text-[11px] leading-5 text-destructive">{task.error}</p>}
      {activity && <WorkerActivity activity={activity} />}
      {task.output && <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">{text('result')}</summary><div className="mt-2 max-h-80 overflow-y-auto text-xs leading-5"><Markdown>{task.output}</Markdown></div></details>}
      {(running || (sessionId && onOpenSession)) && <div className="flex flex-wrap gap-1.5">{sessionId && onOpenSession && <button type="button" className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground" onClick={() => onOpenSession(sessionId)}><ExternalLink className="size-3" />{text('openSession')}</button>}
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
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (nodeId !== null) { setSelected(nodeId); setTitle(''); setInstructions(''); setError('') } }, [nodeId])
  async function submit() {
    setPending(true); setError('')
    try { await onCommand({ type: 'task', title: title.trim(), instructions: instructions.trim(), nodeId: selected || undefined }); onClose() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setPending(false) }
  }
  return <Dialog open={nodeId !== null} onOpenChange={open => { if (!open && !pending) onClose() }}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>{text('createTask')}</DialogTitle><DialogDescription>{text('coordinatorRule')}</DialogDescription></DialogHeader>
    <fieldset disabled={pending} className="min-w-0 space-y-4">
      <FormField label={text('taskTitle')}><Input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} /></FormField>
      <FormField label={text('taskInstructions')}><textarea className={textareaClass} rows={6} value={instructions} onChange={event => setInstructions(event.target.value)} /></FormField>
      <FormField label={text('assignedNode')}><select className={selectClass} value={selected} onChange={event => setSelected(event.target.value)}><option value="">{text('automatic')}</option>
        {config.nodes.filter(node => node.role === 'worker').map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select></FormField>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" onClick={onClose}>{text('cancel')}</Button><Button type="button" disabled={!title.trim() || !instructions.trim()} onClick={() => void submit()}>{pending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}{text('createTask')}</Button></DialogFooter>
    </fieldset>
  </DialogContent></Dialog>
}
