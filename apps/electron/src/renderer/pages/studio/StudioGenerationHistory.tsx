import { useEffect, useState } from 'react'
import { Download, History, ImagePlus, LoaderCircle, RotateCcw, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  deleteStudioGeneration, listStudioGenerations,
  type StudioGeneration,
} from './studio-generation-history'

const PAGE_SIZE = 20
const kindName = { generate: '生成', edit: '局部修改', outpaint: '扩图', cutout: '智能抠图' } as const

export function GenerationImage({ record, className }: { record: StudioGeneration; className: string }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const next = URL.createObjectURL(record.image)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [record.image])
  return url ? <img src={url} alt={record.prompt} className={className} /> : <div className={className} />
}

function download(record: StudioGeneration) {
  const url = URL.createObjectURL(record.image)
  const link = document.createElement('a')
  link.href = url
  link.download = `tokenbird-${record.kind}-${new Date(record.createdAt).toISOString().replace(/[:.]/g, '-')}.png`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function time(value: number) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(value)
}

export function StudioGenerationHistory({ revision, sessionId, disabled, onAddToCanvas, onReusePrompt }: {
  revision: number
  sessionId: string
  disabled: boolean
  onAddToCanvas: (record: StudioGeneration) => Promise<void>
  onReusePrompt: (prompt: string) => void
}) {
  const [records, setRecords] = useState<StudioGeneration[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [open, setOpen] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const selected = records.find(record => record.id === selectedId) ?? records[0]

  useEffect(() => {
    let alive = true
    setLoading(true)
    void listStudioGenerations(PAGE_SIZE).then(page => {
      if (!alive) return
      setRecords(page.items)
      setHasMore(page.hasMore)
      setSelectedId(current => page.items.some(item => item.id === current) ? current : page.items[0]?.id ?? '')
      setError('')
    }).catch(cause => { if (alive) setError(`生成历史加载失败：${String(cause)}`) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [revision])

  async function loadMore() {
    const last = records[records.length - 1]
    if (!hasMore || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await listStudioGenerations(PAGE_SIZE, last ? { createdAt: last.createdAt, id: last.id } : undefined)
      setRecords(current => [...current, ...page.items])
      setHasMore(page.hasMore)
      setError('')
    } catch (cause) { setError(`更多历史加载失败：${String(cause)}`) }
    finally { setLoadingMore(false) }
  }

  async function remove(record: StudioGeneration) {
    if (!window.confirm('删除这条本地生成记录及图片？此操作无法撤销。')) return
    setBusy(true)
    try {
      await deleteStudioGeneration(record.id)
      const remaining = records.filter(item => item.id !== record.id)
      setRecords(remaining)
      setSelectedId(current => current === record.id || !remaining.some(item => item.id === current) ? remaining[0]?.id ?? '' : current)
      setError('')
    } catch (cause) { setError(`删除生成历史失败：${String(cause)}`) }
    finally { setBusy(false) }
  }

  async function addToCanvas(record: StudioGeneration) {
    if (disabled) return
    setBusy(true)
    try { await onAddToCanvas(record); setOpen(false); setError('') }
    catch (cause) { setError(`加入画布失败：${String(cause)}`) }
    finally { setBusy(false) }
  }

  return <>
    <section className="space-y-3 border-b border-border/70 px-4 py-4">
      <div className="flex items-center gap-2"><History className="size-4 text-primary" /><h2 className="text-sm font-semibold">生成历史</h2><button className="ml-auto text-[11px] text-primary hover:underline" onClick={() => setOpen(true)}>查看全部</button></div>
      {loading ? <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />正在加载历史…</p>
        : records.length ? <div className="space-y-1.5">{records.slice(0, 3).map(record => <button key={record.id} className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-muted/20 p-1.5 text-left hover:border-primary/40 hover:bg-accent/40" onClick={() => { setSelectedId(record.id); setOpen(true) }}>
          <GenerationImage record={record} className="size-12 shrink-0 rounded-md bg-muted object-cover" />
          <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{record.prompt}</span><span className="mt-1 block truncate text-[10px] text-muted-foreground">{kindName[record.kind]} · {record.model} · {time(record.createdAt)}</span></span>
        </button>)}</div> : <p className="text-xs text-muted-foreground">成功生成的图片会保存在这里，切换画布后也能查看。</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>

    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[min(88vh,860px)] max-w-5xl flex-col overflow-hidden">
        <DialogHeader><DialogTitle>本地生成历史</DialogTitle></DialogHeader>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto md:grid-cols-[230px_minmax(0,1fr)] md:overflow-hidden">
          <div className="min-h-0 space-y-1.5 overflow-y-auto pr-1">
            {records.map(record => <button key={record.id} className={`flex w-full items-center gap-2 rounded-lg border p-1.5 text-left ${record.id === selected?.id ? 'border-primary/50 bg-primary/10' : 'border-border/50 hover:bg-accent/40'}`} onClick={() => setSelectedId(record.id)}>
              <GenerationImage record={record} className="size-14 shrink-0 rounded-md bg-muted object-cover" />
              <span className="min-w-0 flex-1"><span className="block truncate text-xs">{record.prompt}</span><span className="mt-1 block text-[10px] text-muted-foreground">{time(record.createdAt)}</span></span>
            </button>)}
            {hasMore && <button className="w-full rounded-md border border-border px-3 py-2 text-xs hover:bg-accent disabled:opacity-50" disabled={loadingMore || busy} onClick={() => void loadMore()}>{loadingMore ? '加载中…' : '加载更多'}</button>}
          </div>
          {selected ? <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            <div className="flex min-h-48 flex-1 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-[linear-gradient(45deg,#e5e5e5_25%,transparent_25%),linear-gradient(-45deg,#e5e5e5_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#e5e5e5_75%),linear-gradient(-45deg,transparent_75%,#e5e5e5_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0] dark:bg-muted/30"><GenerationImage record={selected} className="max-h-[48vh] max-w-full object-contain" /></div>
            <div className="space-y-1 text-xs"><p className="whitespace-pre-wrap break-words font-medium">{selected.prompt}</p><p className="text-muted-foreground">{kindName[selected.kind]} · {selected.model} · {selected.width} × {selected.height} · {time(selected.createdAt)}</p><p className="text-muted-foreground">{selected.connectionName}{selected.channelGroup ? ` · ${selected.channelGroup}` : ''} · {selected.sessionId === sessionId ? '当前画布' : selected.sessionTitle}</p></div>
            <div className="flex flex-wrap gap-2 border-t border-border/70 pt-3"><button className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50" disabled={busy || disabled} onClick={() => void addToCanvas(selected)}><ImagePlus className="size-3.5" />导入完整图片为新图层</button><button className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs hover:bg-accent" onClick={() => { onReusePrompt(selected.prompt); setOpen(false) }}><RotateCcw className="size-3.5" />复用提示词</button><button className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs hover:bg-accent" onClick={() => download(selected)}><Download className="size-3.5" />下载 PNG</button><button className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg border border-destructive/30 px-3 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50" disabled={busy || loadingMore} onClick={() => void remove(selected)}><Trash2 className="size-3.5" />删除</button></div>
          </div> : <div className="flex items-center justify-center text-xs text-muted-foreground">暂无生成记录</div>}
        </div>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  </>
}
