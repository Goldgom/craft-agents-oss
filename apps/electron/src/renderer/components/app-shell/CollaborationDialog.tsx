import * as React from 'react'
import { Users } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import type { SessionMeta } from '@/atoms/sessions'
import { getSessionTitle } from '@/utils/session'

export function CollaborationDialog({ primary, open, onOpenChange }: { primary: SessionMeta; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [sessions, setSessions] = React.useState<SessionMeta[]>([])
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [saving, setSaving] = React.useState(false)
  React.useEffect(() => {
    if (!open) return
    setSelected(new Set())
    void window.electronAPI.getSessions().then((items: SessionMeta[]) => setSessions(items.filter(item => item.id !== primary.id && !item.isArchived))).catch(error => toast.error(error instanceof Error ? error.message : 'Unable to load sessions'))
  }, [open, primary.id])
  const save = async () => {
    if (!selected.size) return toast.error('Select at least one secondary session')
    setSaving(true)
    try {
      const targets = sessions.filter(session => selected.has(session.id)).map(session => ({ sessionId: session.id, workspaceId: session.workspaceId, name: getSessionTitle(session) }))
      await window.electronAPI.createCollaboration(primary.id, targets)
      toast.success(`Collaboration started with ${targets.length} session${targets.length === 1 ? '' : 's'}`)
      onOpenChange(false)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Unable to create collaboration') } finally { setSaving(false) }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-xl">
    <div className="flex items-center gap-2 pr-8"><Users className="size-5" /><div><h2 className="text-base font-semibold">Configure collaboration</h2><p className="text-sm text-muted-foreground">{getSessionTitle(primary)} is the primary session. Selected sessions report back to it.</p></div></div>
    <div className="max-h-80 space-y-1 overflow-y-auto rounded-md border border-foreground/10 p-2">
      {sessions.length === 0 ? <p className="p-3 text-sm text-muted-foreground">No other active sessions in this workspace.</p> : sessions.map(session => { const checked = selected.has(session.id); return <label key={session.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-foreground/5"><input type="checkbox" checked={checked} onChange={() => setSelected(current => { const next = new Set(current); if (checked) next.delete(session.id); else next.add(session.id); return next })} /><span className="min-w-0"><span className="block truncate text-sm font-medium">{getSessionTitle(session)}</span><span className="block truncate text-xs text-muted-foreground">{session.id}</span></span></label> })}
    </div>
    <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={saving || !selected.size} onClick={() => void save()}>{saving ? 'Creating…' : 'Start collaboration'}</Button></div>
  </DialogContent></Dialog>
}
