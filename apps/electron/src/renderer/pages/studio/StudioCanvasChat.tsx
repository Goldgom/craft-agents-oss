import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, Check, Clipboard, LoaderCircle, MessageCircle, RotateCcw, Sparkles } from 'lucide-react'
import { Markdown } from '@/components/markdown'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { StudioThinkingPicker, type StudioThinkingLevel } from './StudioThinkingPicker'
import { StudioExecutionModePicker, type StudioExecutionMode } from './StudioExecutionModePicker'

export type CanvasSuggestion = Awaited<ReturnType<typeof window.electronAPI.assistStudioCanvas>>
export type CanvasChatMessage = { role: 'user' | 'assistant'; text: string; suggestion?: CanvasSuggestion; applied?: boolean; candidateReady?: boolean; comparison?: { before: string; after: string } }

interface StudioCanvasChatProps {
  sessionTitle: string
  selectionLabel: string
  messages: CanvasChatMessage[]
  draft: string
  onDraftChange: (value: string) => void
  thinkingLevel: StudioThinkingLevel
  onThinkingLevelChange: (value: StudioThinkingLevel) => void
  mode: StudioExecutionMode
  onModeChange: (mode: StudioExecutionMode) => void
  onSubmit: (question?: string) => void
  onApply: (index: number) => void
  connectionPicker: ReactNode
  busy: boolean
  canvasBusy: boolean
  error: string
  notice: string
}

export function StudioCanvasChat({ sessionTitle, selectionLabel, messages, draft, onDraftChange, thinkingLevel, onThinkingLevelChange, mode, onModeChange, onSubmit, onApply, connectionPicker, busy, canvasBusy, error, notice }: StudioCanvasChatProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const previousCount = useRef(0)
  const [comparisonIndex, setComparisonIndex] = useState<number | null>(null)

  useEffect(() => {
    if (messages.length > previousCount.current || busy) {
      const list = listRef.current
      if (list) list.scrollTop = list.scrollHeight
    }
    previousCount.current = messages.length
  }, [messages.length, busy])

  const lastQuestion = [...messages].reverse().find(message => message.role === 'user')?.text
  const lastMessageIsQuestion = messages.at(-1)?.role === 'user'

  return <div className="flex h-full min-h-0 flex-col">
    <header className="shrink-0 border-b border-border/70 px-4 py-3">
      <div className="flex items-center gap-2"><MessageCircle className="size-4 text-primary" /><h2 className="text-sm font-semibold">GPT 绘画助手</h2><span className="ml-auto text-[11px] text-muted-foreground">{messages.length ? `${messages.length} 条消息` : '新对话'}</span></div>
      <p className="mt-1 truncate text-[11px] text-muted-foreground" title={sessionTitle}>当前画布 · {sessionTitle}</p>
      <div className="mt-3">{connectionPicker}</div>
    </header>
    <div ref={listRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5" role="log" aria-label="绘画助手对话" aria-live="polite">
      {messages.length === 0 && <div className="flex h-full flex-col items-center justify-center text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Sparkles className="size-6" /></div>
        <h3 className="text-sm font-medium">和 GPT 一起创作</h3>
        <p className="mt-2 max-w-[280px] text-xs leading-5 text-muted-foreground">询问画面效果、讨论修改思路，或描述想要的变化。GPT 会参考当前画布，并给出可手动应用的建议。</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">{['如何让画面更有电影感？', '分析这张图的色彩和构图'].map(example =>
          <button key={example} type="button" className="rounded-lg border border-border px-3 py-2 text-left text-xs hover:bg-accent" onClick={() => { onDraftChange(example); inputRef.current?.focus() }}>{example}</button>)}</div>
      </div>}
      {messages.map((message, index) => <article key={index} className={message.role === 'user' ? 'ml-5 rounded-2xl rounded-tr-md bg-muted/60 px-3.5 py-3' : ''}>
        <div className="mb-2 flex items-center gap-2 text-muted-foreground">
          {message.role === 'assistant' && <span className="flex size-5 items-center justify-center rounded-md bg-primary/10 text-primary" aria-label="助手回复"><Sparkles className="size-3" /></span>}
          <button type="button" className="ml-auto rounded p-1 hover:bg-accent hover:text-foreground" title="复制消息" aria-label="复制消息" onClick={() => void navigator.clipboard.writeText(message.text)}><Clipboard className="size-3" /></button>
        </div>
        {message.role === 'assistant'
          ? <Markdown className="break-words text-xs leading-5">{message.text}</Markdown>
          : <div className="whitespace-pre-wrap break-words text-xs leading-5">{message.text}</div>}
        {message.role === 'assistant' && message.suggestion && message.suggestion.operation !== 'none' && <div className="mt-3 rounded-xl border border-border bg-muted/30 p-3">
          <div className="flex items-center gap-2 text-xs font-medium"><Sparkles className="size-3.5 text-primary" />画布修改建议</div>
          {message.suggestion.prompt && <p className="mt-1.5 whitespace-pre-wrap break-words text-[11px] leading-5 text-muted-foreground">{message.suggestion.prompt}</p>}
          <button type="button" className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2.5 text-xs text-primary hover:bg-primary/20 disabled:opacity-50" disabled={busy || canvasBusy || message.applied} onClick={() => onApply(index)}><Check className="size-3.5" />{message.applied ? message.candidateReady ? '已生成候选图' : message.suggestion.operation === 'adjust' ? '已应用调整' : '已执行建议' : message.suggestion.operation === 'adjust' ? '应用画面调整' : '应用绘画建议'}</button>
          {message.comparison && <div className="mt-3">
            <div className="grid grid-cols-2 gap-2">{([['调整前', message.comparison.before], ['调整后', message.comparison.after]] as const).map(([label, src]) => <button key={label} type="button" className="overflow-hidden rounded-lg border border-border bg-background text-left hover:border-primary/50" onClick={() => setComparisonIndex(index)} aria-label={`放大对比${label}`}><img src={src} alt={label} className="aspect-square w-full object-contain" /><span className="block border-t border-border px-2 py-1 text-[11px] text-muted-foreground">{label}</span></button>)}</div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">点击图片放大对比 · 应用时的画面快照</p>
          </div>}
        </div>}
      </article>)}
      {busy && <div className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />GPT 正在思考…</div>}
      {error && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">{error}{lastMessageIsQuestion && lastQuestion && <button type="button" className="mt-2 flex items-center gap-1 font-medium underline" onClick={() => onSubmit(lastQuestion)}><RotateCcw className="size-3" />重试</button>}</div>}
      {!error && notice && <div role="status" className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">{notice}</div>}
    </div>
    <div className="shrink-0 border-t border-border/70 bg-background p-3">
      <div className="rounded-xl border border-border bg-muted/20 focus-within:border-primary/50">
        <textarea ref={inputRef} className="min-h-24 max-h-56 w-full resize-y bg-transparent px-3 pt-3 text-xs leading-5 outline-none placeholder:text-muted-foreground" aria-label="向 GPT 提问" placeholder="询问或描述想修改的画面…" maxLength={4000} value={draft} onChange={event => onDraftChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onSubmit() } }} />
        <div className="flex items-center gap-2 px-2 pb-2"><StudioExecutionModePicker value={mode} onChange={onModeChange} /><StudioThinkingPicker value={thinkingLevel} onChange={onThinkingLevelChange} /><span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground" title={selectionLabel}>{selectionLabel}</span><button type="button" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40" aria-label="发送消息" disabled={busy || !draft.trim()} onClick={() => onSubmit()}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</button></div>
      </div>
    </div>
    <Dialog open={comparisonIndex !== null} onOpenChange={open => { if (!open) setComparisonIndex(null) }}>
      <DialogContent className="max-w-5xl"><DialogHeader><DialogTitle>画面调整对比</DialogTitle></DialogHeader>
        {comparisonIndex !== null && messages[comparisonIndex]?.comparison && <div className="grid min-h-0 grid-cols-2 gap-3">{([['调整前', messages[comparisonIndex].comparison.before], ['调整后', messages[comparisonIndex].comparison.after]] as const).map(([label, src]) => <div key={label} className="min-w-0"><p className="mb-2 text-xs text-muted-foreground">{label}</p><img src={src} alt={label} className="max-h-[65vh] w-full rounded-lg border border-border bg-muted/20 object-contain" /></div>)}</div>}
      </DialogContent>
    </Dialog>
  </div>
}
