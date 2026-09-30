import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { importMcpEntries } from '@/lib/mcp-import-runner'
import { parseSourceCredentialBatch } from '@/lib/source-credential-batch'
import { parseMcpImport, type McpImportEntry } from '@/lib/mcp-import'
import type { LoadedSource } from '../../../shared/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  sources: LoadedSource[]
  onRefresh: () => Promise<void>
}

export function McpManagementDialog({ open, onOpenChange, workspaceId, sources, onRefresh }: Props) {
  const { t } = useTranslation()
  const [name, setName] = React.useState('')
  const [transport, setTransport] = React.useState<'http' | 'sse' | 'stdio'>('http')
  const [authType, setAuthType] = React.useState<'none' | 'bearer' | 'oauth'>('none')
  const [token, setToken] = React.useState('')
  const [endpoint, setEndpoint] = React.useState('')
  const [args, setArgs] = React.useState('')
  const [batch, setBatch] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [credentialBatch, setCredentialBatch] = React.useState('')
  const busyRef = React.useRef(false)
  const fileReadId = React.useRef(0)
  const openRef = React.useRef(open)
  openRef.current = open
  React.useEffect(() => {
    fileReadId.current++
    setToken(''); setBatch(''); setCredentialBatch('')
  }, [workspaceId])
  React.useEffect(() => {
    if (!open) { fileReadId.current++; setToken(''); setBatch(''); setCredentialBatch('') }
  }, [open])

  const importEntries = async (entries: Array<McpImportEntry & { credential?: string }>) => {
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    try {
      const { imported, skipped, failures } = await importMcpEntries(
        entries,
        sources.filter(source => source.config.type === 'mcp').map(source => source.config.name),
        {
          create: entry => window.electronAPI.createSource(workspaceId, { name: entry.name, provider: 'custom', type: 'mcp', mcp: entry.mcp }),
          save: (slug, credential) => window.electronAPI.saveSourceCredentials(workspaceId, slug, credential),
          remove: slug => window.electronAPI.deleteSource(workspaceId, slug),
        },
      )
      const failed = failures.map(failure => `${failure.name}: ${t(failure.reason === 'rollback' ? 'mcpManage.credentialRollbackFailed' : failure.reason === 'credential' ? 'mcpManage.credentialSaveFailed' : 'mcpManage.createFailed')}`)
      try { await onRefresh() }
      catch (error) {
        toast.error(t('mcpManage.refreshFailed'), { description: error instanceof Error ? error.message : undefined })
      }
      toast[failed.length ? 'warning' : 'success'](t('mcpManage.importResult', { imported, skipped, failed: failed.length }), {
        description: failed.length ? failed.join('\n') : undefined,
      })
      return failed.length === 0
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const handleCredentials = async () => {
    if (busyRef.current) return
    let entries
    try { entries = parseSourceCredentialBatch(credentialBatch) }
    catch { toast.error(t('mcpManage.invalidCredentials')); return }
    busyRef.current = true
    setBusy(true)
    try {
      const result = await window.electronAPI.saveSourceCredentialsBatch(workspaceId, entries)
      setCredentialBatch('')
      toast.success(t('mcpManage.credentialsSaved', { count: result.saved }))
      if (result.statusUpdateFailed.length) toast.warning(t('mcpManage.credentialStatusWarning'))
      try { await onRefresh() } catch { toast.warning(t('mcpManage.refreshFailed')) }
    } catch {
      toast.error(t('mcpManage.credentialBatchFailed'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const handleSingle = async () => {
    const trimmedName = name.trim()
    const trimmedEndpoint = endpoint.trim()
    if (!trimmedName || !trimmedEndpoint || (transport !== 'stdio' && authType === 'bearer' && !token.trim())) { toast.error(t('mcpManage.required')); return }
    if (transport !== 'stdio') {
      try { const url = new URL(trimmedEndpoint); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error() }
      catch { toast.error(t('mcpManage.invalidUrl')); return }
    }
    const mcp = transport === 'stdio'
      ? { transport, command: trimmedEndpoint, args: args.trim() ? args.trim().split(/\s+/) : [] }
      : { transport, url: trimmedEndpoint, authType }
    const success = await importEntries([{ name: trimmedName, mcp, credential: transport !== 'stdio' && authType === 'bearer' ? token.trim() : undefined }])
    if (success) { setName(''); setEndpoint(''); setArgs(''); setToken('') }
  }

  const handleBatch = async () => {
    try {
      const entries = parseMcpImport(batch)
      if (await importEntries(entries)) setBatch('')
    } catch (error) {
      toast.error(t('mcpManage.invalidJson'), { description: error instanceof Error ? error.message : undefined })
    }
  }

  const handleDelete = async (source: LoadedSource) => {
    if (busyRef.current) return
    if (!window.confirm(t('mcpManage.deleteConfirm', { name: source.config.name }))) return
    busyRef.current = true
    setBusy(true)
    try {
      await window.electronAPI.deleteSource(workspaceId, source.config.slug)
      await onRefresh()
      toast.success(t('sourceInfo.deletedSource', { name: source.config.name }))
    }
    catch (error) { toast.error(t('sourceInfo.failedToDelete'), { description: error instanceof Error ? error.message : undefined }) }
    finally { busyRef.current = false; setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!busyRef.current) onOpenChange(next) }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('mcpManage.title')}</DialogTitle>
          <DialogDescription>{t('mcpManage.description')}</DialogDescription>
        </DialogHeader>
        <fieldset disabled={busy} className="space-y-5 min-w-0">
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">{t('mcpManage.add')}</h3>
            <Input value={name} onChange={event => setName(event.target.value)} placeholder={t('mcpManage.name')} aria-label={t('mcpManage.name')} />
            <select value={transport} onChange={event => setTransport(event.target.value as typeof transport)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" aria-label={t('mcpManage.transport')}>
              <option value="http">HTTP</option><option value="sse">SSE</option><option value="stdio">Stdio</option>
            </select>
            <Input value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder={transport === 'stdio' ? t('mcpManage.command') : t('mcpManage.url')} aria-label={transport === 'stdio' ? t('mcpManage.command') : t('mcpManage.url')} />
            {transport === 'stdio' && <Input value={args} onChange={event => setArgs(event.target.value)} placeholder={t('mcpManage.args')} aria-label={t('mcpManage.args')} />}
            {transport !== 'stdio' && <>
              <select value={authType} onChange={event => setAuthType(event.target.value as typeof authType)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" aria-label={t('mcpManage.auth')}>
                <option value="none">{t('mcpManage.noAuth')}</option><option value="bearer">Bearer token</option><option value="oauth">OAuth</option>
              </select>
              {authType === 'bearer' && <Input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder={t('mcpManage.token')} aria-label={t('mcpManage.token')} />}
            </>}
            <Button disabled={busy} onClick={() => void handleSingle()}>{t('mcpManage.importOne')}</Button>
          </section>
          <section className="space-y-3 border-t border-border pt-5">
            <h3 className="text-sm font-semibold">{t('mcpManage.batch')}</h3>
            <p className="text-xs text-muted-foreground">{t('mcpManage.batchHint')}</p>
            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>{t('mcpManage.chooseFile')}</span>
              <Input type="file" accept=".json,application/json" onChange={event => {
                const file = event.target.files?.[0]
                const readId = ++fileReadId.current
                if (file) void file.text().then(text => {
                  if (openRef.current && readId === fileReadId.current) setBatch(text)
                }).catch(() => {
                  if (openRef.current && readId === fileReadId.current) toast.error(t('mcpManage.invalidJson'))
                })
              }} />
            </label>
            <Textarea value={batch} onChange={event => setBatch(event.target.value)} rows={7} className="font-mono text-xs" placeholder={'{"mcpServers":{"example":{"url":"https://example.com/mcp"}}}'} aria-label={t('mcpManage.batch')} />
            <Button disabled={busy || !batch.trim()} onClick={() => void handleBatch()}>{t('mcpManage.importBatch')}</Button>
          </section>
          <section className="space-y-3 border-t border-border pt-5">
            <h3 className="text-sm font-semibold">{t('mcpManage.credentialsBatch')}</h3>
            <p className="text-xs text-muted-foreground">{t('mcpManage.credentialsHint')}</p>
            <p className="text-xs text-muted-foreground">{sources.filter(source => source.config.type !== 'local').map(source => `${source.config.name}: ${source.config.slug}`).join(' · ')}</p>
            <Textarea value={credentialBatch} onChange={event => setCredentialBatch(event.target.value)} rows={5} autoComplete="off" spellCheck={false} className="font-mono text-xs" placeholder={'{"source-slug":"token","basic-source":{"username":"user","password":"password"}}'} aria-label={t('mcpManage.credentialsBatch')} />
            <Button disabled={busy || !credentialBatch.trim()} onClick={() => void handleCredentials()}>{t('mcpManage.saveCredentialsBatch')}</Button>
          </section>
          <section className="space-y-2 border-t border-border pt-5">
            <h3 className="text-sm font-semibold">{t('mcpManage.configured')}</h3>
            {sources.filter(source => source.config.type === 'mcp').map(source => (
              <div key={source.config.slug} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
                <span className="min-w-0 truncate">{source.config.name}</span>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void handleDelete(source)}>{t('common.delete')}</Button>
              </div>
            ))}
          </section>
        </fieldset>
      </DialogContent>
    </Dialog>
  )
}
