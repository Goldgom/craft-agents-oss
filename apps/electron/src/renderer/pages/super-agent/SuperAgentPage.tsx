import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Activity, ArrowUp, BookOpen, Bot, Check, Circle, ClipboardList, Code2, ExternalLink,
  FolderOpen, Layers3, LoaderCircle, MessageCircle, MessagesSquare, Plus, RefreshCw,
  Settings2, ShieldCheck, Sparkles, Square,
} from 'lucide-react'
import type { SuperAgentCommand, SuperAgentConfig, SuperAgentSnapshot } from '@craft-agent/shared/super-agent'
import type { LoadedSkill, LoadedSource } from '../../../shared/types'
import { useAppShellContext } from '@/context/AppShellContext'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Markdown } from '@/components/markdown'
import { cn } from '@/lib/utils'
import { AgentAvatar, FormField, selectClass, textareaClass } from './SuperAgentForms'
import { SuperAgentSetup } from './SuperAgentSetup'
import { SuperAgentConfiguration } from './SuperAgentConfiguration'
import { SuperAgentResources, SuperAgentScripts } from './SuperAgentResources'
import { NodeCommunication, SharedBoard, nodeLabel } from './SuperAgentCollaboration'
import { formatTimestamp, useSuperAgentText } from './super-agent-ui'

export interface SuperAgentPageProps {
  active?: boolean
  onOpenAiSettings?: () => void
  onOpenSession?: (sessionId: string) => void
}

type PageTab = 'conversation' | 'team' | 'tasks' | 'board' | 'communication' | 'resources' | 'scripts' | 'settings'
const tabs: Array<{ id: PageTab; icon: typeof Bot }> = [
  { id: 'conversation', icon: MessageCircle }, { id: 'team', icon: Layers3 },
  { id: 'tasks', icon: Activity },
  { id: 'board', icon: ClipboardList }, { id: 'communication', icon: MessagesSquare },
  { id: 'resources', icon: BookOpen }, { id: 'scripts', icon: Code2 }, { id: 'settings', icon: Settings2 },
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
  const [tab, setTab] = useState<PageTab>('conversation')
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>()
  const [sources, setSources] = useState<LoadedSource[]>([])
  const [skills, setSkills] = useState<LoadedSkill[]>([])
  const [taskDialogNode, setTaskDialogNode] = useState<string | null>(null)
  const requestRef = useRef(0)
  const mutationRef = useRef(false)
  const refreshInFlightRef = useRef(false)
  const errorSourceRef = useRef<'load' | 'action'>('load')
  const workspaceRef = useRef(activeWorkspaceId)
  workspaceRef.current = activeWorkspaceId

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
    setSnapshot(null); setError(''); setLoading(!!activeWorkspaceId); setTab('conversation'); setSelectedNodeId(undefined); setSources([]); setSkills([])
  }, [activeWorkspaceId])

  useEffect(() => {
    if (!active || !activeWorkspaceId) return
    void refresh()
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh() }, 2500)
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { ++requestRef.current; clearInterval(timer); window.removeEventListener('focus', onFocus) }
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
    } catch (cause) {
      if (workspaceRef.current === workspaceId) { errorSourceRef.current = 'action'; setError(cause instanceof Error ? cause.message : String(cause)) }
      throw cause
    } finally {
      mutationRef.current = false
      setBusy(false)
    }
  }
  const save = (config: SuperAgentConfig) => mutate(workspaceId => window.electronAPI.saveSuperAgent(workspaceId, config))
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
  const coordinatorWorking = coordinatorStatus === 'working' || coordinatorStatus === 'preparing'
  function openNodeSettings(nodeId?: string) { setSelectedNodeId(nodeId); setTab('settings') }
  const headerActions = config ? <div className="flex items-center gap-1">
    <Button size="icon" variant="ghost" className="size-8" disabled={busy} aria-label={text('refresh')} onClick={() => { setError(''); void refresh() }}><RefreshCw className="size-3.5" /></Button>
    <Button size="icon" variant="ghost" className="size-8" aria-label={text('settings')} onClick={() => openNodeSettings()}><Settings2 className="size-3.5" /></Button>
  </div> : undefined

  return <div className="flex h-full min-h-0 flex-col bg-background">
    <PanelHeader title={text('title')} leadingAction={leadingAction} rightSidebarButton={rightSidebarButton} actions={headerActions} />
    {!activeWorkspaceId ? <PageNotice icon={FolderOpen} title={text('workspaceRequired')} description={text('workspaceRequiredDescription')} />
      : loading ? <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{text('loading')}</div>
        : !snapshot ? <PageNotice icon={Bot} title={text('loadFailed')} description={error}><Button variant="outline" size="sm" onClick={() => { setError(''); setLoading(true); void refresh() }}>{text('retry')}</Button></PageNotice>
          : !config ? <div className="min-h-0 flex-1"><SuperAgentSetup connections={llmConnections} defaultConnection={workspaceDefaultLlmConnection}
            onSave={async value => { await save(value) }} onOpenAiSettings={onOpenAiSettings} onLoginTokenNest={loginTokenNest} onRefreshConnections={refreshConnections} /></div>
            : <>
              <div className="shrink-0 border-b border-border/70">
                <div className="flex items-center gap-3 px-5 py-4">
                  <AgentAvatar avatar={config.avatar} name={config.name} className="size-11 rounded-2xl text-2xl" />
                  <div className="min-w-0 flex-1"><h1 className="truncate text-base font-semibold">{config.name}</h1><p className="mt-0.5 truncate text-[11px] text-muted-foreground">{text('setupSummary', { workers: config.nodes.filter(node => node.role === 'worker').length, minutes: config.idleInspectionMinutes })}</p></div>
                  <span className={cn('hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] sm:inline-flex', snapshot.environment.available ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400')}>
                    <ShieldCheck className="size-3.5" />{text(snapshot.environment.available ? 'ready' : 'error')}
                  </span>
                </div>
                <nav className="flex overflow-x-auto px-3" aria-label={text('title')}>{tabs.map(({ id, icon: Icon }) => <button key={id} type="button" onClick={() => { setTab(id); if (id === 'settings') setSelectedNodeId(undefined) }}
                  aria-current={tab === id ? 'page' : undefined} className={cn('flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-3 text-xs font-medium transition-colors', tab === id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
                  <Icon className="size-3.5" />{text(id)}
                  {id === 'team' && <span className="rounded bg-foreground/5 px-1 text-[10px]">{config.nodes.length}</span>}
                </button>)}</nav>
              </div>
              {!snapshot.environment.available && <div role="status" className="flex shrink-0 items-start gap-2 border-b border-amber-500/15 bg-amber-500/8 px-5 py-3 text-xs leading-5 text-amber-700 dark:text-amber-400"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" /><p>{snapshot.environment.detail}</p></div>}
              {error && <div role="alert" className="flex shrink-0 items-start justify-between gap-3 border-b border-destructive/15 bg-destructive/8 px-5 py-3 text-xs leading-5 text-destructive"><span>{error}</span><button type="button" aria-label={text('cancel')} className="shrink-0" onClick={() => setError('')}>×</button></div>}
              <div className="min-h-0 flex-1">
                {tab === 'conversation' && <div className="flex h-full min-h-0 flex-col xl:flex-row">
                  <AssistantConversation snapshot={snapshot as SuperAgentSnapshot & { config: SuperAgentConfig }} busy={busy || !!coordinatorWorking} onCommand={async value => { await command(value) }}
                    canStop={!busy && !!coordinatorWorking} onStop={() => { void command({ type: 'cancel' }).catch(() => {}) }}
                    onInspect={() => { void command({ type: 'inspect' }).catch(() => {}) }} />
                  <aside className="hidden min-h-0 w-80 shrink-0 flex-col border-l border-border/70 xl:flex">
                    <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-4"><h2 className="flex items-center gap-2 text-xs font-semibold"><Activity className="size-3.5" />{text('tasks')}</h2>
                      <Button variant="ghost" size="icon" className="size-7" aria-label={text('createTask')} disabled={busy || !snapshot.environment.available} onClick={() => setTaskDialogNode('')}><Plus className="size-3.5" /></Button></div>
                    <div className="max-h-72 min-h-0 flex-1 overflow-y-auto px-4 pb-4 xl:max-h-none"><TaskList snapshot={snapshot as SuperAgentSnapshot & { config: SuperAgentConfig }} busy={busy} onCommand={async value => { await command(value) }} onOpenSession={onOpenSession} /></div>
                    <p className="shrink-0 border-t border-border/70 px-5 py-3 text-[10px] leading-4 text-muted-foreground">{text('pendingApproval')}</p>
                  </aside>
                </div>}
                {tab === 'team' && <NodeTeam snapshot={snapshot as SuperAgentSnapshot & { config: SuperAgentConfig }} pendingPermissions={pendingPermissions}
                  onEdit={openNodeSettings} onOpenSession={onOpenSession} onTask={nodeId => setTaskDialogNode(nodeId)} busy={busy} />}
                {tab === 'tasks' && <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-3xl space-y-5 p-6">
                  <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">{text('tasks')}</h2><Button size="sm" variant="outline" disabled={busy || !snapshot.environment.available} onClick={() => setTaskDialogNode('')}><Plus className="size-3.5" />{text('createTask')}</Button></div>
                  <TaskList snapshot={snapshot as SuperAgentSnapshot & { config: SuperAgentConfig }} busy={busy} onCommand={async value => { await command(value) }} onOpenSession={onOpenSession} />
                </div></div>}
                {tab === 'board' && <SharedBoard config={config} items={snapshot.state.board} onCommand={async value => { await command(value) }} />}
                {tab === 'communication' && <NodeCommunication config={config} messages={snapshot.state.messages} onCommand={async value => { await command(value) }} />}
                {tab === 'resources' && <SuperAgentResources config={config} sources={sources} skills={skills} onSave={async value => { await save(value) }} />}
                {tab === 'scripts' && <SuperAgentScripts snapshot={snapshot as SuperAgentSnapshot & { config: SuperAgentConfig }} onSave={async value => { await save(value) }} onCommand={async value => { await command(value) }} />}
                {tab === 'settings' && <SuperAgentConfiguration key={activeWorkspaceId + ':' + (selectedNodeId ?? 'settings')} config={config} connections={llmConnections} sources={sources} environmentStatus={snapshot.environment}
                  onSave={async value => { await save(value) }} onOpenAiSettings={onOpenAiSettings} initialNodeId={selectedNodeId} />}
              </div>
              <TaskDialog config={config} nodeId={taskDialogNode} onClose={() => setTaskDialogNode(null)} onCommand={async value => { await command(value) }} />
            </>}
  </div>
}

function PageNotice({ icon: Icon, title, description, children }: { icon: typeof Bot; title: string; description: string; children?: ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center"><Icon className="size-10 text-muted-foreground/35" /><div><h2 className="text-base font-medium">{title}</h2><p className="mt-2 max-w-md text-xs leading-5 text-muted-foreground">{description}</p></div>{children}</div>
}

function AssistantConversation({ snapshot, busy, canStop, onStop, onCommand, onInspect }: {
  snapshot: SuperAgentSnapshot & { config: SuperAgentConfig }
  busy: boolean
  canStop: boolean
  onStop: () => void
  onCommand: (command: SuperAgentCommand) => Promise<void>
  onInspect: () => void
}) {
  const text = useSuperAgentText()
  const { config, state } = snapshot
  const coordinator = config.nodes.find(node => node.role === 'coordinator')!
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const messages = state.messages.filter(message => message.fromNodeId === 'user' || message.toNodeId === 'user')
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight }, [messages.length, busy])
  async function send() {
    if (!input.trim() || busy || sending || !snapshot.environment.available) return
    setSending(true)
    try { await onCommand({ type: 'chat', text: input.trim() }); setInput('') } catch { /* The page displays the backend error and retains the draft. */ } finally { setSending(false) }
  }
  return <section className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-3"><span className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground"><Circle className={cn('size-2 fill-current', busy ? 'text-amber-500' : 'text-emerald-500')} /><span className="truncate">{coordinator.name} · {coordinator.model}</span></span>
      {canStop ? <Button size="sm" variant="ghost" onClick={onStop}><Square className="size-3.5" />{text('stopAll')}</Button>
        : <Button size="sm" variant="ghost" disabled={busy || !snapshot.environment.available} onClick={onInspect}><Sparkles className="size-3.5" />{text('inspect')}</Button>}</div>
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
      <div className="mx-auto max-w-3xl space-y-6">
        {!messages.length && <div className="mx-auto flex max-w-sm flex-col items-center gap-4 py-12 text-center"><AgentAvatar avatar={config.avatar} name={config.name} className="size-16 rounded-3xl text-3xl" /><h2 className="text-lg font-semibold">{config.name}</h2><p className="text-sm leading-6 text-muted-foreground">{text('introMessage')}</p></div>}
        {messages.map(message => {
          const user = message.fromNodeId === 'user'
          const sender = config.nodes.find(node => node.id === message.fromNodeId) ?? coordinator
          return <article key={message.id} className={cn('flex items-start gap-3', user && 'flex-row-reverse')}>
            {!user && <AgentAvatar avatar={sender.avatar} name={sender.name} className="mt-0.5 size-8 rounded-lg text-base" />}
            <div className={cn('min-w-0 max-w-[88%]', user ? 'rounded-2xl bg-foreground/5 px-4 py-3' : 'flex-1')}>
              {!user && <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground"><span className="font-medium">{nodeLabel(config, message.fromNodeId, text)}</span><span>{formatTimestamp(message.createdAt)}</span></div>}
              <div className={cn('break-words text-sm leading-6', message.kind === 'error' && 'text-destructive')}>{user ? <p className="whitespace-pre-wrap">{message.body}</p> : <Markdown>{message.body}</Markdown>}</div>
            </div>
          </article>
        })}
        {busy && <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />{text('working')}</div>}
      </div>
    </div>
    <div className="shrink-0 px-5 pb-5 pt-3">
      <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-background p-3 shadow-xs">
        <textarea rows={2} className="max-h-40 min-h-14 w-full resize-none bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground/70" value={input} placeholder={text('messagePlaceholder')} aria-label={text('messagePlaceholder')}
          onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
        <div className="mt-2 flex items-center justify-between gap-3"><span className="truncate text-[10px] text-muted-foreground">{text('coordinator')} → {config.nodes.filter(node => node.role === 'worker').map(node => node.name).join(' · ')}</span>
          <Button size="icon" className="size-8 shrink-0 rounded-xl" aria-label={text('send')} disabled={!input.trim() || busy || sending || !snapshot.environment.available} onClick={() => void send()}>{sending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</Button></div>
      </div>
    </div>
  </section>
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
          <span className={cn('rounded-full px-2 py-1 text-[10px]', runtime?.status === 'working' || runtime?.status === 'preparing' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' : runtime?.status === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400')}>{text(runtime?.status ?? 'idle')}</span></div>
        <p className="text-xs leading-5 text-muted-foreground">{node.description}</p>
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground"><span className="rounded bg-foreground/5 px-2 py-1">{text(node.role === 'coordinator' ? 'coordinator' : 'worker')}</span><span className="text-amber-500">{'★'.repeat(node.intelligenceRating)}</span><span>{node.maxCallsPerMinute}/min</span><span>{t('thinking.' + node.thinkingLevel)}</span></div>
        {activeTask && <p className="rounded-lg bg-foreground/5 p-3 text-xs leading-5"><span className="font-medium">{text('tasks')}: </span>{activeTask.title}</p>}
        {runtime?.error && <p className="text-xs leading-5 text-destructive">{runtime.error}</p>}
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
    return <article key={task.id} className="space-y-3 rounded-xl border border-border/60 p-3">
      <div className="flex items-start gap-2"><h3 className="min-w-0 flex-1 break-words text-xs font-medium leading-5">{task.title}</h3><span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px]', task.status === 'completed' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : task.status === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-foreground/5 text-muted-foreground')}>{text(task.status)}</span></div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">{node && <AgentAvatar avatar={node.avatar} name={node.name} className="size-5 rounded text-[10px]" />}<span className="min-w-0 flex-1 truncate">{node?.name ?? task.nodeId}</span><span>{formatTimestamp(task.createdAt)}</span></div>
      {task.error && <p className="text-[11px] leading-5 text-destructive">{task.error}</p>}
      {task.output && <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">{text('result')}</summary><div className="mt-2 max-h-80 overflow-y-auto text-xs leading-5"><Markdown>{task.output}</Markdown></div></details>}
      {(running || (sessionId && onOpenSession)) && <div className="flex flex-wrap gap-1.5">{sessionId && onOpenSession && <button type="button" className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground" onClick={() => onOpenSession(sessionId)}><ExternalLink className="size-3" />{text('openSession')}</button>}
        {running && <button type="button" disabled={busy} className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-destructive disabled:opacity-50" onClick={() => { void onCommand({ type: 'cancel', taskId: task.id }).catch(() => {}) }}><Square className="size-3" />{text('stop')}</button>}</div>}
    </article>
  })}</div>
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
