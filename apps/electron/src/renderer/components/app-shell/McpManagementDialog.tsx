import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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

  const importEntries = async (entries: Array<McpImportEntry & { credential?: string }>) => {
    const existing = new Set(sources.filter(source => source.config.type === 'mcp').map(source => source.config.name.toLowerCase()))
    let imported = 0
    let skipped = 0
    const failed: string[] = []
    setBusy(true)
    try {
      for (const entry of entries) {
        if (existing.has(entry.name.toLowerCase())) { skipped++; continue }
        try {
          const created = await window.electronAPI.createSource(workspaceId, { name: entry.name, provider: 'custom', type: 'mcp', mcp: entry.mcp })
          existing.add(entry.name.toLowerCase())
          imported++
          if (entry.credential) await window.electronAPI.saveSourceCredentials(workspaceId, created.slug, entry.credential)
        } catch (error) {
          failed.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      try { await onRefresh() }
      catch (error) {
        toast.error(t('mcpManage.refreshFailed'), { description: error instanceof Error ? error.message : undefined })
      }
      toast[failed.length ? 'warning' : 'success'](t('mcpManage.importResult', { imported, skipped, failed: failed.length }), {
        description: failed.length ? failed.join('\n') : undefined,
      })
      return failed.length === 0
    } finally {
      setBusy(false)
    }
  }

  const handleSingle = async () => {
    const trimmedName = name.trim()
    const trimmedEndpoint = endpoint.trim()
    if (!trimmedName || !trimmedEndpoint) { toast.error(t('mcpManage.required')); return }
    if (transport !== 'stdio') {
      try { const url = new URL(trimmedEndpoint); if (!['http:', 'https:'].includes(url.protocol)) throw new Error() }
      catch { toast.error(t('mcpManage.invalidUrl')); return }
    }
    const mcp = transport === 'stdio'
      ? { transport, command: trimmedEndpoint, args: args.trim() ? args.trim().split(/\s+/) : [] }
      : { transport, url: trimmedEndpoint, authType }
    const success = await importEntries([{ name: trimmedName, mcp, credential: authType === 'bearer' ? token.trim() : undefined }])
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
    if (!window.confirm(t('mcpManage.deleteConfirm', { name: source.config.name }))) return
    setBusy(true)
    try {
      await window.electronAPI.deleteSource(workspaceId, source.config.slug)
      await onRefresh()
      toast.success(t('sourceInfo.deletedSource', { name: source.config.name }))
    }
    catch (error) { toast.error(t('sourceInfo.failedToDelete'), { description: error instanceof Error ? error.message : undefined }) }
    finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('mcpManage.title')}</DialogTitle>
          <DialogDescription>{t('mcpManage.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
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
                if (file) void file.text().then(setBatch).catch(error => toast.error(t('mcpManage.invalidJson'), { description: String(error) }))
              }} />
            </label>
            <Textarea value={batch} onChange={event => setBatch(event.target.value)} rows={7} className="font-mono text-xs" placeholder={'{"mcpServers":{"example":{"url":"https://example.com/mcp"}}}'} aria-label={t('mcpManage.batch')} />
            <Button disabled={busy || !batch.trim()} onClick={() => void handleBatch()}>{t('mcpManage.importBatch')}</Button>
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
        </div>
      </DialogContent>
    </Dialog>
  )
}
