import { WorkbenchSelect } from '@/components/ui/workbench-select'
import { useState } from 'react'
import { ClipboardList, LoaderCircle, Pencil, Plus, Trash2 } from 'lucide-react'
import type { SuperAgentCommand, SuperAgentPlanItem } from '@craft-agent/shared/super-agent'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FormField, textareaClass } from './SuperAgentForms'
import { formatTimestamp, useSuperAgentText } from './super-agent-ui'

type PlanDraft = Extract<SuperAgentCommand, { type: 'plan-upsert' }>['item'] & { revision: number }
const statuses = ['planned', 'active', 'blocked', 'completed', 'cancelled'] as const

export function SuperAgentPlans({ items, onCommand }: {
  items: SuperAgentPlanItem[]
  onCommand: (command: SuperAgentCommand) => Promise<void>
}) {
  const text = useSuperAgentText()
  const [editing, setEditing] = useState<PlanDraft | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function run(command: SuperAgentCommand, close = false) {
    setPending(true); setError('')
    try { await onCommand(command); if (close) setEditing(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }
  return <div className="h-full min-h-0 overflow-y-auto"><div className="mx-auto max-w-3xl space-y-5 p-6">
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{text('plans')}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{text('planHint')}</p></div>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => { setError(''); setEditing({ title: '', instructions: '', status: 'planned', priority: 3, note: '', revision: 0 }) }}><Plus className="size-3.5" />{text('addPlan')}</Button></div>
    {!items.length && <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border p-12 text-center"><ClipboardList className="size-8 text-muted-foreground/40" /><p className="text-sm text-muted-foreground">{text('noPlans')}</p></div>}
    {[...items].sort((a, b) => Number(['completed', 'cancelled'].includes(a.status)) - Number(['completed', 'cancelled'].includes(b.status)) || a.priority - b.priority || a.updatedAt - b.updatedAt).map(item => <article key={item.id} className="space-y-3 rounded-xl border border-border/70 p-5">
      <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><h3 className="break-words text-sm font-semibold">{item.title}</h3><p className="mt-1 text-xs text-muted-foreground">{text(item.status)} · {text('priority')}: {item.priority}</p></div>
        <Button variant="ghost" size="icon" aria-label={text('edit')} disabled={pending} onClick={() => { setError(''); setEditing({ ...item }) }}><Pencil className="size-3.5" /></Button>
        <Button variant="ghost" size="icon" aria-label={text('delete')} disabled={pending} onClick={() => void run({ type: 'plan-delete', id: item.id, expectedRevision: item.revision })}><Trash2 className="size-3.5" /></Button></div>
      <p className="whitespace-pre-wrap break-words text-xs leading-5">{item.instructions}</p>
      {item.note && <p className="whitespace-pre-wrap break-words rounded-lg bg-foreground/5 p-3 text-xs leading-5 text-muted-foreground">{item.note}</p>}
      <p className="text-[10px] text-muted-foreground">{formatTimestamp(item.updatedAt)} · {text('revision', { revision: item.revision })}</p>
    </article>)}
    {error && !editing && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Dialog open={editing !== null} onOpenChange={open => { if (!open && !pending) setEditing(null) }}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>{text('plans')}</DialogTitle><DialogDescription>{text('planHint')}</DialogDescription></DialogHeader>
      {editing && <fieldset disabled={pending} className="min-w-0 space-y-4">
        <FormField label={text('taskTitle')}><Input maxLength={120} value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })} /></FormField>
        <FormField label={text('taskInstructions')}><textarea rows={5} maxLength={32000} className={textareaClass} value={editing.instructions} onChange={event => setEditing({ ...editing, instructions: event.target.value })} /></FormField>
        <div className="grid grid-cols-2 gap-4"><FormField label={text('planStatus')}><WorkbenchSelect value={editing.status} onValueChange={value => setEditing({ ...editing, status: value as PlanDraft['status'] })} options={[...statuses.map(status => ({ value: status, label: text(status) }))]} /></FormField>
          <FormField label={text('priority')}><WorkbenchSelect value={editing.priority} onValueChange={value => setEditing({ ...editing, priority: Number(value) })} options={[...[1, 2, 3, 4, 5].map(value => ({ value: value, label: value }))]} /></FormField></div>
        <FormField label={text('planNote')}><textarea rows={3} maxLength={4000} className={textareaClass} value={editing.note} onChange={event => setEditing({ ...editing, note: event.target.value })} /></FormField>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={() => setEditing(null)}>{text('cancel')}</Button><Button disabled={!editing.title.trim() || !editing.instructions.trim()} onClick={() => void run({ type: 'plan-upsert', item: { id: editing.id, title: editing.title.trim(), instructions: editing.instructions.trim(), status: editing.status, priority: editing.priority, note: editing.note }, expectedRevision: editing.revision }, true)}>{pending && <LoaderCircle className="size-3.5 animate-spin" />}{text('save')}</Button></DialogFooter>
      </fieldset>}
    </DialogContent></Dialog>
  </div></div>
}
