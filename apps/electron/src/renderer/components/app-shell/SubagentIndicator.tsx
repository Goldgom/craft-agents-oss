import * as React from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, GitFork } from 'lucide-react'
import { Spinner } from '@tokenbird/ui'
import {
  sessionMetaMapAtom, subagentSessionsAtomFamily,
} from '@/atoms/sessions'
import type { SessionMeta } from '@/atoms/sessions'
import { getSessionTitle } from '@/utils/session'
import { subagentState } from '@/lib/session-subagents'
import { navigate, routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SessionTranscriptView } from './SessionDetailsDialog'

/** Notifications and deep links can still open a child directly. Keep its owner one click away. */
export function SubagentParentLink({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const sessions = useAtomValue(sessionMetaMapAtom)
  const child = sessions.get(sessionId)
  const parent = child?.parentSessionId ? sessions.get(child.parentSessionId) : undefined
  if (!parent || parent.hidden || parent.id === sessionId || parent.workspaceId !== child?.workspaceId) return null
  return <button type="button" title={getSessionTitle(parent)} aria-label={t('subagents.backToParent')}
    className="inline-flex items-center rounded-md p-1.5 text-foreground/60 hover:bg-foreground/10"
    onClick={() => navigate(routes.view.allSessions(parent.id))}><ArrowLeft className="size-4" /></button>
}

/** Both the parent row and chat header open the same details surface. */
export function SubagentIndicator({ sessionId, inList = false }: { sessionId: string; inList?: boolean }) {
  const { t } = useTranslation()
  const children = useAtomValue(subagentSessionsAtomFamily(sessionId))
  const [open, setOpen] = React.useState(false)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const selected = children.find(child => child.id === selectedId) ?? children[0]
  if (!children.length) return null
  const running = children.some(child => child.isProcessing)
  const unread = children.some(child => child.hasUnread)
  const label = t('subagents.dispatched', { count: children.length })

  return (
    <div className={inList ? 'relative px-8 pb-2 -mt-1' : 'flex items-center'}>
      <button
        type="button"
        className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs hover:bg-foreground/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
          running || unread ? 'text-accent' : 'text-foreground/60')}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerDown={event => event.stopPropagation()}
        onMouseDown={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); setOpen(true) }}
      >
        <GitFork className="size-3.5" />
        <span>{children.length}</span>
        {running ? <Spinner className="text-[10px]" /> : unread ? <span className="size-1.5 rounded-full bg-accent" /> : null}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[80dvh] max-h-[900px] flex-col gap-3 sm:max-w-5xl p-4">
          <DialogHeader className="shrink-0 pr-8">
            <DialogTitle className="flex items-center gap-2"><GitFork className="size-4" />{t('subagents.title')}</DialogTitle>
            <DialogDescription>{t('subagents.description')}</DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] sm:grid-rows-1 sm:grid-cols-[220px_minmax(0,1fr)] gap-3">
            <div className="max-h-32 sm:max-h-none overflow-y-auto space-y-1" aria-label={t('subagents.title')}>
              {children.map(child => (
                <button key={child.id} type="button" onClick={() => setSelectedId(child.id)}
                  aria-pressed={selected?.id === child.id}
                  className={cn('w-full rounded-lg p-2 text-left hover:bg-foreground/5', selected?.id === child.id && 'bg-foreground/5 ring-1 ring-inset ring-foreground/10')}>
                  <div className="truncate text-sm">{getSessionTitle(child)}</div>
                  <div className="mt-1 flex items-center gap-1 text-xs text-foreground/60">
                    {child.isProcessing && <Spinner className="text-[10px]" />}
                    {t(`subagents.state.${subagentState(child)}`)}
                    {child.hasUnread && <span className="size-1.5 rounded-full bg-accent" />}
                  </div>
                </button>
              ))}
            </div>
            {open && selected && <SubagentTranscript key={selected.id} meta={selected} />}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SubagentTranscript({ meta }: { meta: SessionMeta }) {
  const { t } = useTranslation()
  return <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-foreground/10">
    <div className="shrink-0 border-b border-foreground/10 p-3">
      <div className="text-sm font-medium break-words">{getSessionTitle(meta)}</div>
      <div className="mt-1 text-xs text-foreground/60">{t(`subagents.state.${subagentState(meta)}`)}{meta.model ? ` · ${meta.model}` : ''}</div>
      <SubagentIndicator sessionId={meta.id} />
    </div>
    <SessionTranscriptView sessionId={meta.id} className="flex-1" />
  </div>
}
