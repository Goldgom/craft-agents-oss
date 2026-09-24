import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { Check, FileImage, GitBranch, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import {
  activeStudioSessionId, deleteStudioSession, listStudioSessions, loadStudioSession,
  putStudioSession, saveStudioSessionData, setActiveStudioSessionId, updateStudioSessionMeta,
  type StudioSessionMeta, type StudioSessionMode,
} from './studio-sessions'

export type StudioSessionEditorProps = {
  session: StudioSessionMeta & { data: string }
  onSave: (data: string) => Promise<void>
  createSession: () => Promise<void>
  flushRef: MutableRefObject<(() => Promise<void>) | null>
  setLocked: (locked: boolean) => void
  suggestTitle: (title: string) => void
}

export function StudioSessionWorkspace({ mode, children }: {
  mode: StudioSessionMode
  children: (props: StudioSessionEditorProps) => ReactNode
}) {
  const [sessions, setSessions] = useState<StudioSessionMeta[]>([])
  const [current, setCurrent] = useState<(StudioSessionMeta & { data: string }) | null>(null)
  const [loading, setLoading] = useState(true)
  const [locked, setLocked] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState('')
  const [draft, setDraft] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const flushRef = useRef<(() => Promise<void>) | null>(null)
  const sessionsRef = useRef(sessions); sessionsRef.current = sessions
  const defaultTitle = mode === 'canvas' ? '未命名画布' : '未命名导图'

  useEffect(() => {
    let alive = true
    void (async () => {
      const items = await listStudioSessions(mode)
      if (!alive) return
      if (!items.length) {
        const meta = { id: `studio-${mode}-first`, mode, title: defaultTitle, updatedAt: Date.now() }
        await putStudioSession(meta, '')
        if (!alive) return
        setSessions([meta]); setCurrent({ ...meta, data: '' }); setActiveStudioSessionId(mode, meta.id)
      } else {
        const selected = items.find(item => item.id === activeStudioSessionId(mode)) ?? items[0]
        const data = await loadStudioSession(selected.id)
        if (!alive) return
        setSessions(items); setCurrent({ ...selected, data }); setActiveStudioSessionId(mode, selected.id)
      }
    })().catch(cause => { if (alive) setError(`会话加载失败：${String(cause)}`) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [mode])

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
    if (locked || id === current?.id) return
    try {
      setError(''); await flush()
      const meta = sessions.find(item => item.id === id)
      if (!meta) return
      const data = await loadStudioSession(id)
      flushRef.current = null
      setCurrent({ ...meta, data }); setActiveStudioSessionId(mode, id)
    } catch (cause) { setError(`切换会话失败：${String(cause)}`) }
  }

  async function create() {
    if (locked) return
    try {
      setError(''); await flush()
      const meta = { id: crypto.randomUUID(), mode, title: defaultTitle, updatedAt: Date.now() }
      await putStudioSession(meta, '')
      flushRef.current = null
      setSessions(items => [meta, ...items]); setCurrent({ ...meta, data: '' }); setActiveStudioSessionId(mode, meta.id)
    } catch (cause) { setError(`新建会话失败：${String(cause)}`) }
  }

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
    } catch (cause) { setError(`重命名失败：${String(cause)}`) }
  }

  async function remove(id: string) {
    if (locked || !window.confirm('删除这个会话及其中的内容？此操作无法撤销。')) return
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
    } catch (cause) { setError(`删除会话失败：${String(cause)}`) }
  }

  const suggestTitle = useCallback((title: string) => {
    if (current?.title === defaultTitle) void rename(current.id, title)
  }, [current?.id, current?.title, sessions])

  return <div className="flex h-full min-h-0 bg-background text-foreground">
    <aside className={`flex shrink-0 flex-col border-r border-border/70 bg-muted/20 ${collapsed ? 'w-11' : 'w-56'}`}>
      <div className={`flex h-12 shrink-0 items-center justify-between border-b border-border/70 ${collapsed ? 'px-1.5' : 'px-3'}`}>
        {!collapsed && <span className="flex items-center gap-2 text-sm font-semibold">{mode === 'canvas' ? <FileImage className="size-4 text-primary" /> : <GitBranch className="size-4 text-primary" />}{mode === 'canvas' ? '画布会话' : '导图会话'}</span>}
        <div className="flex items-center gap-1"><button className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" title={collapsed ? '展开会话侧边栏' : '收起会话侧边栏'} aria-label={collapsed ? '展开会话侧边栏' : '收起会话侧边栏'} onClick={() => setCollapsed(value => !value)}>{collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}</button>{!collapsed && <button className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" title="新建会话" aria-label="新建会话" disabled={locked || loading} onClick={() => void create()}><Plus className="size-4" /></button>}</div>
      </div>
      {collapsed ? <button className="mx-auto mt-2 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" title="新建会话" aria-label="新建会话" disabled={locked || loading} onClick={() => void create()}><Plus className="size-4" /></button> : <>
      <div className="px-2 py-2"><label className="flex h-8 items-center gap-2 rounded-md border border-border/70 bg-background px-2 text-muted-foreground"><Search className="size-3.5" /><input className="w-full bg-transparent text-xs text-foreground outline-none" placeholder="搜索会话" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {sessions.filter(item => item.title.toLowerCase().includes(query.trim().toLowerCase())).map(item => <div key={item.id}
          className={`group flex min-h-10 items-center gap-1 rounded-lg px-2 ${item.id === current?.id ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'}`}>
          {editing === item.id ? <><input autoFocus className="min-w-0 flex-1 bg-transparent text-xs outline-none" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void rename(item.id, draft); if (event.key === 'Escape') setEditing('') }} onBlur={() => void rename(item.id, draft)} /><button title="保存名称" onClick={() => void rename(item.id, draft)}><Check className="size-3.5" /></button></>
            : <><button className="min-w-0 flex-1 truncate py-2 text-left text-xs" title={item.title} disabled={locked} onClick={() => void select(item.id)} onDoubleClick={() => { setEditing(item.id); setDraft(item.title) }}>{item.title}</button><button title="重命名" className="hidden shrink-0 hover:text-foreground group-hover:block" onClick={() => { setEditing(item.id); setDraft(item.title) }}><Pencil className="size-3" /></button><button title="删除" className="hidden shrink-0 hover:text-destructive group-hover:block" disabled={locked} onClick={() => void remove(item.id)}><Trash2 className="size-3" /></button></>}
        </div>)}
      </div>
      {error && <div role="alert" className="border-t border-border px-3 py-2 text-xs text-destructive">{error}</div>}
      </>}
    </aside>
    <div className="min-w-0 flex-1">{current ? children({ session: current, onSave: save, createSession: create, flushRef, setLocked, suggestTitle }) : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{loading ? '正在加载会话…' : '无法打开会话'}</div>}</div>
  </div>
}
