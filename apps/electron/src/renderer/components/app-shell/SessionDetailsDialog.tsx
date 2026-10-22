import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { selectAtom } from 'jotai/utils'
import { useTranslation } from 'react-i18next'
import { SessionViewer, Spinner, usePlatform, type ActivityItem } from '@tokenbird/ui'
import {
  ensureSessionMessagesLoadedAtom, forceSessionMessagesReloadAtom, releaseSessionMessagesAtom,
  sessionAtomFamily, sessionDetailsReadersAtom, sessionMetaMapAtom,
} from '@/atoms/sessions'
import { useAppShellContext } from '@/context/AppShellContext'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function SessionDetailsDialog({ sessionId, title, description, onClose, children }: {
  sessionId: string
  title: string
  description: string
  onClose: () => void
  children?: React.ReactNode
}) {
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="flex h-[80dvh] max-h-[900px] flex-col gap-3 p-4 sm:max-w-5xl">
      <DialogHeader className="shrink-0 pr-8">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <SessionTranscriptView key={sessionId} sessionId={sessionId} className="flex-1 rounded-lg border border-foreground/10" />
      {children}
    </DialogContent>
  </Dialog>
}

/** Shared by node details and subagent details; works with hidden or retired sessions too. */
export function SessionTranscriptView({ sessionId, className }: { sessionId: string; className?: string }) {
  const { t } = useTranslation()
  const session = useAtomValue(sessionAtomFamily(sessionId))
  const meta = useAtomValue(React.useMemo(() => selectAtom(sessionMetaMapAtom, map => map.get(sessionId)), [sessionId]))
  const ensureLoaded = useSetAtom(ensureSessionMessagesLoadedAtom)
  const reload = useSetAtom(forceSessionMessagesReloadAtom)
  const release = useSetAtom(releaseSessionMessagesAtom)
  const setReaders = useSetAtom(sessionDetailsReadersAtom)
  const { onMarkSessionRead, onOpenFile, onOpenUrl } = useAppShellContext()
  const platform = usePlatform()
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)
  const [attempt, setAttempt] = React.useState(0)
  const [activity, setActivity] = React.useState<ActivityItem | null>(null)

  React.useEffect(() => {
    setReaders(previous => new Map(previous).set(sessionId, (previous.get(sessionId) ?? 0) + 1))
    return () => {
      setReaders(previous => {
        const next = new Map(previous)
        const count = (next.get(sessionId) ?? 1) - 1
        if (count > 0) next.set(sessionId, count)
        else next.delete(sessionId)
        return next
      })
      void release(sessionId)
    }
  }, [sessionId, setReaders, release])

  React.useEffect(() => {
    let active = true
    setLoading(true)
    setFailed(false)
    void (attempt ? reload(sessionId) : ensureLoaded(sessionId)).then(loaded => {
      if (active && (!loaded || (!loaded.messages.length && (loaded.messageCount ?? 0) > 0))) setFailed(true)
    }).catch(() => { if (active) setFailed(true) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [sessionId, attempt, ensureLoaded, reload])

  React.useEffect(() => {
    if (!loading && !failed && !session?.isProcessing && meta?.hasUnread) onMarkSessionRead(sessionId)
  }, [loading, failed, sessionId, session?.isProcessing, meta?.hasUnread, meta?.lastMessageAt, onMarkSessionRead])

  return <div className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden', className)}>
    {loading ? <div className="m-auto flex items-center gap-2 p-4 text-sm"><Spinner />{t('common.loading')}</div>
      : failed ? <div role="alert" className="m-auto space-y-2 p-4 text-center text-sm"><p>{t('subagents.loadFailed')}</p><Button variant="outline" onClick={() => setAttempt(value => value + 1)}>{t('common.retry')}</Button></div>
      : session?.messages.length ? <SessionViewer session={session} isProcessing={session.isProcessing} mode="readonly"
        className="min-h-0 flex-1" sessionFolderPath={session.sessionFolderPath}
        platformActions={{ ...platform, onOpenFile: platform.onOpenFile ?? onOpenFile, onOpenUrl: platform.onOpenUrl ?? onOpenUrl }} onActivityClick={setActivity} />
      : <div className="m-auto p-4 text-sm text-foreground/60">{t('subagents.empty')}</div>}
    <Dialog open={!!activity} onOpenChange={value => { if (!value) setActivity(null) }}>
      <DialogContent className="max-h-[80dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>{activity?.displayName || activity?.toolName || t('chat.session')}</DialogTitle>
          <DialogDescription>{activity?.intent || t('chat.session')}</DialogDescription></DialogHeader>
        {activity?.toolInput && <div><p className="mb-2 text-sm font-medium">{t('activity.inputParams')}</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-foreground/5 p-3 text-xs">{JSON.stringify(activity.toolInput, null, 2)}</pre></div>}
        <div><p className="mb-2 text-sm font-medium">{t('terminal.output')}</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-foreground/5 p-3 text-xs">{activity?.content || activity?.error || t('chat.noOutputYet')}</pre></div>
      </DialogContent>
    </Dialog>
  </div>
}
