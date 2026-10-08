import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
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
      <div className="flex items-center gap-2"><MessageCircle className="size-4 text-primary" /><h2 className="text-sm font-semibold">{t('studio.drawingAssistant')}</h2><span className="ml-auto text-[11px] text-muted-foreground">{messages.length ? t('studio.messageCount', { count: messages.length }) : t('studio.newConversation')}</span></div>
      <p className="mt-1 truncate text-[11px] text-muted-foreground" title={sessionTitle}>{t('studio.currentCanvasLabel', { title: sessionTitle })}</p>
      <div className="mt-3">{connectionPicker}</div>
    </header>
    <div ref={listRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5" role="log" aria-label={t('studio.drawingConversation')} aria-live="polite">
      {messages.length === 0 && <div className="flex h-full flex-col items-center justify-center text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Sparkles className="size-6" /></div>
        <h3 className="text-sm font-medium">{t('studio.createWithGpt')}</h3>
        <p className="mt-2 max-w-[280px] text-xs leading-5 text-muted-foreground">{t('studio.drawingChatHint')}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">{[t('studio.cinematicExample'), t('studio.colorExample')].map(example =>
          <button key={example} type="button" className="rounded-lg border border-border px-3 py-2 text-left text-xs hover:bg-accent" onClick={() => { onDraftChange(example); inputRef.current?.focus() }}>{example}</button>)}</div>
      </div>}
      {messages.map((message, index) => <article key={index} className={message.role === 'user' ? 'ml-5 rounded-2xl rounded-tr-md bg-muted/60 px-3.5 py-3' : ''}>
        <div className="mb-2 flex items-center gap-2 text-muted-foreground">
          {message.role === 'assistant' && <span className="flex size-5 items-center justify-center rounded-md bg-primary/10 text-primary" aria-label={t('studio.assistantReply')}><Sparkles className="size-3" /></span>}
          <button type="button" className="ml-auto rounded p-1 hover:bg-accent hover:text-foreground" title={t('studio.copyMessage')} aria-label={t('studio.copyMessage')} onClick={() => void navigator.clipboard.writeText(message.text)}><Clipboard className="size-3" /></button>
        </div>
        {message.role === 'assistant'
          ? <Markdown className="break-words text-xs leading-5">{message.text}</Markdown>
          : <div className="whitespace-pre-wrap break-words text-xs leading-5">{message.text}</div>}
        {message.role === 'assistant' && message.suggestion && message.suggestion.operation !== 'none' && <div className="mt-3 rounded-xl border border-border bg-muted/30 p-3">
          <div className="flex items-center gap-2 text-xs font-medium"><Sparkles className="size-3.5 text-primary" />{t('studio.canvasSuggestion')}</div>
          {message.suggestion.prompt && <p className="mt-1.5 whitespace-pre-wrap break-words text-[11px] leading-5 text-muted-foreground">{message.suggestion.prompt}</p>}
          <button type="button" className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2.5 text-xs text-primary hover:bg-primary/20 disabled:opacity-50" disabled={busy || canvasBusy || message.applied} onClick={() => onApply(index)}><Check className="size-3.5" />{message.applied ? message.candidateReady ? t('studio.candidatesGenerated') : message.suggestion.operation === 'adjust' ? t('studio.adjustmentsApplied') : t('studio.suggestionApplied') : message.suggestion.operation === 'adjust' ? t('studio.applyImageAdjustments') : t('studio.applyDrawingSuggestion')}</button>
          {message.comparison && <div className="mt-3">
            <div className="grid grid-cols-2 gap-2">{([[t('studio.before'), message.comparison.before], [t('studio.after'), message.comparison.after]] as const).map(([label, src]) => <button key={label} type="button" className="overflow-hidden rounded-lg border border-border bg-background text-left hover:border-primary/50" onClick={() => setComparisonIndex(index)} aria-label={t('studio.enlargeComparison', { value1: label })}><img src={src} alt={label} className="aspect-square w-full object-contain" /><span className="block border-t border-border px-2 py-1 text-[11px] text-muted-foreground">{label}</span></button>)}</div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">{t('studio.comparisonHint')}</p>
          </div>}
        </div>}
      </article>)}
      {busy && <div className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />{t('studio.gptThinking')}</div>}
      {!error && notice && <div role="status" className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">{notice}</div>}
    </div>
    <div className="shrink-0 border-t border-border/70 bg-background p-3">
      {error && <div role="alert" className="mb-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}{lastMessageIsQuestion && lastQuestion && <button type="button" className="mt-2 flex items-center gap-1 font-medium underline" onClick={() => onSubmit(lastQuestion)}><RotateCcw className="size-3" />{t('studio.retry')}</button>}</div>}
      <div className="rounded-xl border border-border bg-muted/20 focus-within:border-primary/50">
        <textarea ref={inputRef} className="min-h-24 max-h-56 w-full resize-y bg-transparent px-3 pt-3 text-xs leading-5 outline-none placeholder:text-muted-foreground" aria-label={t('studio.askGpt')} placeholder={t('studio.drawingQuestion')} maxLength={4000} value={draft} onChange={event => onDraftChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onSubmit() } }} />
        <div className="flex items-center gap-2 px-2 pb-2"><StudioExecutionModePicker value={mode} onChange={onModeChange} /><StudioThinkingPicker value={thinkingLevel} onChange={onThinkingLevelChange} /><span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground" title={selectionLabel}>{selectionLabel}</span><button type="button" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40" aria-label={t('studio.sendMessage')} disabled={busy || !draft.trim()} onClick={() => onSubmit()}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</button></div>
      </div>
    </div>
    <Dialog open={comparisonIndex !== null} onOpenChange={open => { if (!open) setComparisonIndex(null) }}>
      <DialogContent className="max-w-5xl"><DialogHeader><DialogTitle>{t('studio.adjustmentComparison')}</DialogTitle></DialogHeader>
        {comparisonIndex !== null && messages[comparisonIndex]?.comparison && <div className="grid min-h-0 grid-cols-2 gap-3">{([[t('studio.before'), messages[comparisonIndex].comparison.before], [t('studio.after'), messages[comparisonIndex].comparison.after]] as const).map(([label, src]) => <div key={label} className="min-w-0"><p className="mb-2 text-xs text-muted-foreground">{label}</p><img src={src} alt={label} className="max-h-[65vh] w-full rounded-lg border border-border bg-muted/20 object-contain" /></div>)}</div>}
      </DialogContent>
    </Dialog>
  </div>
}
