import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { CollaborationRelayStatus } from '@craft-agent/shared/protocol'
import { Button } from '@/components/ui/button'

export function RelayGroupManagement({ workspaceId }: { workspaceId: string | null }) {
  const { t } = useTranslation()
  const [groups, setGroups] = React.useState<CollaborationRelayStatus[]>([])
  const [error, setError] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [confirm, setConfirm] = React.useState<string | null>(null)
  const generation = React.useRef(0)
  const actionBusy = React.useRef(false)
  const available = typeof window.electronAPI.listMultiServerCollaborations === 'function'
  const refresh = React.useCallback(async () => {
    const own = ++generation.current
    if (!workspaceId || !available) { setGroups([]); return }
    setLoading(true)
    try {
      const next = await window.electronAPI.listMultiServerCollaborations()
      if (own === generation.current) { setGroups(next); setError(false) }
    } catch { if (own === generation.current) setError(true) }
    finally { if (own === generation.current) setLoading(false) }
  }, [workspaceId, available])
  React.useEffect(() => {
    setGroups([]); setConfirm(null); setError(false)
    void refresh()
    return () => { generation.current++ }
  }, [refresh])
  React.useEffect(() => {
    if (!available || !workspaceId || error) return
    const timer = setInterval(() => { if (!document.hidden && !actionBusy.current) void refresh() }, 5000)
    return () => clearInterval(timer)
  }, [available, workspaceId, error, refresh])

  const end = async (group: CollaborationRelayStatus) => {
    if (actionBusy.current) return
    actionBusy.current = true; setBusy(true)
    const own = generation.current
    try {
      const next = await window.electronAPI.endMultiServerCollaboration({ operationId: group.operationId })
      if (own !== generation.current) return
      setGroups(items => items.map(item => item.operationId === next.operationId ? next : item))
      setConfirm(null)
      if (next.warnings?.some(warning => warning.code === 'END_PENDING')) toast.warning(t('settings.collaborations.relayEndPending'))
      else toast.success(t('settings.collaborations.relayEnded'))
    } catch { if (own === generation.current) toast.error(t('settings.collaborations.endFailed')) }
    finally { actionBusy.current = false; setBusy(false) }
  }
  const download = async (group: CollaborationRelayStatus, fileId: string) => {
    if (actionBusy.current) return
    actionBusy.current = true; setBusy(true)
    const own = generation.current
    try {
      const result = await window.electronAPI.getCollaborationRelayFile({ operationId: group.operationId }, fileId)
      if (own !== generation.current) return
      const bytes = Uint8Array.from(atob(result.dataBase64), character => character.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: result.file.contentType ?? 'application/octet-stream' }))
      try {
        const link = document.createElement('a'); link.href = url; link.download = result.file.name; link.click()
      } finally { URL.revokeObjectURL(url) }
    } catch { if (own === generation.current) toast.error(t('settings.collaborations.downloadFailed')) }
    finally { actionBusy.current = false; setBusy(false) }
  }
  if (!available) return null
  const labels = {
    preparing: t('settings.collaborations.relayPreparing'), committing: t('settings.collaborations.relayCommitting'),
    active: t('settings.collaborations.relayActive'), paused: t('settings.collaborations.relayPaused'),
    aborting: t('settings.collaborations.relayAborting'), aborted: t('settings.collaborations.relayAborted'), ended: t('settings.collaborations.relayEndedState'),
  }
  return <section className="space-y-3 rounded-lg border border-foreground/15 p-4" aria-label={t('settings.collaborations.relayGroups')}>
    <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">{t('settings.collaborations.relayGroups')}</h2><Button variant="ghost" disabled={busy || loading} onClick={() => void refresh()}>{t('common.refresh')}</Button></div>
    <p className="text-xs text-muted-foreground">{t('settings.collaborations.relayDesktopRequired')}</p>
    {error && <p role="alert" className="text-sm text-destructive">{t('settings.collaborations.relayLoadFailed')}</p>}
    {!error && !loading && !groups.length && <p className="text-sm text-muted-foreground">{t('settings.collaborations.relayNoGroups')}</p>}
    {groups.map(status => <article key={status.operationId} className="space-y-2 rounded-md border border-foreground/10 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{status.groupId}</span><span>{labels[status.state]}</span></div>
      <p className="text-xs text-muted-foreground">{t('settings.collaborations.relayPendingCounts', { deliveries: status.pendingDeliveries, operations: status.pendingOperations })}</p>
      <p className="text-xs text-muted-foreground">{t('settings.collaborations.relayLastSynced')}: {status.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString() : '—'}</p>
      {!!status.warnings?.length && <p role="status" className="text-xs text-muted-foreground">{status.warnings.some(warning => warning.code === 'END_PENDING') ? t('settings.collaborations.relayEndPending') : t('settings.collaborations.relayRetryHint')}</p>}
      {status.group?.members.map(member => <p key={member.id} className="break-all text-xs">{member.name ?? member.sessionId} · {member.serverId} · {member.workspaceId} · {member.sessionId}</p>)}
      {!!status.group && <details><summary className="cursor-pointer text-xs">{t('settings.collaborations.relaySharedState')}</summary>
        <div className="space-y-2 pt-2">{Object.entries(status.group.board).map(([id, item]) => <pre key={id} className="whitespace-pre-wrap break-all text-xs">{id}: {JSON.stringify(item.value).slice(0, 4000)}</pre>)}</div>
        <div>{Object.values(status.group.files).map(file => <Button key={file.id} variant="ghost" disabled={busy} onClick={() => void download(status, file.id)}>{file.name} ({file.size})</Button>)}</div>
      </details>}
      {status.canEnd && status.state !== 'aborted' && <Button variant="outline" disabled={busy} onClick={() => setConfirm(status.operationId)}>{t('settings.collaborations.relayEnd')}</Button>}
      {confirm === status.operationId && <div role="alert" className="space-y-2"><p>{t('settings.collaborations.relayEndConfirm')}</p><Button variant="destructive" disabled={busy} onClick={() => void end(status)}>{t('settings.collaborations.relayConfirmEnd')}</Button><Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>{t('common.cancel')}</Button></div>}
    </article>)}
  </section>
}
