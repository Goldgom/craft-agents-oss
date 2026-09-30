import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import type { CollaborationRelayCandidate, CollaborationRelayCreateResult, CollaborationSetupContext, CollaborationWorkspace } from '@craft-agent/shared/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { SessionMeta } from '@/atoms/sessions'
import { getSessionTitle } from '@/utils/session'
import { MAX_COLLABORATORS } from './collaboration-selection'
import { collaborationBasketFingerprint, collaborationRelaySessionKey, collaborationServerKey, type CollaborationBasketRow } from './collaboration-relay-selection'

const selectClass = 'h-9 w-full rounded-md border border-foreground/15 bg-background px-2 text-sm disabled:opacity-50'

export function MultiServerCollaborationDialog({ primary, open, onOpenChange }: {
  primary: SessionMeta
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [context, setContext] = React.useState<CollaborationSetupContext | null>(null)
  const [serverKey, setServerKey] = React.useState('local')
  const [workspaces, setWorkspaces] = React.useState<CollaborationWorkspace[]>([])
  const [workspaceId, setWorkspaceId] = React.useState('')
  const [candidates, setCandidates] = React.useState<CollaborationRelayCandidate[]>([])
  const [basket, setBasket] = React.useState<CollaborationBasketRow[]>([])
  const [search, setSearch] = React.useState('')
  const [newName, setNewName] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [reload, setReload] = React.useState(0)
  const [setupRetry, setSetupRetry] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [recovery, setRecovery] = React.useState<CollaborationRelayCreateResult | null>(null)
  const [uncertain, setUncertain] = React.useState(false)
  const [confirmEnd, setConfirmEnd] = React.useState(false)
  const busyRef = React.useRef(false)
  const generation = React.useRef(0)
  const catalogServer = React.useRef<string | null>(null)
  const operation = React.useRef<{ fingerprint: string; id: string } | null>(null)
  const selectedServer = context?.servers.find(item => collaborationServerKey(item.server) === serverKey)
  const recovering = uncertain || (!!recovery && !['aborted', 'ended'].includes(recovery.state))
  const recoveryOperationId = recovery?.operationId ?? operation.current?.id
  const locked = busy || recovering

  React.useEffect(() => {
    const own = ++generation.current
    if (!open) return
    setContext(null); setBasket([]); setRecovery(null); setUncertain(false); setConfirmEnd(false)
    setBusy(busyRef.current)
    setWorkspaces([]); setCandidates([]); setWorkspaceId(''); setSearch(''); setNewName('')
    operation.current = null
    setLoading(true); setError(false)
    void window.electronAPI.getCollaborationSetupContext(primary.id).then(value => {
      if (own !== generation.current) return
      setContext(value)
      setServerKey(collaborationServerKey(value.primary.server))
      const pending = value.pendingCreations.find(item => !['aborted', 'ended'].includes(item.state))
      if (pending) {
        setRecovery(pending)
        operation.current = { fingerprint: collaborationBasketFingerprint(pending.secondaries), id: pending.operationId }
        setBasket(pending.secondaries.map((selection, index) => ({
          key: selection.createNew ? `pending:${pending.operationId}:${index}` : collaborationRelaySessionKey({ ...selection, sessionId: selection.sessionId! }),
          selection,
          serverName: value.servers.find(item => collaborationServerKey(item.server) === collaborationServerKey(selection.server))?.name ?? t('settings.collaborations.server'),
          workspaceName: selection.workspaceId,
          name: selection.name ?? (selection.createNew ? t('settings.collaborations.defaultNewName', { count: index + 1 }) : selection.sessionId!),
        })))
      }
    }).catch(() => { if (own === generation.current) { setError(true); setLoading(false) } })
    return () => { generation.current++ }
  }, [open, primary.id, primary.workspaceId, setupRetry, t])

  React.useEffect(() => {
    if (!open || !context || !selectedServer) return
    let active = true
    catalogServer.current = null
    setWorkspaces([]); setWorkspaceId(''); setCandidates([]); setSearch(''); setNewName('')
    setLoading(true); setError(false)
    void window.electronAPI.listCollaborationRelayWorkspaces(selectedServer.server).then(items => {
      if (!active) return
      catalogServer.current = serverKey
      setWorkspaces(items)
      const preferred = collaborationServerKey(context.primary.server) === serverKey ? context.primary.workspaceId : ''
      setWorkspaceId(items.some(item => item.id === preferred) ? preferred : items[0]?.id ?? '')
      if (!items.length) setLoading(false)
    }).catch(() => { if (active) { setError(true); setLoading(false) } })
    return () => { active = false }
  }, [open, context, selectedServer, serverKey, reload])

  React.useEffect(() => {
    if (!open || !selectedServer || !workspaceId || catalogServer.current !== serverKey || !workspaces.some(item => item.id === workspaceId)) return
    let active = true
    setCandidates([]); setLoading(true); setError(false)
    void window.electronAPI.listCollaborationRelayCandidates(selectedServer.server, workspaceId).then(items => {
      if (!active) return
      setCandidates(items.filter(item => item.workspaceId === workspaceId && collaborationServerKey(item.server) === serverKey))
    }).catch(() => { if (active) setError(true) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [open, selectedServer, serverKey, workspaceId, workspaces])

  const primaryKey = context && collaborationRelaySessionKey(context.primary)
  const visible = candidates.filter(item => collaborationRelaySessionKey(item) !== primaryKey
    && `${item.name ?? ''} ${item.sessionId}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const selectedKeys = new Set(basket.map(item => item.key))
  const workspaceName = workspaces.find(item => item.id === workspaceId)?.name ?? workspaceId
  const stateLabels = {
    preparing: t('settings.collaborations.relayPreparing'), committing: t('settings.collaborations.relayCommitting'),
    active: t('settings.collaborations.relayActive'), aborting: t('settings.collaborations.relayAborting'),
    aborted: t('settings.collaborations.relayAborted'), ended: t('settings.collaborations.relayEndedState'),
    paused: t('settings.collaborations.relayPaused'),
  }

  const showResult = (result: CollaborationRelayCreateResult) => {
    setUncertain(false)
    setRecovery(result)
    if (result.state === 'active') {
      if (result.activationStatus === 'failed') toast.warning(t('settings.collaborations.activationFailed'), { description: t('settings.collaborations.activationFailedHint') })
      else toast.success(t('settings.collaborations.started', { count: result.memberCount - 1 }))
      onOpenChange(false)
    } else if (result.state === 'ended' || result.state === 'aborted') {
      setRecovery(null); setBasket([]); operation.current = null; setConfirmEnd(false)
      toast.success(t('settings.collaborations.relayEnded'))
    }
  }

  const run = async (action: () => Promise<CollaborationRelayCreateResult>, creating = false) => {
    if (busyRef.current) return
    const own = generation.current
    busyRef.current = true; setBusy(true)
    try { const result = await action(); if (own === generation.current) showResult(result) }
    catch { if (own === generation.current) {
      if (creating) setUncertain(true)
      toast.error(t('settings.collaborations.createFailed'), { description: t('settings.collaborations.relayRetryHint') })
    } }
    finally { busyRef.current = false; setBusy(false) }
  }

  const save = () => {
    if (!context || !basket.length || basket.length > MAX_COLLABORATORS || (!recovering && (loading || error))) return
    const secondaries = basket.map(item => item.selection)
    const fingerprint = collaborationBasketFingerprint(secondaries)
    if (!operation.current || operation.current.fingerprint !== fingerprint) operation.current = { fingerprint, id: crypto.randomUUID() }
    const operationId = operation.current.id
    void run(() => window.electronAPI.createMultiServerCollaboration({ contextId: context.contextId, operationId, secondaries }), true)
  }

  return <Dialog open={open} onOpenChange={value => { if (!busyRef.current) onOpenChange(value) }}>
    <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
      <DialogHeader><div className="flex items-center gap-2 pr-8"><Users className="size-5" /><div>
        <DialogTitle>{t('settings.collaborations.configure')}</DialogTitle>
        <DialogDescription>{t('settings.collaborations.configureDesc', { title: getSessionTitle(primary) })}</DialogDescription>
      </div></div></DialogHeader>
      <p className="text-sm" data-testid="fixed-collaboration-primary">{t('settings.collaborations.primaryRole')}: {context?.primary.sessionName ?? getSessionTitle(primary)}{context ? ` · ${context.primary.serverName} · ${context.primary.workspaceName}` : ''}</p>
      <p className="text-xs text-muted-foreground">{t('settings.collaborations.relayDesktopRequired')}</p>
      {recovering && <div role="status" className="space-y-2 rounded-md border border-foreground/15 p-3 text-sm">
        <p>{uncertain ? t('settings.collaborations.relayUnknownOutcome') : t('settings.collaborations.relayRecovery', { state: stateLabels[recovery!.state] })}</p>
        <p className="text-xs text-muted-foreground">{t('settings.collaborations.relayRetryHint')}</p>
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy || !recoveryOperationId} onClick={() => void run(() => window.electronAPI.getCollaborationRelayStatus({ operationId: recoveryOperationId! }))}>{t('settings.collaborations.relayCheckStatus')}</Button>
          {recoveryOperationId && <Button variant="ghost" disabled={busy} onClick={() => setConfirmEnd(true)}>{t('settings.collaborations.relayEnd')}</Button>}
        </div>
        {confirmEnd && <div role="alert"><p>{t('settings.collaborations.relayEndConfirm')}</p><Button variant="destructive" disabled={busy || !recoveryOperationId} onClick={() => void run(() => window.electronAPI.endMultiServerCollaboration({ operationId: recoveryOperationId! }))}>{t('settings.collaborations.relayEnd')}</Button><Button variant="ghost" disabled={busy} onClick={() => setConfirmEnd(false)}>{t('common.cancel')}</Button></div>}
      </div>}
      <label className="space-y-1 text-sm"><span>{t('settings.collaborations.server')}</span>
        <select aria-label={t('settings.collaborations.server')} className={selectClass} value={serverKey} disabled={locked || !context} onChange={event => setServerKey(event.target.value)}>
          {context?.servers.map(item => <option key={collaborationServerKey(item.server)} value={collaborationServerKey(item.server)} disabled={!item.credentialAvailable}>{item.name}</option>)}
        </select>
      </label>
      <label className="space-y-1 text-sm"><span>{t('settings.collaborations.workspace')}</span>
        <select aria-label={t('settings.collaborations.workspace')} className={selectClass} value={workspaceId} disabled={locked || !workspaces.length} onChange={event => setWorkspaceId(event.target.value)}>
          {!workspaces.length && <option value="">{t('settings.collaborations.noWorkspaces')}</option>}
          {workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      {error ? <div role="alert" className="text-sm text-destructive">{t('settings.collaborations.loadFailed')}<Button variant="ghost" disabled={busy} onClick={() => context ? setReload(value => value + 1) : setSetupRetry(value => value + 1)}>{t('settings.collaborations.reload')}</Button></div>
        : loading ? <p role="status" className="text-sm text-muted-foreground">{t('settings.collaborations.loading')}</p> : <>
          <Input value={search} onChange={event => setSearch(event.target.value)} placeholder={t('settings.collaborations.searchSessions')} aria-label={t('settings.collaborations.searchSessions')} disabled={locked} />
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-foreground/10 p-2">
            {!visible.length ? <p className="p-3 text-sm text-muted-foreground">{t('settings.collaborations.noLocalSessions')}</p> : visible.map(item => {
              const key = collaborationRelaySessionKey(item)
              const checked = selectedKeys.has(key)
              return <label key={key} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-foreground/5">
                <input type="checkbox" checked={checked} disabled={locked || !!item.unavailableReason || (!checked && basket.length >= MAX_COLLABORATORS)} onChange={() => setBasket(current => checked ? current.filter(row => row.key !== key) : [...current, { key, selection: { server: item.server, workspaceId: item.workspaceId, sessionId: item.sessionId, name: item.name }, name: item.name ?? item.sessionId, serverName: selectedServer?.name ?? '', workspaceName }])} />
                <span className="min-w-0"><span className="block truncate text-sm">{item.name ?? item.sessionId}</span><span className="block truncate text-xs text-muted-foreground">{item.sessionId}{item.unavailableReason ? ` · ${item.unavailableReason}` : ''}</span></span>
              </label>
            })}
          </div>
          <div className="flex gap-2"><Input value={newName} maxLength={200} onChange={event => setNewName(event.target.value)} disabled={locked} placeholder={t('settings.collaborations.newSessionName')} aria-label={t('settings.collaborations.newSessionName')} />
            <Button variant="outline" disabled={locked || !selectedServer?.credentialAvailable || !workspaceId || basket.length >= MAX_COLLABORATORS} onClick={() => {
              if (!selectedServer) return
              const name = newName.trim() || t('settings.collaborations.defaultNewName', { count: basket.length + 1 })
              setBasket(items => [...items, { key: `new:${crypto.randomUUID()}`, selection: { server: selectedServer.server, workspaceId, createNew: true, name }, name, serverName: selectedServer.name, workspaceName }]); setNewName('')
            }}><Plus className="mr-1 size-4" />{t('settings.collaborations.newSession')}</Button>
          </div>
        </>}
      <div className="space-y-1" aria-label={t('settings.collaborations.relaySelectedMembers')}>
        <p className="text-xs text-muted-foreground">{t('settings.collaborations.selectionCount', { count: basket.length, max: MAX_COLLABORATORS })}</p>
        {basket.map(row => <div key={row.key} className="flex items-center justify-between gap-2 text-sm"><span>{row.name} · {row.serverName} · {row.workspaceName}</span><Button variant="ghost" size="icon" disabled={locked} aria-label={t('settings.collaborations.removeNewSession', { name: row.name })} onClick={() => setBasket(items => items.filter(item => item.key !== row.key))}><X className="size-4" /></Button></div>)}
      </div>
      <DialogFooter><Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button><Button disabled={busy || !context || !basket.length || basket.length > MAX_COLLABORATORS || (!recovering && (loading || error))} onClick={save}>{busy ? t('settings.collaborations.creating') : recovering ? t('settings.collaborations.relayResume') : t('settings.collaborations.start')}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
