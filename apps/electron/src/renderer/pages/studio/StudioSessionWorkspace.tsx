import { useStudioCompactLayout } from './useStudioCompactLayout'
import { PageSidebar } from '@/components/app-shell/PageSidebar'
import { usePageSidebar } from '@/context/PageSidebarContext'
import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { Check, PanelLeftOpen, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { DeleteSessionConfirmationDialog } from '@/components/DeleteSessionConfirmationDialog'
import {
  activeStudioSessionId, deleteStudioSession, listStudioSessions, loadStudioSession,
  putStudioSession, saveStudioSessionData, setActiveStudioSessionId, updateStudioSessionMeta,
  type StudioSessionMeta, type StudioSessionMode,
} from './studio-sessions'

export type StudioSessionEditorProps = {
  compactLayout?: boolean
  session: StudioSessionMeta & { data: string }
  onSave: (data: string) => Promise<void>
  createSession: () => Promise<void>
  selectSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  deleteSession: (id: string, confirmed?: boolean) => Promise<void>
  flushRef: MutableRefObject<(() => Promise<void>) | null>
  setLocked: (locked: boolean) => void
  suggestTitle: (title: string) => void
}

export function StudioSessionWorkspace({ mode, children }: {
  mode: StudioSessionMode
  children: (props: StudioSessionEditorProps) => ReactNode
}) {
  const { t, i18n } = useTranslation()
  const pageSidebar = usePageSidebar()
  const { ref: layoutRef, compact: smallLayout } = useStudioCompactLayout()
  const compact = mode === 'canvas' && smallLayout
  const sidebarCompact = pageSidebar?.compact ?? smallLayout
  const [localSessionsOpen, setLocalSessionsOpen] = useState(false)
  const sessionsOpen = pageSidebar ? pageSidebar.mode === mode && pageSidebar.open : localSessionsOpen
  const setSessionsOpen = pageSidebar?.setOpen ?? setLocalSessionsOpen
  useEffect(() => { if (!sidebarCompact) setSessionsOpen(false) }, [sidebarCompact, setSessionsOpen])
  const [sessions, setSessions] = useState<StudioSessionMeta[]>([])
  const [current, setCurrent] = useState<(StudioSessionMeta & { data: string }) | null>(null)
  const [loading, setLoading] = useState(true)
  const [locked, setLocked] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState('')
  const [draft, setDraft] = useState('')
  const [localSidebarVisible, setLocalSidebarVisible] = useState(true)
  const sidebarVisible = pageSidebar?.visible ?? localSidebarVisible
  const toggleSidebar = pageSidebar?.toggle ?? (() => setLocalSidebarVisible(value => !value))
  const [creating, setCreating] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const createResolve = useRef<(() => void) | null>(null)
  const flushRef = useRef<(() => Promise<void>) | null>(null)
  const sessionsRef = useRef(sessions); sessionsRef.current = sessions
  const defaultTitle = t('studio.untitledCanvas')
  const initialTitle = useRef(defaultTitle)

  useEffect(() => {
    let alive = true
    void (async () => {
      const items = await listStudioSessions(mode)
      if (!alive) return
      if (!items.length) {
        const meta = { id: `studio-${mode}-first`, mode, title: initialTitle.current, updatedAt: Date.now() }
        await putStudioSession(meta, '')
        if (!alive) return
        setSessions([meta]); setCurrent({ ...meta, data: '' }); setActiveStudioSessionId(mode, meta.id)
      } else {
        const selected = items.find(item => item.id === activeStudioSessionId(mode)) ?? items[0]
        const data = await loadStudioSession(selected.id)
        if (!alive) return
        setSessions(items); setCurrent({ ...selected, data }); setActiveStudioSessionId(mode, selected.id)
      }
    })().catch(cause => { if (alive) setError(i18n.t('studio.sessionLoadFailed', { value1: String(cause) })) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [mode, i18n])

  const save = useCallback(async (data: string) => {
    if (!current) return
    await saveStudioSessionData(current.id, data)
    const meta = sessionsRef.current.find(item => item.id === current.id)
    if (!meta) return
    const next = { ...meta, updatedAt: Date.now() }
    await updateStudioSessionMeta(next)
    setSessions(items => items.map(item => item.id === current.id ? next : item).sort((a, b) => b.updatedAt - a.updatedAt))
  }, [current?.id])

  async function flush() { await flushRef.current?.() }

  async function select(id: string) {
    if (locked) return
    if (id === current?.id) { if (sidebarCompact) setSessionsOpen(false); return }
    try {
      setError(''); await flush()
      const meta = sessions.find(item => item.id === id)
      if (!meta) return
      const data = await loadStudioSession(id)
      flushRef.current = null
      setCurrent({ ...meta, data }); setActiveStudioSessionId(mode, id); if (sidebarCompact) setSessionsOpen(false)
    } catch (cause) { setError(t('studio.sessionSwitchFailed', { value1: String(cause) })) }
  }

  async function finishCreate(workspaceDir?: string) {
    if (locked) return
    try {
      setError(''); await flush()
      const meta: StudioSessionMeta = { id: crypto.randomUUID(), mode, title: defaultTitle, updatedAt: Date.now(), ...(workspaceDir ? { workspaceDir } : {}) }
      await putStudioSession(meta, '')
      flushRef.current = null
      setSessions(items => [meta, ...items]); setCurrent({ ...meta, data: '' }); setActiveStudioSessionId(mode, meta.id)
      if (sidebarCompact) setSessionsOpen(false)
      setCreating(false); createResolve.current?.(); createResolve.current = null
    } catch (cause) { setError(t('studio.sessionCreateFailed', { value1: String(cause) })) }
  }
  async function create() {
    if (locked) return
    return finishCreate()
  }
  function cancelCreate() { setCreating(false); createResolve.current?.(); createResolve.current = null }

  async function rename(id: string, title: string) {
    const meta = sessions.find(item => item.id === id)
    const nextTitle = title.trim().slice(0, 80)
    setEditing('')
    if (!meta || !nextTitle || meta.title === nextTitle) return
    const next = { ...meta, title: nextTitle, updatedAt: Date.now() }
    try {
      await updateStudioSessionMeta(next)
      setSessions(items => items.map(item => item.id === id ? next : item).sort((a, b) => b.updatedAt - a.updatedAt))
      if (current?.id === id) setCurrent(item => item ? { ...item, ...next } : item)
    } catch (cause) { setError(t('studio.renameFailed', { value1: String(cause) })) }
  }

  async function remove(id: string, confirmed = false) {
    if (locked) return
    if (!confirmed) { setPendingDeleteId(id); return }
    try {
      setError('')
      if (id === current?.id) await flush()
      await deleteStudioSession(id)
      const remaining = sessions.filter(item => item.id !== id)
      if (remaining.length) {
        setSessions(remaining)
        if (id === current?.id) {
          const next = remaining[0]
          const data = await loadStudioSession(next.id)
          flushRef.current = null
          setCurrent({ ...next, data }); setActiveStudioSessionId(mode, next.id)
        }
      } else {
        const meta = { id: crypto.randomUUID(), mode, title: defaultTitle, updatedAt: Date.now() }
        await putStudioSession(meta, '')
        flushRef.current = null
        setSessions([meta]); setCurrent({ ...meta, data: '' }); setActiveStudioSessionId(mode, meta.id)
      }
    } catch (cause) { setError(t('studio.sessionDeleteFailed', { value1: String(cause) })) }
  }

  const suggestTitle = useCallback((title: string) => {
    if (current?.title === defaultTitle) void rename(current.id, title)
  }, [current?.id, current?.title, sessions])

  const sidebarTitle = t('studio.canvasSessions')
  const sidebar = <PageSidebar title={sidebarTitle} visible={sidebarVisible} compact={sidebarCompact}
    open={sessionsOpen} onOpenChange={setSessionsOpen} onToggle={toggleSidebar}>
      <div data-studio-session-sidebar className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 pt-2"><button className="flex h-9 w-full items-center gap-2 rounded-md bg-background px-2 text-xs shadow-minimal hover:bg-accent disabled:opacity-40" disabled={locked || loading} onClick={() => void create()}><Plus className="size-4" />{t('studio.newSession')}</button></div>
      <div className="px-2 py-2"><label className="flex h-8 items-center gap-2 rounded-md border border-border/70 bg-background px-2 text-muted-foreground"><Search className="size-3.5" /><input className="w-full bg-transparent text-xs text-foreground outline-none" placeholder={t('studio.searchSessions')} value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {sessions.filter(item => item.title.toLowerCase().includes(query.trim().toLowerCase())).map(item => <div key={item.id}
          className={`group flex min-h-10 items-center gap-1 rounded-lg px-2 ${item.id === current?.id ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'}`}>
          {editing === item.id ? <><input autoFocus className="min-w-0 flex-1 bg-transparent text-xs outline-none" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void rename(item.id, draft); if (event.key === 'Escape') setEditing('') }} onBlur={() => void rename(item.id, draft)} /><button title={t('studio.saveName')} onClick={() => void rename(item.id, draft)}><Check className="size-3.5" /></button></>
            : <><button className="min-w-0 flex-1 truncate py-2 text-left text-xs" title={item.title} disabled={locked} onClick={() => void select(item.id)} onDoubleClick={() => { setEditing(item.id); setDraft(item.title) }}>{item.title}</button><button title={t('studio.rename')} className="hidden shrink-0 hover:text-foreground group-hover:block" onClick={() => { setEditing(item.id); setDraft(item.title) }}><Pencil className="size-3" /></button><button title={t('studio.delete')} className="hidden shrink-0 hover:text-destructive group-hover:block" disabled={locked} onClick={() => void remove(item.id)}><Trash2 className="size-3" /></button></>}
        </div>)}
      </div>
      {error && <div role="alert" className="border-t border-border px-3 py-2 text-xs text-destructive">{error}</div>}
      </div>
    </PageSidebar>
  return <div ref={layoutRef} data-studio-session-compact={(sidebarCompact || (!pageSidebar && !sidebarVisible)) || undefined} className="flex h-full min-h-0 bg-background text-foreground">
    {sidebarCompact || (!pageSidebar && !sidebarVisible) ? <div className="studio-session-mobile-bar"><button aria-label={sidebarTitle} onClick={() => sidebarCompact ? setSessionsOpen(true) : toggleSidebar()}><PanelLeftOpen className="size-4 shrink-0" /><span>{current?.title ?? defaultTitle}</span></button><button aria-label={t('studio.newSession')} disabled={locked || loading} onClick={() => void create()}><Plus className="size-5" /></button></div> : null}
    {sidebar}
    {error && (sidebarCompact || !sidebarVisible) && <div role="alert" className="px-3 py-2 text-xs text-destructive">{error}</div>}
    <div className="min-h-0 min-w-0 flex-1">{current ? children({ compactLayout: compact, session: current, onSave: save, createSession: create, selectSession: select, renameSession: rename, deleteSession: remove, flushRef, setLocked, suggestTitle }) : <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">{loading ? t('studio.loadingSessions') : t('studio.sessionOpenFailed')}</div>}</div>
    <DeleteSessionConfirmationDialog
      sessionName={sessions.find(item => item.id === pendingDeleteId)?.title ?? null}
      onCancel={() => setPendingDeleteId(null)}
      onConfirm={() => { const id = pendingDeleteId; setPendingDeleteId(null); if (id) void remove(id, true) }}
    />
  </div>
}
