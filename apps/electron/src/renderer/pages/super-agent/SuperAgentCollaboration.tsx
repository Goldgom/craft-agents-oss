import { WorkbenchSelect } from '@/components/ui/workbench-select'
import { useEffect, useRef, useState } from 'react'
import { Archive, ArrowRight, ArrowUp, ClipboardList, LoaderCircle, MessageSquare, Pencil, Pin, Plus, Trash2 } from 'lucide-react'
import { SUPER_AGENT_BOARD_LIMIT, hasPlanningTopology, canSuperAgentCommunicate, activeSuperAgentNodes, type SuperAgentBoardMaintenance, type SuperAgentBoardItem, type SuperAgentCommand, type SuperAgentConfig, type SuperAgentMessage, type SuperAgentState } from '@tokenbird/shared/super-agent'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Markdown } from '@/components/markdown'
import { AgentAvatar, FormField, textareaClass } from './SuperAgentForms'
import { formatTimestamp, useSuperAgentText, type SuperAgentText } from './super-agent-ui'

export function nodeLabel(config: SuperAgentConfig, id: string, text: SuperAgentText): string {
  if (id === 'user') return text('user')
  if (id === 'system') return text('system')
  if (id === 'all') return text('broadcast')
  return config.nodes.find(node => node.id === id)?.name ?? id
}

export function SharedBoard({ config, items, maintenance, onCommand }: {
  config: SuperAgentConfig
  items: SuperAgentBoardItem[]
  maintenance?: SuperAgentBoardMaintenance
  onCommand: (command: SuperAgentCommand) => Promise<void>
}) {
  const text = useSuperAgentText()
  const [editing, setEditing] = useState<{ id?: string; title: string; content: string; revision?: number; pinned?: boolean } | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [visible, setVisible] = useState(20)
  const [cleaned, setCleaned] = useState(false)
  const filtered = [...items].filter(item => !search.trim() || `${item.id} ${item.title} ${item.content}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)
  async function run(command: SuperAgentCommand, close = false) {
    setPending(true); setError('')
    try { await onCommand(command); if (command.type === 'board-cleanup') setCleaned(true); if (close) setEditing(null) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setPending(false) }
  }
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-4xl space-y-5 p-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{text('board')}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{text('boardHint')}</p></div>
      <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">{items.length}/{SUPER_AGENT_BOARD_LIMIT}</span>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => void run({ type: 'board-cleanup' })}><Archive className="size-3.5" />{text(maintenance?.issue ? 'retryBoardCleanup' : 'cleanupBoard')}</Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => { setError(''); setEditing({ title: '', content: '' }) }}><Plus className="size-3.5" />{text('addBoardItem')}</Button></div></div>
    <p className="text-xs leading-5 text-muted-foreground">{text('boardArchiveHint')}{maintenance?.archived ? ` ${text('boardArchived', { count: maintenance.archived })}` : ''}</p>
    {maintenance?.issue && <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5"><p>{text(maintenance.issue.code === 'archive_failed' ? 'boardArchiveFailed' : 'boardCapacityBlocked')}</p>
      {maintenance.issue.retryAt != null && <p>{text('boardRetryAt', { time: formatTimestamp(maintenance.issue.retryAt) })}</p>}</div>}
    {cleaned && maintenance?.status === 'ready' && <p role="status" className="text-xs text-muted-foreground">{text('boardCleanupResult', { count: maintenance.lastArchived })}</p>}
    {items.length > 20 && <Input value={search} aria-label={text('searchBoard')} placeholder={text('searchBoard')} onChange={event => { setSearch(event.target.value); setVisible(20) }} />}
    {items.length === 0 ? <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-border px-8 py-20 text-center"><ClipboardList className="size-9 text-muted-foreground/40" /><p className="max-w-sm text-sm leading-6 text-muted-foreground">{text('emptyBoard')}</p></div>
      : <div className="grid gap-4 lg:grid-cols-2">{filtered.slice(0, visible).map(item => <article key={item.id} className="min-w-0 rounded-xl border border-border/70 bg-background p-5">
        <div className="flex items-start gap-2">{item.pinned && <Pin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-label={text('pinBoardItem')} />}<h3 className="min-w-0 flex-1 break-words text-sm font-semibold">{item.title}</h3><Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label={text('edit')} disabled={pending} onClick={() => { setError(''); setEditing({ ...item }) }}><Pencil className="size-3.5" /></Button>
          <Button variant="ghost" size="icon" className="size-6 shrink-0 text-muted-foreground hover:text-destructive" aria-label={text('delete')} disabled={pending} onClick={() => void run({ type: 'board-delete', id: item.id, expectedRevision: item.revision })}><Trash2 className="size-3.5" /></Button></div>
        <div className="mt-3 max-h-96 overflow-y-auto text-sm leading-6"><Markdown>{item.content}</Markdown></div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-[10px] text-muted-foreground"><span>{nodeLabel(config, item.updatedBy, text)} · {formatTimestamp(item.updatedAt)}</span><span>{text('revision', { revision: item.revision })}</span></div>
      </article>)}</div>}
    {filtered.length > visible && <Button variant="outline" onClick={() => setVisible(value => value + 20)}>{text('moreBoardItems', { count: filtered.length - visible })}</Button>}
    {error && !editing && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    <Dialog open={editing !== null} onOpenChange={open => { if (!open && !pending) setEditing(null) }}>
      <DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>{text('addBoardItem')}</DialogTitle><DialogDescription>{text('boardHint')}</DialogDescription></DialogHeader>
        {editing && <fieldset disabled={pending} className="min-w-0 space-y-4"><FormField label={text('boardTitle')}><Input value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })} /></FormField>
          <FormField label={text('content')}><textarea rows={8} className={textareaClass} value={editing.content} onChange={event => setEditing({ ...editing, content: event.target.value })} /></FormField>
          <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={editing.pinned ?? false} onChange={event => setEditing({ ...editing, pinned: event.target.checked })} />{text('pinBoardItem')}</label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button type="button" variant="outline" onClick={() => setEditing(null)}>{text('cancel')}</Button><Button type="button" disabled={!editing.title.trim() || !editing.content.trim()}
            onClick={() => void run({ type: 'board-upsert', item: { id: editing.id, title: editing.title.trim(), content: editing.content, pinned: editing.pinned }, expectedRevision: editing.revision }, true)}>{pending && <LoaderCircle className="size-3.5 animate-spin" />}{text('save')}</Button></DialogFooter>
        </fieldset>}
      </DialogContent>
    </Dialog>
  </div></div>
}

export function NodeCommunication({ config, state, messages, onCommand }: {
  config: SuperAgentConfig
  state: SuperAgentState
  messages: SuperAgentMessage[]
  onCommand: (command: SuperAgentCommand) => Promise<void>
}) {
  const text = useSuperAgentText()
  const coordinator = config.nodes.find(node => node.role === 'coordinator')!
  const activeNodes = activeSuperAgentNodes(config, state)
  const [fromNodeId, setFromNodeId] = useState(coordinator.id)
  const [toNodeId, setToNodeId] = useState(hasPlanningTopology(config) ? config.nodes.find(node => node.role === 'planner')!.id : 'all')
  const senderNode = config.nodes.find(node => node.id === fromNodeId) ?? coordinator
  const targets = activeNodes.filter(node => node.id !== fromNodeId && canSuperAgentCommunicate(config, senderNode, node))
  const [body, setBody] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const communication = messages.filter(message => message.kind !== 'chat')
  useEffect(() => {
    if (!activeNodes.some(node => node.id === fromNodeId)) setFromNodeId(coordinator.id)
    if (hasPlanningTopology(config) ? !targets.some(node => node.id === toNodeId) : toNodeId !== 'all' && !activeNodes.some(node => node.id === toNodeId)) setToNodeId(hasPlanningTopology(config) ? targets[0]?.id ?? '' : 'all')
  }, [config, state, fromNodeId, toNodeId])
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
    {config.architecture !== 'dynamic' && <div className="shrink-0 border-t border-border/70 px-6 py-4">
      <div className="mx-auto max-w-3xl space-y-3">
        <div className="grid grid-cols-2 gap-3"><FormField label={text('from')}><WorkbenchSelect value={fromNodeId} onValueChange={value => { setFromNodeId(value); if (toNodeId === value) setToNodeId('all') }} options={activeNodes.map(node => ({ value: node.id, label: node.name }))} /></FormField>
          <FormField label={text('to')}><WorkbenchSelect value={toNodeId} onValueChange={value => setToNodeId(value)} options={[...(hasPlanningTopology(config) ? [] : [{ value: "all", label: text('broadcast') }]), ...targets.map(node => ({ value: node.id, label: node.name }))]} /></FormField></div>
        <div className="flex items-end gap-2"><textarea className={textareaClass + ' min-h-16 flex-1'} rows={2} value={body} placeholder={text('messageBody')} onChange={event => setBody(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
          <Button className="size-10 shrink-0 rounded-xl" size="icon" disabled={!body.trim() || pending} aria-label={text('send')} onClick={() => void send()}>{pending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</Button></div>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
    </div>}
  </div>
}
