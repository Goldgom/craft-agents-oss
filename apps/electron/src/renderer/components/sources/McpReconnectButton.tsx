import * as React from 'react'
import { KeyRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Spinner } from '@craft-agent/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { mcpReauthMode, serializeMcpCredential } from '@/lib/mcp-reauth'
import type { LoadedSource } from '../../../shared/types'

/** Mount keyed by workspace/source so secrets and pending UI never cross targets. */
export function McpReconnectButton({ workspaceId, source, onReconnect }: {
  workspaceId: string
  source: LoadedSource
  onReconnect: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [values, setValues] = React.useState<Record<string, string>>({})
  const [busy, setBusy] = React.useState(false)
  const busyRef = React.useRef(false)
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const mode = mcpReauthMode(source)
  const headers = source.config.mcp?.headerNames ?? []
  const fields = headers.length ? headers : ['token']
  const close = () => { setOpen(false); setValues({}) }

  const reconnect = async () => {
    if (!mode || busyRef.current) return
    if (mode === 'credential' && !fields.every(field => values[field]?.trim())) return
    busyRef.current = true
    setBusy(true)
    try {
      if (mode === 'oauth') {
        const result = await window.electronAPI.performOAuth({ sourceSlug: source.config.slug })
        if (!mounted.current) return
        if (!result.success) {
          toast.error(t('toast.pageSourceReconnectFailed', { name: source.config.name }))
          return
        }
      } else {
        const result = await window.electronAPI.saveSourceCredentialsBatch(workspaceId, [{
          sourceSlug: source.config.slug,
          credential: serializeMcpCredential(headers, values),
        }])
        if (!mounted.current) return
        close()
        toast.success(t('mcpManage.credentialsSaved', { count: result.saved }))
        if (result.statusUpdateFailed.length) toast.warning(t('mcpManage.credentialStatusWarning'))
      }
      if (mounted.current) await onReconnect()
    } catch {
      // Do not echo server errors that might contain submitted credentials.
      if (mounted.current) toast.error(t('toast.pageSourceReconnectFailed', { name: source.config.name }))
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }

  if (!mode) return null
  return <>
    <Button variant="outline" size="sm" disabled={busy} onClick={() => {
      if (mode === 'oauth') void reconnect()
      else setOpen(true)
    }}>
      {busy ? <Spinner className="text-xs" /> : <KeyRound className="mr-1.5 h-3.5 w-3.5" />}
      {t(busy ? 'pages.auth.reconnecting' : 'pages.auth.reconnect')}
    </Button>
    <Dialog open={open} onOpenChange={next => { if (!next && !busyRef.current) close() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('pages.auth.credentialTitle', { name: source.config.name })}</DialogTitle>
          <DialogDescription>{t('pages.auth.credentialDescription')}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void reconnect() }}>
          {fields.map((field, index) => <label key={field} className="flex flex-col gap-1.5 text-sm">
            {headers.length ? field : t('pages.auth.credentialLabel')}
            <Input type="password" autoComplete="off" autoFocus={index === 0} disabled={busy}
              value={values[field] ?? ''} onChange={event => setValues(current => ({ ...current, [field]: event.target.value }))} />
          </label>)}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={busy || !fields.every(field => values[field]?.trim())}>
              {busy && <Spinner className="text-xs" />}{t('pages.auth.credentialSave')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>
}