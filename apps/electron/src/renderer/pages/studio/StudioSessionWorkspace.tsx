import { useStudioCompactLayout } from './useStudioCompactLayout'
import { StudioMobileSheet } from './StudioMobileSheet'
import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { Check, FileImage, GitBranch, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { DeleteSessionConfirmationDialog } from '@/components/DeleteSessionConfirmationDialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  activeStudioSessionId, deleteStudioSession, listStudioSessions, loadStudioSession,
  moveMindMapSessionToDirectory, putStudioSession, saveStudioSessionData, setActiveStudioSessionId, updateStudioSessionMeta,
  type StudioSessionMeta, type StudioSessionMode,
} from './studio-sessions'

export type StudioSessionEditorProps = {
  compactLayout?: boolean
  session: StudioSessionMeta & { data: string }
  onSave: (data: string) => Promise<void>
  createSession: () => Promise<void>
  bindWorkDirectory: () => Promise<void>
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
  const { ref: layoutRef, compact: smallLayout } = useStudioCompactLayout()
  const compact = mode === 'canvas' && smallLayout
  const [sessionsOpen, setSessionsOpen] = useState(false)
  useEffect(() => { if (!compact) setSessionsOpen(false) }, [compact])
  const [sessions, setSessions] = useState<StudioSessionMeta[]>([])
  const [current, setCurrent] = useState<(StudioSessionMeta & { data: string }) | null>(null)
  const [loading, setLoading] = useState(true)
  const [locked, setLocked] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState('')
  const [draft, setDraft] = useState('')
  const [collapsed, setCollapsed] = useState(() => new URLSearchParams(window.location.search).get('embedded') === 'android')
  const [creating, setCreating] = useState(false)
  const [workDirectory, setWorkDirectory] = useState('')
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const createResolve = useRef<(() => void) | null>(null)
  const flushRef = useRef<(() => Promise<void>) | null>(null)
  const sessionsRef = useRef(sessions); sessionsRef.current = sessions
  const defaultTitle = mode === 'canvas' ? t('studio.untitledCanvas') : t('studio.untitledDiagram')
  const initialTitle = useRef(defaultTitle)

  useEffect(() => {
    let alive = true
    void (async () => {
      const items = await listStudioSessions(mode)
      if (!alive) return
      if (!items.length) {
        if (mode === 'mindmap') { setSessions([]); setCurrent(null); return }
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
    if (id === current?.id) { setSessionsOpen(false); return }
    try {
      setError(''); await flush()
      const meta = sessions.find(item => item.id === id)
      if (!meta) return
      const data = await loadStudioSession(id)
      flushRef.current = null
      setCurrent({ ...meta, data }); setActiveStudioSessionId(mode, id); setSessionsOpen(false)
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
      setSessionsOpen(false); setCreating(false); createResolve.current?.(); createResolve.current = null
    } catch (cause) { setError(t('studio.sessionCreateFailed', { value1: String(cause) })) }
  }
  async function create() {
    if (locked) return
    if (mode === 'canvas') return finishCreate()
    if (creating) return
    setWorkDirectory(current?.workspaceDir ?? '')
    setCreating(true)
    return new Promise<void>(resolve => { createResolve.current = resolve })
  }
  async function bindWorkDirectory() {
    if (locked || !current || current.mode !== 'mindmap' || current.workspaceDir) return
    try {
      const directory = await window.electronAPI.pickStudioMindMapDirectory()
      if (!directory) return
      await flush()
      const next = await moveMindMapSessionToDirectory(current, directory)
      setSessions(items => items.map(item => item.id === next.id ? next : item))
      setCurrent(item => item ? { ...item, ...next } : item)
      setError('')
    } catch (cause) { setError(t('studio.directorySetFailed', { value1: String(cause) })) }
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
        if (mode === 'mindmap') {
          setSessions([]); setCurrent(null); flushRef.current = null
          return
        }
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

  const sidebar = (<aside data-studio-session-sidebar className={`flex shrink-0 flex-col border-r border-border/70 bg-muted/20 ${(collapsed && !compact) ? 'w-11' : 'w-56'}`}>
      <div className={`flex h-12 shrink-0 items-center justify-between border-b border-border/70 ${(collapsed && !compact) ? 'px-1.5' : 'px-3'}`}>
        {(!collapsed || compact) && <span className="flex items-center gap-2 text-sm font-semibold">{mode === 'canvas' ? <FileImage className="size-4 text-primary" /> : <GitBranch className="size-4 text-primary" />}{mode === 'canvas' ? t('studio.canvasSessions') : t('studio.diagramSessions')}</span>}
        <div className="flex items-center gap-1"><button className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" title={(collapsed && !compact) ? t('studio.expandSessions') : t('studio.collapseSessions')} aria-label={(collapsed && !compact) ? t('studio.expandSessions') : t('studio.collapseSessions')} onClick={() => compact ? setSessionsOpen(false) : setCollapsed(value => !value)}>{(collapsed && !compact) ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}</button>{(!collapsed || compact) && <button className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" title={t('studio.newSession')} aria-label={t('studio.newSession')} disabled={locked || loading} onClick={() => void create()}><Plus className="size-4" /></button>}</div>
      </div>
      {(collapsed && !compact) ? <button className="mx-auto mt-2 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" title={t('studio.newSession')} aria-label={t('studio.newSession')} disabled={locked || loading} onClick={() => void create()}><Plus className="size-4" /></button> : <>
      <div className="px-2 py-2"><label className="flex h-8 items-center gap-2 rounded-md border border-border/70 bg-background px-2 text-muted-foreground"><Search className="size-3.5" /><input className="w-full bg-transparent text-xs text-foreground outline-none" placeholder={t('studio.searchSessions')} value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {sessions.filter(item => item.title.toLowerCase().includes(query.trim().toLowerCase())).map(item => <div key={item.id}
          className={`group flex min-h-10 items-center gap-1 rounded-lg px-2 ${item.id === current?.id ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'}`}>
          {editing === item.id ? <><input autoFocus className="min-w-0 flex-1 bg-transparent text-xs outline-none" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void rename(item.id, draft); if (event.key === 'Escape') setEditing('') }} onBlur={() => void rename(item.id, draft)} /><button title={t('studio.saveName')} onClick={() => void rename(item.id, draft)}><Check className="size-3.5" /></button></>
            : <><button className="min-w-0 flex-1 truncate py-2 text-left text-xs" title={item.title} disabled={locked} onClick={() => void select(item.id)} onDoubleClick={() => { setEditing(item.id); setDraft(item.title) }}>{item.title}</button><button title={t('studio.rename')} className="hidden shrink-0 hover:text-foreground group-hover:block" onClick={() => { setEditing(item.id); setDraft(item.title) }}><Pencil className="size-3" /></button><button title={t('studio.delete')} className="hidden shrink-0 hover:text-destructive group-hover:block" disabled={locked} onClick={() => void remove(item.id)}><Trash2 className="size-3" /></button></>}
        </div>)}
      </div>
      {error && <div role="alert" className="border-t border-border px-3 py-2 text-xs text-destructive">{error}</div>}
      </>}
    </aside>)
  return <div ref={layoutRef} data-studio-session-compact={compact || undefined} className="flex h-full min-h-0 bg-background text-foreground">
    {compact ? <>
      <div className="studio-session-mobile-bar"><button aria-label={t('studio.canvasSessions')} onClick={() => setSessionsOpen(true)}><PanelLeftOpen className="size-4 shrink-0" /><span>{current?.title ?? defaultTitle}</span></button><button aria-label={t('studio.newSession')} disabled={locked || loading} onClick={() => void create()}><Plus className="size-5" /></button></div>
      <StudioMobileSheet open={sessionsOpen} onOpenChange={setSessionsOpen} title={t('studio.canvasSessions')}>{sidebar}</StudioMobileSheet>
    </> : sidebar}
    {error && compact && <div role="alert" className="px-3 py-2 text-xs text-destructive">{error}</div>}
    <div className="min-h-0 min-w-0 flex-1">{current ? children({ compactLayout: mode === 'canvas' ? compact : undefined, session: current, onSave: save, createSession: create, bindWorkDirectory, selectSession: select, renameSession: rename, deleteSession: remove, flushRef, setLocked, suggestTitle }) : <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">{loading ? t('studio.loadingSessions') : mode === 'mindmap' ? <><span>{t('studio.chooseFolderCreate')}</span><button className="rounded-md bg-primary px-3 py-2 text-primary-foreground" onClick={() => void create()}>{t('studio.newMindMap')}</button></> : t('studio.sessionOpenFailed')}</div>}</div>
    <DeleteSessionConfirmationDialog
      sessionName={sessions.find(item => item.id === pendingDeleteId)?.title ?? null}
      onCancel={() => setPendingDeleteId(null)}
      onConfirm={() => { const id = pendingDeleteId; setPendingDeleteId(null); if (id) void remove(id, true) }}
    />
    <Dialog open={creating} onOpenChange={open => { if (!open) cancelCreate() }}>
      <DialogContent><DialogHeader><DialogTitle>{t('studio.chooseMindMapFolder')}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{t('studio.mindMapFolderHint')}</p>
        <button type="button" className="min-h-10 rounded-md border border-border px-3 text-left text-sm hover:bg-accent" onClick={async () => { try { const selected = await window.electronAPI.pickStudioMindMapDirectory(workDirectory || undefined); if (selected) setWorkDirectory(selected) } catch (cause) { setError(String(cause)) } }}>{workDirectory || t('studio.chooseFolder')}</button>
        <div className="flex justify-end gap-2"><button className="rounded-md px-3 py-2 text-sm hover:bg-accent" onClick={cancelCreate}>{t('studio.cancel')}</button><button disabled={!workDirectory} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40" onClick={() => void finishCreate(workDirectory)}>{t('studio.create')}</button></div>
      </DialogContent>
    </Dialog>
  </div>
}
