import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import type { SessionMeta } from '@/atoms/sessions'
import type { CollaborationWorkspace, RemoteServerProfileInfo, StartupServerContext } from '../../../shared/types'
import { getSessionTitle } from '@/utils/session'
import { availableCollaborationSessions, collaborationSelections, collaborationSessionKey, MAX_COLLABORATORS } from './collaboration-selection'
import { MultiServerCollaborationDialog } from './MultiServerCollaborationDialog'

interface CollaborationDialogProps {
  primary: SessionMeta
  open: boolean
  onOpenChange: (open: boolean) => void
}

const selectClass = 'h-9 w-full rounded-md border border-foreground/15 bg-background px-2 text-sm disabled:opacity-50'

export function CollaborationDialog({ primary, open, onOpenChange }: CollaborationDialogProps) {
  if (typeof window.electronAPI.getCollaborationSetupContext === 'function') {
    return <MultiServerCollaborationDialog primary={primary} open={open} onOpenChange={onOpenChange} />
  }
  return <LegacyCollaborationDialog primary={primary} open={open} onOpenChange={onOpenChange} />
}

function LegacyCollaborationDialog({ primary, open, onOpenChange }: CollaborationDialogProps) {
  const { t } = useTranslation()
  const [profiles, setProfiles] = React.useState<RemoteServerProfileInfo[]>([])
  const [context, setContext] = React.useState<StartupServerContext | null>(null)
  const [serverId, setServerId] = React.useState('current')
  const [workspaces, setWorkspaces] = React.useState<CollaborationWorkspace[]>([])
  const [workspaceId, setWorkspaceId] = React.useState(primary.workspaceId)
  const [sessions, setSessions] = React.useState<SessionMeta[]>([])
  const [remotePrimaryId, setRemotePrimaryId] = React.useState('')
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [newSessions, setNewSessions] = React.useState<Array<{ id: string; workspaceId: string; name: string }>>([])
  const [newName, setNewName] = React.useState('')
  const [search, setSearch] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [loadError, setLoadError] = React.useState(false)
  const [reload, setReload] = React.useState(0)
  const [saving, setSaving] = React.useState(false)
  const savingRef = React.useRef(false)
  const catalogServerRef = React.useRef<string | null>(null)
  const remote = serverId !== 'current'

  React.useEffect(() => {
    if (!open) return
    let active = true
    setServerId('current')
    setProfiles([])
    setContext(null)
    void window.electronAPI.getRemoteServers().then(items => { if (active) setProfiles(items) }).catch(() => {})
    void window.electronAPI.getStartupContext().then(value => { if (active) setContext(value) }).catch(() => {})
    return () => { active = false }
  }, [open])

  // Changing server invalidates all selections. Ignore responses from a closed
  // dialog or older server request so late arrivals cannot redirect a save.
  React.useEffect(() => {
    if (!open) return
    let active = true
    catalogServerRef.current = null
    setSessions([])
    setWorkspaces([])
    setWorkspaceId('')
    setSelected(new Set())
    setNewSessions([])
    setRemotePrimaryId('')
    setSearch('')
    setNewName('')
    setLoading(true)
    setLoadError(false)
    void (async () => {
      try {
        if (serverId === 'current') {
          const [items, spaces] = await Promise.all([
            window.electronAPI.listCollaborationCandidates(),
            window.electronAPI.listCollaborationWorkspaces(),
          ])
          if (!active) return
          catalogServerRef.current = serverId
          setSessions(items)
          setWorkspaces(spaces)
          setWorkspaceId(spaces.some(space => space.id === primary.workspaceId) ? primary.workspaceId : spaces[0]?.id ?? '')
          setLoading(false)
        } else {
          const spaces = await window.electronAPI.listRemoteCollaborationWorkspaces(serverId)
          if (!active) return
          catalogServerRef.current = serverId
          setWorkspaces(spaces)
          setWorkspaceId(spaces[0]?.id ?? '')
          if (!spaces.length) setLoading(false)
        }
      } catch (error) {
        if (!active) return
        console.error('Failed to load collaboration targets:', error)
        setLoadError(true)
        setLoading(false)
      }
    })()
    return () => { active = false }
  }, [open, serverId, primary.id, primary.workspaceId, reload])

  React.useEffect(() => {
    if (!open || !remote || !workspaceId || catalogServerRef.current !== serverId
      || !workspaces.some(workspace => workspace.id === workspaceId)) return
    let active = true
    setSessions([])
    setSelected(new Set())
    setNewSessions([])
    setRemotePrimaryId('')
    setLoading(true)
    setLoadError(false)
    void window.electronAPI.listRemoteCollaborationCandidates(serverId, workspaceId)
      .then(items => { if (active) setSessions(items.filter(item => item.workspaceId === workspaceId)) })
      .catch(error => {
        if (!active) return
        console.error('Failed to load remote collaboration sessions:', error)
        setLoadError(true)
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [open, remote, serverId, workspaceId, workspaces])

  const chosenPrimary = remote ? sessions.find(session => session.id === remotePrimaryId && session.workspaceId === workspaceId) : primary
  const candidates = availableCollaborationSessions(sessions, chosenPrimary)
  const selections = collaborationSelections(candidates, selected, newSessions)
  const visibleSessions = candidates.filter(session => session.workspaceId === workspaceId
    && `${getSessionTitle(session)} ${session.id}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const currentServerLabel = context?.mode === 'remote'
    ? context.profileName ?? context.serverUrl ?? t('serverSwitcher.remoteServer')
    : t('settings.collaborations.currentServer')

  const save = async () => {
    if (savingRef.current || loading || loadError || !chosenPrimary || !selections.length || selections.length > MAX_COLLABORATORS) return
    savingRef.current = true
    setSaving(true)
    try {
      const result = remote
        ? await window.electronAPI.createRemoteCollaboration(serverId, workspaceId, chosenPrimary.id, selections)
        : await window.electronAPI.createCollaboration(chosenPrimary.id, selections)
      const workspaceAction = remote ? {
        action: {
          label: t('settings.collaborations.openWorkspace'),
          onClick: () => { void window.electronAPI.openRemoteCollaborationWorkspace(serverId, workspaceId).then(result => {
            if (!result.ok) toast.error(result.error ?? t('settings.collaborations.loadFailed'))
          }).catch(() => toast.error(t('settings.collaborations.loadFailed'))) },
        },
      } : undefined
      if (result.activationStatus === 'failed') {
        toast.warning(t('settings.collaborations.activationFailed'), {
          description: t('settings.collaborations.activationFailedHint'),
          ...(workspaceAction ?? {
            action: {
              label: t('settings.collaborations.openPrimarySession'),
              onClick: () => { void window.electronAPI.openSessionInNewWindow(chosenPrimary.workspaceId, chosenPrimary.id)
                .catch(() => toast.error(t('settings.collaborations.loadFailed'))) },
            },
          }),
        })
      } else {
        // Legacy servers omit activationStatus and retain their success path.
        toast.success(t('settings.collaborations.started', { count: selections.length }), workspaceAction)
      }
      onOpenChange(false)
    } catch (error) {
      console.error('Failed to create collaboration:', error)
      toast.error(t('settings.collaborations.createFailed'), { description: error instanceof Error ? error.message : undefined })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={value => { if (!savingRef.current) onOpenChange(value) }}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            <Users className="size-5" />
            <div>
              <DialogTitle>{t('settings.collaborations.configure')}</DialogTitle>
              <DialogDescription>{t('settings.collaborations.configureDesc', { title: getSessionTitle(primary) })}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <label className="space-y-1 text-sm">
          <span>{t('settings.collaborations.server')}</span>
          <select className={selectClass} value={serverId} disabled={saving} onChange={event => setServerId(event.target.value)}>
            <option value="current">{currentServerLabel}</option>
            {profiles.map(profile => <option key={profile.id} value={profile.id} disabled={!profile.hasToken}>{profile.name} · {profile.url}</option>)}
          </select>
        </label>
        <p className="text-xs text-muted-foreground">{t('settings.collaborations.sameServerNotice')}</p>
        <label className="space-y-1 text-sm">
          <span>{t('settings.collaborations.workspace')}</span>
          <select className={selectClass} value={workspaceId} disabled={saving || !workspaces.length} onChange={event => setWorkspaceId(event.target.value)}>
            {!workspaces.length && <option value="">{t('settings.collaborations.noWorkspaces')}</option>}
            {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
        </label>
        {remote ? (
          <label className="space-y-1 text-sm">
            <span>{t('settings.collaborations.primaryRole')}</span>
            <select className={selectClass} value={remotePrimaryId} disabled={saving || loading} onChange={event => setRemotePrimaryId(event.target.value)}>
              <option value="">{t('settings.collaborations.choosePrimary')}</option>
              {availableCollaborationSessions(sessions).map(session => <option key={collaborationSessionKey(session)} value={session.id}>{getSessionTitle(session)} · {session.id}</option>)}
            </select>
          </label>
        ) : <p className="text-sm">{t('settings.collaborations.primaryRole')}: {getSessionTitle(primary)}</p>}

        {loadError ? <div role="alert" className="text-sm text-destructive">
          {t('settings.collaborations.loadFailed')}
          <Button variant="ghost" disabled={saving} onClick={() => setReload(value => value + 1)}>{t('settings.collaborations.reload')}</Button>
        </div> : loading ? <p role="status" className="text-sm text-muted-foreground">{t('settings.collaborations.loading')}</p> : (
          <>
            <Input value={search} onChange={event => setSearch(event.target.value)} placeholder={t('settings.collaborations.searchSessions')} aria-label={t('settings.collaborations.searchSessions')} disabled={saving} />
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-foreground/10 p-2">
              {!visibleSessions.length ? <p className="p-3 text-sm text-muted-foreground">{t('settings.collaborations.noLocalSessions')}</p> : visibleSessions.map(session => {
                const key = collaborationSessionKey(session)
                const checked = selected.has(key)
                return <label key={key} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-foreground/5">
                  <input type="checkbox" checked={checked} disabled={saving || (!checked && selections.length >= MAX_COLLABORATORS)} onChange={() => setSelected(current => {
                    const next = new Set(current)
                    if (checked) next.delete(key)
                    else next.add(key)
                    return next
                  })} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{getSessionTitle(session)}</span>
                    <span className="block truncate text-xs text-muted-foreground">{session.id}</span>
                  </span>
                </label>
              })}
            </div>
            <div className="flex gap-2">
              <Input value={newName} maxLength={200} onChange={event => setNewName(event.target.value)} disabled={saving} placeholder={t('settings.collaborations.newSessionName')} aria-label={t('settings.collaborations.newSessionName')} />
              <Button variant="outline" disabled={saving || !workspaceId || selections.length >= MAX_COLLABORATORS} onClick={() => {
                setNewSessions(items => [...items, { id: crypto.randomUUID(), workspaceId, name: newName.trim() || t('settings.collaborations.defaultNewName', { count: newSessions.length + 1 }) }])
                setNewName('')
              }}><Plus className="size-4 mr-1" />{t('settings.collaborations.newSession')}</Button>
            </div>
            {newSessions.map(session => <div key={session.id} className="flex items-center justify-between text-sm">
              <span>{session.name} · {workspaces.find(space => space.id === session.workspaceId)?.name ?? session.workspaceId}</span>
              <Button variant="ghost" size="icon" disabled={saving} aria-label={t('settings.collaborations.removeNewSession', { name: session.name })} onClick={() => setNewSessions(items => items.filter(item => item.id !== session.id))}><X className="size-4" /></Button>
            </div>)}
            <p className="text-xs text-muted-foreground">{t('settings.collaborations.selectionCount', { count: selections.length, max: MAX_COLLABORATORS })}</p>
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button disabled={saving || loading || loadError || !chosenPrimary || !selections.length || selections.length > MAX_COLLABORATORS} onClick={() => void save()}>
            {saving ? t('settings.collaborations.creating') : t('settings.collaborations.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
