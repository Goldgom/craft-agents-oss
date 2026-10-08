import { WorkbenchSelect } from '@/components/ui/workbench-select'
import { useEffect, useState } from 'react'
import { Archive, BrainCircuit, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react'
import { historySessionEligible, planSuperAgentHistoryCleanup, protectedHistorySessionIds } from '@craft-agent/shared/super-agent/history'
import type { SuperAgentCommand, SuperAgentHistoryCleanupResult, SuperAgentSnapshot } from '@craft-agent/shared/super-agent'
import type { Session } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FormField } from './SuperAgentForms'
import { formatTimestamp, useSuperAgentText } from './super-agent-ui'

type Mode = SuperAgentHistoryCleanupResult['mode']
type CleanupCommand = Extract<SuperAgentCommand, { type: 'history-cleanup' | 'history-compact' | 'history-delete-sessions' }>

export function SuperAgentHistory({ workspaceId, snapshot, busy, onCommand }: {
  workspaceId: string
  snapshot: SuperAgentSnapshot
  busy: boolean
  onCommand: (command: SuperAgentCommand) => Promise<SuperAgentSnapshot>
}) {
  const text = useSuperAgentText()
  const [mode, setMode] = useState<Mode>('runtime')
  const [days, setDays] = useState(30)
  const [keep, setKeep] = useState(20)
  const [sessions, setSessions] = useState<Session[]>([])
  const [selectedNodes, setSelectedNodes] = useState<string[]>([])
  const [selectedSessions, setSelectedSessions] = useState<string[]>([])
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<SuperAgentHistoryCleanupResult>()
  const [confirmation, setConfirmation] = useState<{ command: CleanupCommand; mode: Mode; names: string[]; count: number; preview: string }>()
  useEffect(() => {
    if (mode !== 'sessions') return
    let alive = true
    setLoading(true)
    void window.electronAPI.getSessions().then(items => {
      if (alive) { setSessions(items.filter(session => session.workspaceId === workspaceId)); setError('') }
    }).catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [workspaceId, reload, mode])

  const before = Date.now() - days * 86_400_000
  const cleanup = planSuperAgentHistoryCleanup(snapshot.state, before, keep).removed
  const preview = text('historyPreview', { tasks: cleanup.tasks.length, messages: cleanup.messages.length, plans: cleanup.plans.length, logs: cleanup.scriptLogs.length })
  const protectedIds = protectedHistorySessionIds(snapshot.state)
  const eligible = sessions.filter(session => historySessionEligible(session, workspaceId, before, protectedIds))
  const selected = eligible.filter(session => selectedSessions.includes(session.id))
  const nodes = snapshot.state.nodes.filter(node => node.sessionId)
  const chosenNodes = nodes.filter(node => selectedNodes.includes(node.nodeId))
  const locked = busy || pending || snapshot.state.nodes.some(node => ['working', 'preparing', 'recovering'].includes(node.status))
    || snapshot.state.tasks.some(task => ['queued', 'running'].includes(task.status))
    || snapshot.state.scripts.some(script => ['running', 'untracked'].includes(script.status))
    || snapshot.permissionRequests?.some(request => request.status === 'pending')
  const count = mode === 'runtime' ? cleanup.tasks.length + cleanup.messages.length + cleanup.plans.length + cleanup.scriptLogs.length
    : mode === 'compact' ? chosenNodes.length : selected.length
  function toggle(id: string, values: string[], update: (next: string[]) => void) {
    update(values.includes(id) ? values.filter(value => value !== id) : [...values, id])
  }
  function review() {
    setError('')
    const expectedRevision = snapshot.state.revision
    const command: CleanupCommand = mode === 'runtime'
      ? { type: 'history-cleanup', before, keepRecentMessages: keep, expectedRevision }
      : mode === 'compact' ? { type: 'history-compact', nodeIds: chosenNodes.map(node => node.nodeId), expectedRevision }
        : { type: 'history-delete-sessions', sessions: selected.map(session => ({ id: session.id, lastMessageAt: session.lastMessageAt })), before, expectedRevision }
    setConfirmation({ command, mode, count, preview, names: mode === 'sessions' ? selected.map(session => session.name || session.preview || session.id)
      : mode === 'compact' ? chosenNodes.map(node => snapshot.config?.nodes.find(item => item.id === node.nodeId)?.name ?? node.nodeId) : [] })
  }
  async function execute() {
    if (!confirmation || pending) return
    setPending(true); setError('')
    try {
      const next = await onCommand(confirmation.command)
      setResult(next.historyCleanup); setConfirmation(undefined)
      setSelectedNodes([]); setSelectedSessions([])
      if (confirmation.mode === 'sessions') setReload(value => value + 1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }
  const choices = [
    { mode: 'runtime' as const, icon: Archive, title: 'historyRuntime' as const, hint: 'historyRuntimeHint' as const },
    { mode: 'compact' as const, icon: BrainCircuit, title: 'historyCompact' as const, hint: 'historyCompactHint' as const },
    { mode: 'sessions' as const, icon: Trash2, title: 'historySessions' as const, hint: 'historySessionsHint' as const },
  ]
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-3xl space-y-5 p-6">
    <header><h2 className="text-lg font-semibold">{text('history')}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{text('historyHint')}</p></header>
    <fieldset disabled={pending} className="space-y-3"><legend className="sr-only">{text('history')}</legend>
      {choices.map(({ mode: value, icon: Icon, title, hint }) => <label key={value} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${mode === value ? 'border-primary/40 bg-primary/5' : 'border-border/70'}`}>
        <input type="radio" name="history-mode" value={value} checked={mode === value} onChange={() => { setMode(value); setResult(undefined); setError('') }} className="mt-1 accent-primary" />
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span><span className="text-sm font-medium">{text(title)}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{text(hint)}</span></span>
      </label>)}
    </fieldset>
    {mode !== 'compact' && <div className="grid gap-4 sm:grid-cols-2"><FormField label={text('historyPeriod')}><WorkbenchSelect disabled={pending} value={days} onValueChange={value => setDays(Number(value))} options={[...[30, 7, 90, 0].map(value => ({ value: value, label: value ? text('historyOlder', { days: value }) : text('historyAll') }))]} /></FormField>
      {mode === 'runtime' && <FormField label={text('historyKeep')}><WorkbenchSelect disabled={pending} value={keep} onValueChange={value => setKeep(Number(value))} options={[...[20, 50, 0].map(value => ({ value: value, label: text('historyKeepCount', { count: value }) }))]} /></FormField>}</div>}
    {mode === 'runtime' && <p className="rounded-lg bg-foreground/5 p-3 text-xs leading-5" aria-live="polite">{preview}</p>}
    {mode === 'compact' && <div className="space-y-2">{!nodes.length && <p className="text-xs text-muted-foreground">{text('historyNoNodes')}</p>}
      {nodes.map(node => <label key={node.nodeId} className="flex items-center gap-3 rounded-lg border border-border/60 p-3 text-xs"><input type="checkbox" checked={selectedNodes.includes(node.nodeId)} disabled={locked} onChange={() => toggle(node.nodeId, selectedNodes, setSelectedNodes)} className="accent-primary" />
        <span>{snapshot.config?.nodes.find(item => item.id === node.nodeId)?.name ?? node.nodeId}<span className="mt-1 block text-[10px] text-muted-foreground">{node.sessionId}</span></span></label>)}</div>}
    {mode === 'sessions' && <div className="space-y-3"><div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">{text('historySelected', { count: selected.length })}</span>
      <Button size="sm" variant="ghost" disabled={pending || loading} onClick={() => setReload(value => value + 1)}><RefreshCw className="size-3.5" />{text('refresh')}</Button></div>
      {loading ? <LoaderCircle aria-label={text('loading')} className="size-4 animate-spin" /> : !eligible.length ? <p className="text-xs leading-5 text-muted-foreground">{text('historyNoSessions')}</p> : <div className="max-h-80 space-y-2 overflow-y-auto">
        {eligible.map(session => <label key={session.id} className="flex items-start gap-3 rounded-lg border border-border/60 p-3 text-xs"><input type="checkbox" checked={selectedSessions.includes(session.id)} disabled={locked || (selected.length >= 100 && !selectedSessions.includes(session.id))} onChange={() => toggle(session.id, selectedSessions, setSelectedSessions)} className="mt-0.5 accent-primary" />
          <span className="min-w-0 break-words">{session.name || session.preview || session.id}<span className="mt-1 block text-[10px] text-muted-foreground">{formatTimestamp(session.lastMessageAt)} · {session.id}</span></span></label>)}</div>}</div>}
    {locked && <p role="status" className="text-xs text-muted-foreground">{text('historyIdle')}</p>}
    {error && !confirmation && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <Button size="sm" variant={mode === 'sessions' ? 'destructive' : 'outline'} disabled={locked || !count || (mode === 'sessions' && loading)} onClick={review}>
      {mode === 'runtime' ? <Archive className="size-3.5" /> : mode === 'compact' ? <BrainCircuit className="size-3.5" /> : <Trash2 className="size-3.5" />}
      {text(mode === 'runtime' ? 'historyArchive' : mode === 'compact' ? 'historyCompactAction' : 'historyDeleteAction')}</Button>
    {result && <section role="status" className="space-y-2 rounded-lg border border-border/70 p-4 text-xs leading-5">
      <p>{result.mode === 'runtime' ? text('historyDone', { tasks: result.tasks, messages: result.messages, plans: result.plans, logs: result.scriptLogs })
        : result.mode === 'compact' ? text('historyQueued', { count: result.queued }) : text('historyDeleted', { count: result.sessions })}</p>
      {result.archivePath && <Button size="sm" variant="ghost" onClick={() => { void window.electronAPI.showInFolder(result.archivePath!).catch(cause => setError(String(cause))) }}>{text('historyArchiveOpen')}</Button>}
      {result.failures.length > 0 && <><p className="text-destructive">{text('historyFailed', { count: result.failures.length })}</p><ul className="list-inside list-disc">{result.failures.map(failure => <li key={failure.sessionId}>{failure.sessionId}: {failure.error}</li>)}</ul></>}
    </section>}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !pending) setConfirmation(undefined) }}><DialogContent className="sm:max-w-lg">
      <DialogHeader><DialogTitle>{text('historyConfirm')}</DialogTitle><DialogDescription>{confirmation && text(confirmation.mode === 'runtime' ? 'historyConfirmRuntime' : confirmation.mode === 'compact' ? 'historyConfirmCompact' : 'historyConfirmDelete', { count: confirmation.count })}</DialogDescription></DialogHeader>
      {confirmation?.mode === 'runtime' && <p className="text-xs leading-5">{confirmation.preview}</p>}
      {!!confirmation?.names.length && <ul className="max-h-48 list-inside list-disc space-y-1 overflow-y-auto break-words text-xs">{confirmation.names.map((name, index) => <li key={index}>{name}</li>)}</ul>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setConfirmation(undefined)}>{text('cancel')}</Button>
        <Button variant={confirmation?.mode === 'sessions' ? 'destructive' : 'default'} disabled={pending || busy} onClick={() => void execute()}>{pending && <LoaderCircle className="size-3.5 animate-spin" />}{text(confirmation?.mode === 'sessions' ? 'historyDeleteAction' : confirmation?.mode === 'compact' ? 'historyCompactAction' : 'historyArchive')}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div></div>
}
