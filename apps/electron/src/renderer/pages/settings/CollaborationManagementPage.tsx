import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArrowLeft, ChevronRight, Circle, ClipboardList, Download, File, RefreshCw, RotateCcw, Square, Users } from 'lucide-react'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppShellContext } from '@/context/AppShellContext'
import { getSessionTitle } from '@/utils/session'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { CollaborationGroup } from '@craft-agent/shared/protocol'

export const meta: DetailsPageMeta = { navigator: 'settings', slug: 'collaborations' }

type SessionLike = {
  id: string
  workspaceId?: string
  isProcessing?: boolean
  name?: string
  preview?: string
}

export default function CollaborationManagementPage() {
  const { t, i18n } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()
  const [groups, setGroups] = React.useState<CollaborationGroup[]>([])
  const [sessions, setSessions] = React.useState<SessionLike[]>([])
  const [selectedGroupId, setSelectedGroupId] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [pendingAction, setPendingAction] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    if (!activeWorkspaceId) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [nextGroups, nextSessions] = await Promise.all([
        window.electronAPI.listCollaborations(activeWorkspaceId),
        window.electronAPI.listCollaborationCandidates() as Promise<SessionLike[]>,
      ])
      setGroups(nextGroups)
      setSessions(nextSessions)
    } catch (error) {
      console.error('Failed to load collaborations:', error)
      toast.error(t('settings.collaborations.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [activeWorkspaceId, t])

  React.useEffect(() => { void refresh() }, [refresh])
  React.useEffect(
    () => window.electronAPI.onCollaborationChanged(() => { void refresh() }),
    [refresh],
  )

  const sessionMap = React.useMemo(() => new Map(sessions.map(session => [session.id, session])), [sessions])
  const selectedGroup = groups.find(group => group.id === selectedGroupId) ?? null
  const locale = i18n.resolvedLanguage ?? i18n.language
  const dateFormatter = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  )

  React.useEffect(() => {
    if (selectedGroupId && !groups.some(group => group.id === selectedGroupId)) {
      setSelectedGroupId(null)
    }
  }, [groups, selectedGroupId])

  const endCollaboration = React.useCallback(async (group: CollaborationGroup) => {
    if (!window.confirm(t('settings.collaborations.endConfirm'))) return
    const primary = group.members.find(member => member.id === group.primaryMemberId)
    if (!primary) return
    setPendingAction('end')
    try {
      const ended = await window.electronAPI.endCollaboration(group.id, primary.workspaceId)
      setGroups(current => current.map(item => item.id === ended.id ? ended : item))
    } catch (error) {
      console.error('Failed to end collaboration:', error)
      toast.error(t('settings.collaborations.endFailed'))
    } finally {
      setPendingAction(null)
    }
  }, [t])

  const retryDelivery = React.useCallback(async (group: CollaborationGroup, operationId: string) => {
    const primary = group.members.find(member => member.id === group.primaryMemberId)
    if (!primary) return
    setPendingAction(operationId)
    try {
      const result = await window.electronAPI.retryCollaborationDelivery(group.id, primary.workspaceId, operationId)
      setGroups(current => current.map(item => item.id === result.group.id ? result.group : item))
    } catch (error) {
      console.error('Failed to retry collaboration delivery:', error)
      toast.error(t('settings.collaborations.retryFailed'))
      await refresh()
    } finally {
      setPendingAction(null)
    }
  }, [refresh, t])

  const downloadFile = React.useCallback(async (group: CollaborationGroup, fileId: string) => {
    const primary = group.members.find(member => member.id === group.primaryMemberId)
    if (!primary) return
    setPendingAction(fileId)
    try {
      const result = await window.electronAPI.getCollaborationFile(group.id, primary.workspaceId, fileId)
      const bytes = Uint8Array.from(atob(result.dataBase64), character => character.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: result.file.contentType ?? 'application/octet-stream' }))
      const link = document.createElement('a')
      link.href = url
      link.download = result.file.name
      link.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Failed to download collaboration file:', error)
      toast.error(t('settings.collaborations.downloadFailed'))
    } finally {
      setPendingAction(null)
    }
  }, [t])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title={t('settings.collaborations.title')}
        actions={(
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label={t('common.refresh')}
          >
            <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} />
          </Button>
        )}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-4xl space-y-4 p-4 md:p-6">
          <div className="rounded-lg border border-foreground/10 bg-background/50 p-4 text-sm text-muted-foreground">
            {t('settings.collaborations.info')}
          </div>

          {!groups.length && !loading && (
            <div className="rounded-lg border border-dashed border-foreground/15 p-10 text-center text-sm text-muted-foreground">
              <Users className="mx-auto mb-2 size-8 opacity-50" />
              {t('settings.collaborations.empty')}
            </div>
          )}

          {!selectedGroup ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {groups.map(group => {
                const primary = group.members.find(member => member.role === 'primary')!
                const primarySession = sessionMap.get(primary.sessionId)
                const secondaryCount = group.members.length - 1
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => setSelectedGroupId(group.id)}
                    className="group rounded-xl border border-foreground/10 bg-background/50 p-4 text-left transition hover:border-foreground/25 hover:bg-foreground/[0.03]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="mb-1 flex items-center gap-2">
                          <Users className="size-4 text-accent" />
                          <span className="font-medium">
                            {primarySession
                              ? getSessionTitle(primarySession as never)
                              : (primary.name ?? primary.sessionId)}
                          </span>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {t('settings.collaborations.primarySummary', { count: secondaryCount })}
                        </p>
                      </div>
                      <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5" />
                    </div>
                    <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{t('settings.collaborations.revision', { revision: group.revision })}</span>
                      <span>{dateFormatter.format(new Date(group.updatedAt))}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            <section className="rounded-xl border border-foreground/10 p-4">
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 mb-3"
                onClick={() => setSelectedGroupId(null)}
              >
                <ArrowLeft className="mr-1 size-4" />
                {t('settings.collaborations.backToList')}
              </Button>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-medium">
                    {t('settings.collaborations.group', { id: selectedGroup.id })}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {t('settings.collaborations.revision', { revision: selectedGroup.revision })}
                    {' · '}
                    {t('settings.collaborations.updatedAt', {
                      date: dateFormatter.format(new Date(selectedGroup.updatedAt)),
                    })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={groupStatusClass(selectedGroup.status)}>
                    {selectedGroup.status === 'ended'
                      ? t('settings.collaborations.ended')
                      : t('settings.collaborations.active')}
                  </span>
                  {selectedGroup.status !== 'ended'
                    && selectedGroup.members.find(member => member.id === selectedGroup.primaryMemberId)?.workspaceId === activeWorkspaceId
                    && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pendingAction === 'end'}
                      onClick={() => void endCollaboration(selectedGroup)}
                    >
                      <Square className="mr-1 size-3.5" />
                      {t('settings.collaborations.end')}
                    </Button>
                  )}
                </div>
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {selectedGroup.members.map(member => {
                  const session = sessionMap.get(member.sessionId)
                  const title = session
                    ? getSessionTitle(session as never)
                    : (member.name ?? member.sessionId)
                  return (
                    <div key={member.id} className="rounded-md border border-foreground/10 p-3">
                      <div className="flex items-center gap-2">
                        <Circle className={`size-2.5 ${session ? 'fill-emerald-500 text-emerald-500' : 'fill-muted text-muted-foreground'}`} />
                        <span className="font-medium">{title}</span>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {member.role === 'primary'
                            ? t('settings.collaborations.primaryRole')
                            : t('settings.collaborations.secondaryRole')}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {member.workspaceId}
                        {member.serverUrl ? ` · ${member.serverUrl}` : ''}
                        {session?.isProcessing ? ` · ${t('settings.collaborations.processing')}` : ''}
                      </p>
                    </div>
                  )
                })}
              </div>
              <div className="mt-4 flex gap-4 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <ClipboardList className="size-3.5" />
                  {t('settings.collaborations.boardItems', { count: Object.keys(selectedGroup.board).length })}
                </span>
                <span className="inline-flex items-center gap-1">
                  <File className="size-3.5" />
                  {t('settings.collaborations.files', { count: Object.keys(selectedGroup.files).length })}
                </span>
                <span>{t('settings.collaborations.events', { count: selectedGroup.events.length })}</span>
              </div>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <section className="rounded-md border border-foreground/10 p-3">
                  <h3 className="mb-2 text-sm font-medium">
                    {t('settings.collaborations.boardItems', { count: Object.keys(selectedGroup.board).length })}
                  </h3>
                  <div className="space-y-2">
                    {Object.values(selectedGroup.board).map(item => (
                      <div key={item.id} className="rounded bg-foreground/[0.03] p-2">
                        <div className="text-xs font-medium">{item.id}</div>
                        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                          {JSON.stringify(item.value, null, 2)}
                        </pre>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="rounded-md border border-foreground/10 p-3">
                  <h3 className="mb-2 text-sm font-medium">
                    {t('settings.collaborations.files', { count: Object.keys(selectedGroup.files).length })}
                  </h3>
                  <div className="space-y-2">
                    {Object.values(selectedGroup.files).map(file => (
                      <button
                        key={file.id}
                        type="button"
                        className="flex w-full items-center gap-2 rounded bg-foreground/[0.03] p-2 text-left text-xs hover:bg-foreground/[0.06]"
                        disabled={pendingAction === file.id}
                        onClick={() => void downloadFile(selectedGroup, file.id)}
                      >
                        <Download className="size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{file.name}</span>
                        <span className="text-muted-foreground">{Math.ceil(file.size / 1024)} KB</span>
                      </button>
                    ))}
                  </div>
                </section>
              </div>
              <section className="mt-4 rounded-md border border-foreground/10 p-3">
                <h3 className="mb-2 text-sm font-medium">
                  {t('settings.collaborations.events', { count: selectedGroup.events.length })}
                </h3>
                <div className="max-h-80 space-y-2 overflow-auto">
                  {[...selectedGroup.events].reverse().map(event => (
                    <div key={event.id} className="rounded bg-foreground/[0.03] p-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{event.type}</span>
                        <span className="text-muted-foreground">#{event.revision}</span>
                        {event.delivery && (
                          <span className="ml-auto text-muted-foreground">{event.delivery.status}</span>
                        )}
                        {selectedGroup.status === 'active' && event.delivery?.status === 'failed' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pendingAction === event.operationId}
                            onClick={() => void retryDelivery(selectedGroup, event.operationId)}
                          >
                            <RotateCcw className="mr-1 size-3.5" />
                            {t('common.retry')}
                          </Button>
                        )}
                      </div>
                      {event.text && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{event.text}</p>}
                      {event.delivery?.lastError && <p className="mt-1 text-destructive">{event.delivery.lastError}</p>}
                    </div>
                  ))}
                </div>
              </section>
            </section>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function groupStatusClass(status: CollaborationGroup['status']): string {
  return status === 'ended'
    ? 'rounded-full bg-foreground/5 px-2 py-1 text-xs text-muted-foreground'
    : 'rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-emerald-600'
}
