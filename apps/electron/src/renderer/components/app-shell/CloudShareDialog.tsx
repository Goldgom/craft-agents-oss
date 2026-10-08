import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function CloudShareDialog({ sessionId, open, onOpenChange }: { sessionId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [url, setUrl] = useState('')
  useEffect(() => { if (open) { setUrl(''); setError('') } }, [open, sessionId])
  return <Dialog open={open} onOpenChange={value => { if (!busy) { onOpenChange(value); if (!value) { setUrl(''); setError('') } } }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{t('cloud.shareChat')}</DialogTitle><DialogDescription>{t('cloud.shareDescription')}</DialogDescription></DialogHeader>
      {error && <p className="text-xs text-destructive break-words">{error}</p>}
      {url && <p className="text-sm break-all">{url}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
        {url ? <Button onClick={() => void navigator.clipboard.writeText(url).then(() => toast.success(t('cloud.copied'))).catch(err => setError(String(err)))}>{t('cloud.copyLink')}</Button> : <Button disabled={busy} onClick={() => {
          setBusy(true); setError('')
          void window.electronAPI.shareCloudChat(sessionId).then(share => setUrl(share.url)).catch(err => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false))
        }}>{t('cloud.publish')}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
