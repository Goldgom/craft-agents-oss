import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, KeyRound, Plus, RefreshCw, Search, ShieldCheck, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SettingsCard, SettingsSection } from '@/components/settings'
import { navigate, routes } from '@/lib/navigate'
import {
  NATIVE_CREDENTIAL_FIELDS, NATIVE_CREDENTIAL_LIMITS, NATIVE_CREDENTIAL_TYPES,
  type NativeCredentialApplyRequest, type NativeCredentialErrorCode,
  type NativeCredentialListResponse, type NativeCredentialMetadata,
  type NativeCredentialPatch, type NativeCredentialScope,
} from '@craft-agent/shared/credentials/native-types'
import type { CredentialType } from '@craft-agent/shared/credentials/types'
import { credentialDomain, credentialIdentifierFields, nativeCredentialKey, parseNativeCredentialImport, previewNativeCredentialChanges, type CredentialDomain } from '@/lib/native-credential-import'

const PREFIX = 'settings.credentials.'
const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm'
const domains: CredentialDomain[] = ['saved', 'global', 'llm', 'workspace', 'sources', 'messaging', 'pages', 'connections']
type DialogState = { kind: 'edit'; entry?: NativeCredentialMetadata } | { kind: 'import' } | { kind: 'confirm'; request: NativeCredentialApplyRequest } | { kind: 'migrate' } | null
type Failure = NativeCredentialErrorCode | 'NATIVE_ONLY' | 'UNKNOWN'

/** The inventory and preview only receive metadata. Stored secrets are never fetched. */
export function NativeCredentialManager({ workspaceId }: { workspaceId: string | null }) {
  const { t } = useTranslation()
  const [data, setData] = React.useState<NativeCredentialListResponse | null>(null)
  const [failure, setFailure] = React.useState<Failure | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [query, setQuery] = React.useState('')
  const [domain, setDomain] = React.useState<'all' | CredentialDomain>('all')
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [dialog, setDialog] = React.useState<DialogState>(null)
  const [busy, setBusy] = React.useState(false)
  const [acknowledged, setAcknowledged] = React.useState(false)
  const generation = React.useRef(0)
  const loadId = React.useRef(0)
  const busyRef = React.useRef(false)
  const invalidateRequests = React.useCallback(() => { generation.current++; loadId.current++ }, [])

  const closeDialog = React.useCallback(() => {
    setDialog(null) // Discard pending write-only payloads as well as mounted editors.
    setAcknowledged(false)
  }, [])

  const refresh = React.useCallback(async () => {
    const currentGeneration = generation.current
    const currentLoad = ++loadId.current
    const current = () => generation.current === currentGeneration && loadId.current === currentLoad
    setLoading(true)
    setFailure(null)
    const api = window.electronAPI
    if (!workspaceId || typeof api?.getNativeCredentialStatus !== 'function' || typeof api?.listNativeCredentials !== 'function') {
      if (current()) { setFailure('NATIVE_ONLY'); setData(null); setLoading(false) }
      return
    }
    try {
      const status = await api.getNativeCredentialStatus()
      if (!current()) return
      if (!status.ok) { setFailure(status.code); setData(null); return }
      if (status.value.scope.workspaceId !== workspaceId) { setFailure('SCOPE_NOT_ALLOWED'); setData(null); return }
      if (!status.value.status.canList) { setData({ ...status.value, entries: [] }); return }
      const inventory = await api.listNativeCredentials()
      if (!current()) return
      if (!inventory.ok) { setFailure(inventory.code); setData({ ...status.value, entries: [] }); return }
      if (inventory.value.scope.workspaceId !== workspaceId) { setFailure('SCOPE_NOT_ALLOWED'); setData(null); return }
      setData(inventory.value)
      const keys = new Set(inventory.value.entries.map(entry => nativeCredentialKey(entry.id)))
      setSelected(old => new Set([...old].filter(key => keys.has(key))))
    } catch {
      if (current()) { setFailure('UNKNOWN'); setData(null) }
    } finally {
      if (current()) setLoading(false)
    }
  }, [workspaceId])

  React.useEffect(() => {
    generation.current++
    busyRef.current = false
    setBusy(false); setData(null); setSelected(new Set()); setQuery(''); setDomain('all')
    closeDialog()
    void refresh()
    return invalidateRequests
  }, [workspaceId, refresh, closeDialog, invalidateRequests])

  const openDialog = (next: DialogState) => { setAcknowledged(false); setDialog(next) }
  const entries = data?.entries ?? []
  const filtered = entries.filter(entry => (domain === 'all' || credentialDomain(entry.id.type) === domain)
    && [nativeCredentialKey(entry.id), entry.username, entry.credentialUrl].join(' ').toLowerCase().includes(query.trim().toLowerCase()))
  const managedEntries = (data?.managedEntries ?? []).filter(entry => (domain === 'all' || domain === 'connections')
    && [entry.name, entry.id, entry.serverOrigin, ...entry.fields].join(' ').toLowerCase().includes(query.trim().toLowerCase()))
  const canApply = !!data?.status.canApply && !failure && !loading && !busy
  const preview = dialog?.kind === 'confirm' ? previewNativeCredentialChanges(dialog.request.changes, entries) : []
  const deletionCount = preview.filter(entry => entry.op === 'delete').length

  const commit = async () => {
    if (busyRef.current || !data || !dialog) return
    if (dialog.kind !== 'confirm' && dialog.kind !== 'migrate') return
    if (dialog.kind === 'confirm' && (!canApply || (deletionCount > 0 && !acknowledged))) return
    if (dialog.kind === 'migrate' && (!data.status.canMigrate || !acknowledged)) return
    const currentGeneration = generation.current
    const currentDialog = dialog
    busyRef.current = true; setBusy(true)
    try {
      const result = currentDialog.kind === 'migrate'
        ? await window.electronAPI.migrateNativeCredentials({ acknowledgeHeadlessIncompatibility: true })
        : await window.electronAPI.applyNativeCredentialChanges(currentDialog.request)
      if (currentGeneration !== generation.current) return
      if (!result.ok) { toast.error(t(`${PREFIX}errors.${result.code}`)); return }
      closeDialog(); setSelected(new Set())
      if (currentDialog.kind === 'confirm' && 'warnings' in result.value && result.value.warnings?.length) toast.warning(t(`${PREFIX}savedRuntimePending`))
      else if (currentDialog.kind === 'migrate' && result.value.status.pendingRemoteCredentials) toast.warning(t(`${PREFIX}upgradeRemotePending`))
      else toast.success(t(`${PREFIX}${currentDialog.kind === 'migrate' ? 'upgradeSucceeded' : 'saved'}`))
      await refresh()
    } catch {
      if (currentGeneration === generation.current) toast.error(t(`${PREFIX}errors.UNKNOWN`))
    } finally {
      if (currentGeneration === generation.current) { busyRef.current = false; setBusy(false) }
    }
  }

  const requestDelete = () => {
    if (!canApply) return
    const changes = entries.filter(entry => selected.has(nativeCredentialKey(entry.id))).map(entry => ({ op: 'delete' as const, id: entry.id }))
    if (changes.length > NATIVE_CREDENTIAL_LIMITS.maxChanges) { toast.error(t(`${PREFIX}invalidImport`)); return }
    if (changes.length) openDialog({ kind: 'confirm', request: { changes } })
  }

  return <div className="flex h-full flex-col">
    <PanelHeader title={t(`${PREFIX}title`)} actions={<Button variant="outline" size="sm" disabled={loading || busy} onClick={() => void refresh()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />{t('common.refresh')}</Button>} />
    <div className="min-h-0 flex-1"><ScrollArea className="h-full"><div className="mx-auto max-w-4xl space-y-6 px-5 py-7">
      <SettingsSection title={t(`${PREFIX}protectionTitle`)} description={t(`${PREFIX}privacyHint`)}>
        <SettingsCard><div className="space-y-3 p-4">
          {loading && <p role="status" className="text-sm text-muted-foreground">{t(`${PREFIX}loading`)}</p>}
          {failure && <p role="alert" className="text-sm text-destructive">{t(`${PREFIX}errors.${failure}`)}</p>}
          {data && <>
            <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" /><div className="space-y-1 text-sm">
              <p className="font-medium">{t(`${PREFIX}protection.${data.status.protection}`)}</p>
              <p className="text-muted-foreground">{t(`${PREFIX}scopeHint`, { workspace: data.scope.workspaceId })}</p>
              {data.scope.sourceScopeUnavailable ? <p role="alert" className="text-destructive">{t(`${PREFIX}sourceScopeUnavailable`)}</p> : <p className="text-muted-foreground">{t(`${PREFIX}sourceScope`, { workspace: data.scope.sourceWorkspaceId })}</p>}
              {data.status.backend && <p className="text-muted-foreground">{t(`${PREFIX}backend`, { backend: data.status.backend })}</p>}
              {data.status.protection === 'legacy-machine' && <p className="text-muted-foreground">{t(`${PREFIX}legacyUsable`)}</p>}
              {data.status.protection === 'legacy-machine' && !data.status.canMigrate && <p className="text-muted-foreground">{t(`${PREFIX}upgradeUnavailable`)}</p>}
              {data.status.requiresSeparateHeadlessConfig && <p className="text-muted-foreground">{t(`${PREFIX}headlessSeparate`)}</p>}
              {data.status.legacyBackupAvailable && <p className="text-muted-foreground">{t(`${PREFIX}backupAvailable`)}</p>}
              {data.status.errorCode && <p role="alert" className="text-destructive">{t(`${PREFIX}errors.${data.status.errorCode}`)}</p>}
            </div></div>
            {data.status.canMigrate && <Button variant="outline" disabled={loading || busy} onClick={() => openDialog({ kind: 'migrate' })}>{t(`${PREFIX}upgrade`)}</Button>}
          </>}
        </div></SettingsCard>
      </SettingsSection>


      <SettingsSection title={t(`${PREFIX}inventory`)} description={t(`${PREFIX}inventoryHint`)}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-44 flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pl-9" aria-label={t(`${PREFIX}search`)} placeholder={t(`${PREFIX}search`)} value={query} onChange={event => setQuery(event.target.value)} /></div>
          <select className={`${selectClass} w-auto`} aria-label={t(`${PREFIX}filterDomain`)} value={domain} onChange={event => setDomain(event.target.value as typeof domain)}><option value="all">{t(`${PREFIX}allDomains`)}</option>{domains.map(item => <option key={item} value={item}>{t(`${PREFIX}domains.${item}`)}</option>)}</select>
          <Button variant="outline" disabled={!canApply} onClick={() => openDialog({ kind: 'edit' })}><Plus className="mr-1.5 h-4 w-4" />{t(`${PREFIX}add`)}</Button>
          <Button variant="outline" disabled={!canApply} onClick={() => openDialog({ kind: 'import' })}><Upload className="mr-1.5 h-4 w-4" />{t(`${PREFIX}import`)}</Button>
          <Button variant="outline" disabled={!canApply || !selected.size} onClick={requestDelete}><Trash2 className="mr-1.5 h-4 w-4" />{t(`${PREFIX}deleteSelected`, { count: selected.size })}</Button>
        </div>
        {!loading && !filtered.length && !managedEntries.length && <SettingsCard><p className="p-5 text-sm text-muted-foreground">{t(`${PREFIX}${query || domain !== 'all' ? 'noMatches' : 'empty'}`)}</p></SettingsCard>}
        {domains.map(group => {
          const rows = filtered.filter(entry => credentialDomain(entry.id.type) === group)
          if (!rows.length) return null
          return <SettingsCard key={group}><div className="border-b border-border/50 px-4 py-3 text-sm font-medium">{t(`${PREFIX}domains.${group}`)}</div><div className="divide-y divide-border/50">{rows.map(entry => {
            const key = nativeCredentialKey(entry.id)
            return <div key={key} className="flex items-start gap-3 px-4 py-3">
              <input type="checkbox" className="mt-1" aria-label={t(`${PREFIX}selectCredential`, { id: key })} checked={selected.has(key)} disabled={!canApply} onChange={event => setSelected(old => { const next = new Set(old); if (event.target.checked) next.add(key); else next.delete(key); return next })} />
              <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1 space-y-1">
                <p className="break-all text-sm font-medium">{entry.id.type === 'saved_credential' ? entry.id.name : key}</p>
                {entry.id.type === 'saved_credential' && <p className="break-all text-xs text-muted-foreground">{t(`${PREFIX}kinds.${entry.credentialKind ?? 'secret'}`)}{entry.username ? ` · ${entry.username}` : ''}{entry.credentialUrl ? ` · ${entry.credentialUrl}` : ''}</p>}
                <p className="text-xs text-muted-foreground">{t(`${PREFIX}${entry.hasValue ? 'valuePresent' : 'valueMissing'}`)}{entry.expiresAt != null ? ` · ${t(`${PREFIX}expires`, { date: new Date(entry.expiresAt).toLocaleString() })}` : ''}</p>
                {entry.id.type !== 'saved_credential' && <p className="break-words text-xs text-muted-foreground">{t(`${PREFIX}storedFields`, { fields: entry.presentFields.join(', ') })}</p>}
              </div><Button size="sm" variant="outline" disabled={!canApply} onClick={() => openDialog({ kind: 'edit', entry })}>{t(`${PREFIX}update`)}</Button>
            </div>
          })}</div></SettingsCard>
        })}
      </SettingsSection>
      {!!(managedEntries.length || (data?.managedEntriesUnavailable && (domain === 'all' || domain === 'connections'))) && <SettingsSection title={t(`${PREFIX}managedConnections`)} description={t(`${PREFIX}managedHint`)}>
        {data?.managedEntriesUnavailable && <p role="alert" className="text-sm text-destructive">{t(`${PREFIX}managedUnavailable`)}</p>}
        {managedEntries.map(entry => <SettingsCard key={`${entry.kind}:${entry.id}`}><div className="space-y-2 p-4 text-sm">
          <p className="font-medium">{entry.name}</p><p className="break-all text-muted-foreground">{entry.serverOrigin}</p>
          <p className="text-muted-foreground">{t(`${PREFIX}managedProtection.${entry.protection}`)}</p>
          <p className="text-muted-foreground">{t(`${PREFIX}storedFields`, { fields: entry.fields.join(', ') })}</p>
          {!entry.profileId && entry.kind === 'remote-workspace' && <p className="text-muted-foreground">{t(`${PREFIX}unlinkedWorkspace`)}</p>}
          <Button variant="outline" disabled={busy} onClick={() => navigate(routes.view.settings(entry.settingsTarget))}>{t(`${PREFIX}manageConnections`)}</Button>
        </div></SettingsCard>)}
      </SettingsSection>}
    </div></ScrollArea></div>

    {dialog && data && <Dialog open onOpenChange={open => { if (!open && !busyRef.current) closeDialog() }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" showCloseButton={!busy}>
        <DialogHeader><DialogTitle>{t(`${PREFIX}${dialog.kind === 'migrate' ? 'upgrade' : dialog.kind === 'confirm' ? 'review' : dialog.kind === 'import' ? 'import' : dialog.entry ? 'update' : 'add'}`)}</DialogTitle><DialogDescription>{t(`${PREFIX}${dialog.kind === 'migrate' ? 'upgradeWarning' : 'writeOnlyHint'}`)}</DialogDescription></DialogHeader>
        {dialog.kind === 'edit' && <CredentialEditor key={`${workspaceId}:${dialog.entry ? nativeCredentialKey(dialog.entry.id) : 'new'}`} entry={dialog.entry} scope={data.scope} inventory={entries} onPreview={request => openDialog({ kind: 'confirm', request })} onCancel={closeDialog} />}
        {dialog.kind === 'import' && <CredentialImporter key={workspaceId} scope={data.scope} inventory={entries} onPreview={request => openDialog({ kind: 'confirm', request })} onCancel={closeDialog} />}
        {dialog.kind === 'confirm' && <>
          <p className="text-sm text-muted-foreground">{t(`${PREFIX}reviewHint`, { count: preview.length })}</p>
          <ul className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-3">{preview.map(entry => <li key={entry.key} className="break-all text-sm"><span className={entry.op === 'delete' ? 'font-semibold text-destructive' : 'font-semibold'}>{t(`${PREFIX}${entry.op === 'delete' ? 'delete' : entry.existing ? 'update' : 'add'}`)}</span>{' · '}{entry.key}{entry.fields.length ? <p className="mt-1 text-xs text-muted-foreground">{t(`${PREFIX}changedFields`, { fields: entry.fields.join(', ') })}</p> : null}</li>)}</ul>
          {deletionCount > 0 && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} /><span>{t(`${PREFIX}deleteAcknowledge`, { count: deletionCount })}</span></label>}
          <DialogFooter><Button variant="outline" disabled={busy} onClick={closeDialog}>{t('common.cancel')}</Button><Button disabled={busy || (deletionCount > 0 && !acknowledged)} onClick={() => void commit()}>{t(`${PREFIX}${busy ? 'saving' : 'apply'}`)}</Button></DialogFooter>
        </>}
        {dialog.kind === 'migrate' && <>
          <p className="text-sm">{t(`${PREFIX}upgradeStability`)}</p>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} /><span>{t(`${PREFIX}upgradeAcknowledge`)}</span></label>
          <DialogFooter><Button variant="outline" disabled={busy} onClick={closeDialog}>{t('common.cancel')}</Button><Button disabled={busy || !acknowledged} onClick={() => void commit()}>{t(`${PREFIX}${busy ? 'saving' : 'confirmUpgrade'}`)}</Button></DialogFooter>
        </>}
      </DialogContent>
    </Dialog>}
  </div>
}

function CredentialEditor({ entry, scope, inventory, onPreview, onCancel }: {
  entry?: NativeCredentialMetadata; scope: NativeCredentialScope; inventory: NativeCredentialMetadata[]
  onPreview: (request: NativeCredentialApplyRequest) => void; onCancel: () => void
}) {
  const { t } = useTranslation()
  const [type, setType] = React.useState<CredentialType>(entry?.id.type ?? 'saved_credential')
  const [kind, setKind] = React.useState<'password' | 'api-key' | 'secret'>(entry?.credentialKind ?? (entry ? 'secret' : 'password'))
  const [username, setUsername] = React.useState(entry?.username ?? '')
  const [url, setUrl] = React.useState(entry?.credentialUrl ?? '')
  const [showValue, setShowValue] = React.useState(false)
  const [identifiers, setIdentifiers] = React.useState<Record<string, string>>({
    connectionSlug: entry?.id.connectionSlug ?? '', sourceId: entry?.id.sourceId ?? '', name: entry?.id.name ?? '',
  })
  const [value, setValue] = React.useState('')
  const [optional, setOptional] = React.useState<Record<string, { mode: 'set' | 'clear'; value: string }>>({})
  const [invalid, setInvalid] = React.useState(false)
  const identifiersNeeded = credentialIdentifierFields(type)
  const credentialWorkspaceId = type.startsWith('source_') ? scope.sourceWorkspaceId : scope.workspaceId
  const preview = () => {
    const id: Record<string, string> = { type }
    for (const field of identifiersNeeded) id[field] = field === 'workspaceId' ? credentialWorkspaceId ?? '' : identifiers[field] ?? ''
    const credential: NativeCredentialPatch = {}
    if (value) credential.value = value
    if (type === 'saved_credential') {
      if (kind === 'password' && !username.trim()) { setInvalid(true); return }
      credential.credentialKind = kind
      credential.username = username.trim() || null
      credential.credentialUrl = url.trim() || null
    }
    for (const [field, fieldState] of Object.entries(optional)) {
      if (field === 'expiresAt' && fieldState.mode === 'set' && (!fieldState.value.trim() || !Number.isFinite(Number(fieldState.value)))) { setInvalid(true); return }
      const next = fieldState.mode === 'clear' ? null : field === 'expiresAt' ? Number(fieldState.value) : fieldState.value
      ;(credential as Record<string, unknown>)[field] = next
    }
    try { onPreview(parseNativeCredentialImport(JSON.stringify({ changes: [{ op: 'upsert', id, credential }] }), scope, inventory)) }
    catch { setInvalid(true) }
  }
  return <div className="space-y-4">
    <label className="block space-y-1 text-sm"><span>{t(`${PREFIX}credentialType`)}</span><select className={selectClass} aria-label={t(`${PREFIX}credentialType`)} disabled={!!entry} value={type} onChange={event => { setType(event.target.value as CredentialType); setValue(''); setOptional({}); setShowValue(false); setInvalid(false) }}>{NATIVE_CREDENTIAL_TYPES.map(item => <option key={item} value={item} disabled={item.startsWith('source_') && scope.sourceScopeUnavailable}>{item === 'saved_credential' ? t(`${PREFIX}domains.saved`) : item}</option>)}</select></label>
    {identifiersNeeded.map(field => <label key={field} className="block space-y-1 text-sm"><span>{t(`${PREFIX}identifier.${field}`)}</span><Input aria-label={t(`${PREFIX}identifier.${field}`)} value={field === 'workspaceId' ? credentialWorkspaceId ?? '' : identifiers[field] ?? ''} disabled={!!entry || field === 'workspaceId'} maxLength={NATIVE_CREDENTIAL_LIMITS.maxIdLength} onChange={event => setIdentifiers(old => ({ ...old, [field]: event.target.value }))} autoComplete="off" spellCheck={false} /></label>)}
    {type === 'saved_credential' && <>
      <p className="text-xs text-muted-foreground">{t(`${PREFIX}namedHint`)}</p>
      <label className="block space-y-1 text-sm"><span>{t(`${PREFIX}kind`)}</span><select className={selectClass} aria-label={t(`${PREFIX}kind`)} value={kind} onChange={event => setKind(event.target.value as typeof kind)}>{(['password', 'api-key', 'secret'] as const).map(item => <option key={item} value={item}>{t(`${PREFIX}kinds.${item}`)}</option>)}</select></label>
      <label className="block space-y-1 text-sm"><span>{t(`${PREFIX}username`)}</span><Input aria-label={t(`${PREFIX}username`)} autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} /></label>
      <label className="block space-y-1 text-sm"><span>{t(`${PREFIX}website`)}</span><Input aria-label={t(`${PREFIX}website`)} type="url" placeholder="https://example.com" value={url} onChange={event => setUrl(event.target.value)} /></label>
    </>}
    <label className="block space-y-1 text-sm"><span>{t(`${PREFIX}${entry ? 'replaceValue' : 'newValue'}`)}</span><div className="flex gap-2"><Input type={showValue ? 'text' : 'password'} aria-label={t(`${PREFIX}secretValue`)} autoComplete="new-password" spellCheck={false} maxLength={NATIVE_CREDENTIAL_LIMITS.maxFieldBytes} value={value} onChange={event => setValue(event.target.value)} /><Button type="button" variant="outline" size="icon" aria-label={t(`${PREFIX}${showValue ? 'hideInput' : 'showInput'}`)} onClick={() => setShowValue(old => !old)}>{showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button></div></label>
    {type !== 'saved_credential' && <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">{t(`${PREFIX}optionalFields`)}</summary><p className="my-3 text-xs text-muted-foreground">{t(`${PREFIX}optionalHint`)}</p><div className="space-y-3">{NATIVE_CREDENTIAL_FIELDS.filter(field => !['value', 'username', 'credentialKind', 'credentialUrl'].includes(field)).map(field => <div key={field} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px_minmax(0,1.3fr)] sm:items-center">
      <label className="text-sm" htmlFor={`credential-field-${field}`}>{field}</label>
      <select className={selectClass} aria-label={t(`${PREFIX}fieldAction`, { field })} value={optional[field]?.mode ?? 'keep'} onChange={event => setOptional(old => { const next = { ...old }; if (event.target.value === 'keep') delete next[field]; else next[field] = { mode: event.target.value as 'set' | 'clear', value: old[field]?.value ?? '' }; return next })}><option value="keep">{t(`${PREFIX}keep`)}</option><option value="set">{t(`${PREFIX}set`)}</option><option value="clear">{t(`${PREFIX}clear`)}</option></select>
      {optional[field]?.mode === 'set' && (field === 'source' ? <select id={`credential-field-${field}`} className={selectClass} aria-label={field} value={optional[field].value} onChange={event => setOptional(old => ({ ...old, [field]: { mode: 'set', value: event.target.value } }))}><option value="">{t(`${PREFIX}choose`)}</option><option value="native">native</option><option value="cli">cli</option></select> : <Input id={`credential-field-${field}`} type={field === 'expiresAt' ? 'number' : 'password'} aria-label={field} min={field === 'expiresAt' ? 0 : undefined} step={field === 'expiresAt' ? 1 : undefined} placeholder={field === 'expiresAt' ? t(`${PREFIX}unixMilliseconds`) : undefined} autoComplete="new-password" spellCheck={false} value={optional[field].value} onChange={event => setOptional(old => ({ ...old, [field]: { mode: 'set', value: event.target.value } }))} />)}
    </div>)}</div></details>}
    {invalid && <p role="alert" className="text-sm text-destructive">{t(`${PREFIX}invalidImport`)}</p>}
    <DialogFooter><Button variant="outline" onClick={onCancel}>{t('common.cancel')}</Button><Button onClick={preview}>{t(`${PREFIX}review`)}</Button></DialogFooter>
  </div>
}

function CredentialImporter({ scope, inventory, onPreview, onCancel }: {
  scope: NativeCredentialScope; inventory: NativeCredentialMetadata[]
  onPreview: (request: NativeCredentialApplyRequest) => void; onCancel: () => void
}) {
  const { t } = useTranslation()
  const [text, setText] = React.useState('')
  const [invalid, setInvalid] = React.useState(false)
  const readId = React.useRef(0)
  const mounted = React.useRef(true)
  const invalidateRead = React.useCallback(() => { mounted.current = false; readId.current++ }, [])
  React.useEffect(() => { mounted.current = true; return invalidateRead }, [invalidateRead])
  const example = JSON.stringify({ changes: [{ op: 'upsert', id: { type: 'llm_api_key', connectionSlug: 'your-existing-connection' }, credential: { value: 'new-secret' } }] }, null, 2)
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">{t(`${PREFIX}importHint`, { count: NATIVE_CREDENTIAL_LIMITS.maxChanges })}</p>
    <details className="text-sm"><summary className="cursor-pointer">{t(`${PREFIX}example`)}</summary><pre className="mt-2 overflow-auto rounded-md bg-muted p-3 text-xs">{example}</pre></details>
    <label className="block space-y-1 text-sm"><span>{t(`${PREFIX}chooseFile`)}</span><Input type="file" accept=".json,application/json" aria-label={t(`${PREFIX}chooseFile`)} onChange={event => {
      const file = event.target.files?.[0]
      const currentRead = ++readId.current
      event.target.value = ''
      if (!file) return
      setText(''); setInvalid(false)
      if (file.size > NATIVE_CREDENTIAL_LIMITS.maxRequestBytes) { setInvalid(true); return }
      void file.text().then(next => { if (mounted.current && currentRead === readId.current) { setText(next); setInvalid(false) } }).catch(() => { if (mounted.current && currentRead === readId.current) setInvalid(true) })
    }} /></label>
    <Textarea aria-label={t(`${PREFIX}importJson`)} value={text} onChange={event => { readId.current++; setText(event.target.value); setInvalid(false) }} rows={9} spellCheck={false} autoComplete="off" maxLength={NATIVE_CREDENTIAL_LIMITS.maxRequestBytes} className="font-mono text-xs" />
    {invalid && <p role="alert" className="text-sm text-destructive">{t(`${PREFIX}invalidImport`)}</p>}
    <DialogFooter><Button variant="outline" onClick={onCancel}>{t('common.cancel')}</Button><Button onClick={() => { try { onPreview(parseNativeCredentialImport(text, scope, inventory)) } catch { setInvalid(true) } }}>{t(`${PREFIX}review`)}</Button></DialogFooter>
  </div>
}
