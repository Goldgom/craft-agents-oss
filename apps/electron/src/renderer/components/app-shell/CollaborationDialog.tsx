import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Users } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { SessionMeta } from '@/atoms/sessions'
import { getSessionTitle } from '@/utils/session'

interface CollaborationDialogProps {
  primary: SessionMeta
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CollaborationDialog({ primary, open, onOpenChange }: CollaborationDialogProps) {
  const { t } = useTranslation()
  const [sessions, setSessions] = React.useState<SessionMeta[]>([])
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setSelected(new Set())
    void window.electronAPI
      .listCollaborationCandidates()
      .then((items: SessionMeta[]) => {
        setSessions(items.filter(item => item.id !== primary.id && !item.isArchived && !item.collaboration))
      })
      .catch(error => {
        console.error('Failed to load collaboration candidates:', error)
        toast.error(t('settings.collaborations.loadFailed'))
      })
  }, [open, primary.id, t])

  const save = async () => {
    if (!selected.size) {
      toast.error(t('settings.collaborations.secondaryRequired'))
      return
    }
    setSaving(true)
    try {
      const local = sessions
        .filter(session => selected.has(session.id))
        .map(session => ({
          sessionId: session.id,
          workspaceId: session.workspaceId,
          name: getSessionTitle(session),
        }))
      await window.electronAPI.createCollaboration(
        primary.id,
        local,
      )
      toast.success(t('settings.collaborations.started', { count: local.length }))
      onOpenChange(false)
    } catch (error) {
      console.error('Failed to create collaboration:', error)
      toast.error(t('settings.collaborations.createFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            <Users className="size-5" />
            <div>
              <DialogTitle>{t('settings.collaborations.configure')}</DialogTitle>
              <DialogDescription>
                {t('settings.collaborations.configureDesc', { title: getSessionTitle(primary) })}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-foreground/10 p-2">
          {sessions.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              {t('settings.collaborations.noLocalSessions')}
            </p>
          ) : sessions.map(session => {
            const checked = selected.has(session.id)
            return (
              <label key={session.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-foreground/5">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => setSelected(current => {
                    const next = new Set(current)
                    if (checked) next.delete(session.id)
                    else next.add(session.id)
                    return next
                  })}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{getSessionTitle(session)}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t('settings.collaborations.localWorkspace', {
                      workspaceId: session.workspaceId,
                      sessionId: session.id,
                    })}
                  </span>
                </span>
              </label>
            )
          })}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button
            disabled={saving || !selected.size}
            onClick={() => void save()}
          >
            {saving ? t('settings.collaborations.creating') : t('settings.collaborations.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
