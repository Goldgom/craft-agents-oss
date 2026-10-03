import { useEffect, useRef, useState } from 'react'
import { ArrowRight, ArrowUp, ClipboardList, LoaderCircle, MessageSquare, Pencil, Plus, Trash2 } from 'lucide-react'
import type { SuperAgentBoardItem, SuperAgentCommand, SuperAgentConfig, SuperAgentMessage } from '@craft-agent/shared/super-agent'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Markdown } from '@/components/markdown'
import { AgentAvatar, FormField, selectClass, textareaClass } from './SuperAgentForms'
import { formatTimestamp, useSuperAgentText, type SuperAgentText } from './super-agent-ui'

export function nodeLabel(config: SuperAgentConfig, id: string, text: SuperAgentText): string {
  if (id === 'user') return text('user')
  if (id === 'system') return text('system')
  if (id === 'all') return text('broadcast')
  return config.nodes.find(node => node.id === id)?.name ?? id
}

export function SharedBoard({ config, items, onCommand }: {
  config: SuperAgentConfig
  items: SuperAgentBoardItem[]
  onCommand: (command: SuperAgentCommand) => Promise<void>
}) {
  const text = useSuperAgentText()
  const [editing, setEditing] = useState<{ id?: string; title: string; content: string; revision?: number } | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function run(command: SuperAgentCommand, close = false) {
    setPending(true); setError('')
    try { await onCommand(command); if (close) setEditing(null) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setPending(false) }
  }
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-4xl space-y-5 p-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{text('board')}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{text('boardHint')}</p></div>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => { setError(''); setEditing({ title: '', content: '' }) }}><Plus className="size-3.5" />{text('addBoardItem')}</Button></div>
    {items.length === 0 ? <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-border px-8 py-20 text-center"><ClipboardList className="size-9 text-muted-foreground/40" /><p className="max-w-sm text-sm leading-6 text-muted-foreground">{text('emptyBoard')}</p></div>
      : <div className="grid gap-4 lg:grid-cols-2">{[...items].sort((a, b) => b.updatedAt - a.updatedAt).map(item => <article key={item.id} className="min-w-0 rounded-xl border border-border/70 bg-background p-5">
        <div className="flex items-start gap-2"><h3 className="min-w-0 flex-1 break-words text-sm font-semibold">{item.title}</h3><Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label={text('edit')} disabled={pending} onClick={() => { setError(''); setEditing({ ...item }) }}><Pencil className="size-3.5" /></Button>
          <Button variant="ghost" size="icon" className="size-6 shrink-0 text-muted-foreground hover:text-destructive" aria-label={text('delete')} disabled={pending} onClick={() => void run({ type: 'board-delete', id: item.id, expectedRevision: item.revision })}><Trash2 className="size-3.5" /></Button></div>
        <div className="mt-3 max-h-96 overflow-y-auto text-sm leading-6"><Markdown>{item.content}</Markdown></div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-[10px] text-muted-foreground"><span>{nodeLabel(config, item.updatedBy, text)} · {formatTimestamp(item.updatedAt)}</span><span>{text('revision', { revision: item.revision })}</span></div>
      </article>)}</div>}
    {error && !editing && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    <Dialog open={editing !== null} onOpenChange={open => { if (!open && !pending) setEditing(null) }}>
      <DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>{text('addBoardItem')}</DialogTitle><DialogDescription>{text('boardHint')}</DialogDescription></DialogHeader>
        {editing && <fieldset disabled={pending} className="min-w-0 space-y-4"><FormField label={text('boardTitle')}><Input value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })} /></FormField>
          <FormField label={text('content')}><textarea rows={8} className={textareaClass} value={editing.content} onChange={event => setEditing({ ...editing, content: event.target.value })} /></FormField>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button type="button" variant="outline" onClick={() => setEditing(null)}>{text('cancel')}</Button><Button type="button" disabled={!editing.title.trim() || !editing.content.trim()}
            onClick={() => void run({ type: 'board-upsert', item: { id: editing.id, title: editing.title.trim(), content: editing.content }, expectedRevision: editing.revision }, true)}>{pending && <LoaderCircle className="size-3.5 animate-spin" />}{text('save')}</Button></DialogFooter>
        </fieldset>}
      </DialogContent>
    </Dialog>
  </div></div>
}

export function NodeCommunication({ config, messages, onCommand }: {
  config: SuperAgentConfig
  messages: SuperAgentMessage[]
  onCommand: (command: SuperAgentCommand) => Promise<void>
}) {
  const text = useSuperAgentText()
  const coordinator = config.nodes.find(node => node.role === 'coordinator')!
  const [fromNodeId, setFromNodeId] = useState(coordinator.id)
  const [toNodeId, setToNodeId] = useState('all')
  const [body, setBody] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const communication = messages.filter(message => message.kind !== 'chat')
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }) }, [communication.length])
  async function send() {
    if (!body.trim() || pending) return
    setPending(true); setError('')
    try { await onCommand({ type: 'message', fromNodeId, toNodeId, body: body.trim() }); setBody('') } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setPending(false) }
  }
  return <div className="flex h-full min-h-0 flex-col">
    <div className="shrink-0 border-b border-border/70 px-6 py-4"><h2 className="text-base font-semibold">{text('communication')}</h2><p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{text('communicationHint')}</p></div>
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-3xl space-y-4">
        {!communication.length && <div className="flex flex-col items-center gap-3 py-16 text-center"><MessageSquare className="size-8 text-muted-foreground/40" /><p className="text-xs text-muted-foreground">{text('noMessages')}</p></div>}
        {communication.map(message => {
          const sender = config.nodes.find(node => node.id === message.fromNodeId)
          return <article key={message.id} className="flex items-start gap-3">
            <AgentAvatar avatar={sender?.avatar ?? (message.fromNodeId === 'user' ? '◉' : '◎')} name={nodeLabel(config, message.fromNodeId, text)} className="size-8 rounded-lg text-base" />
            <div className="min-w-0 flex-1 rounded-xl border border-border/60 p-4">
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]"><span className="font-medium">{nodeLabel(config, message.fromNodeId, text)}</span><ArrowRight className="size-3 text-muted-foreground" /><span>{nodeLabel(config, message.toNodeId, text)}</span>
                <span className="ml-1 rounded bg-foreground/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">{text((message.kind + 'Kind') as 'messageKind' | 'taskKind' | 'resultKind' | 'inspectionKind' | 'scriptKind' | 'errorKind')}</span><time className="ml-auto text-[10px] text-muted-foreground">{formatTimestamp(message.createdAt)}</time></div>
              <div className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-foreground/85">{message.body}</div>
            </div>
          </article>
        })}
        <div ref={endRef} />
      </div>
    </div>
    <div className="shrink-0 border-t border-border/70 px-6 py-4">
      <div className="mx-auto max-w-3xl space-y-3">
        <div className="grid grid-cols-2 gap-3"><FormField label={text('from')}><select className={selectClass} value={fromNodeId} onChange={event => { setFromNodeId(event.target.value); if (toNodeId === event.target.value) setToNodeId('all') }}>
          {config.nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select></FormField>
          <FormField label={text('to')}><select className={selectClass} value={toNodeId} onChange={event => setToNodeId(event.target.value)}><option value="all">{text('broadcast')}</option>
            {config.nodes.filter(node => node.id !== fromNodeId).map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select></FormField></div>
        <div className="flex items-end gap-2"><textarea className={textareaClass + ' min-h-16 flex-1'} rows={2} value={body} placeholder={text('messageBody')} onChange={event => setBody(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
          <Button className="size-10 shrink-0 rounded-xl" size="icon" disabled={!body.trim() || pending} aria-label={text('send')} onClick={() => void send()}>{pending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</Button></div>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  </div>
}
