import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function QQBotConnectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(); const [appId, setAppId] = React.useState(''); const [token, setToken] = React.useState(''); const [busy, setBusy] = React.useState(false)
  const submit = async () => {
    if (!appId.trim() || !token.trim()) return
    setBusy(true)
    try {
      const result = await window.electronAPI.testQQBotCredentials({ appId: appId.trim(), token: token.trim() })
      if (!result.success) throw new Error(result.error ?? t('settings.messaging.qqbot.connectionFailed'))
      await window.electronAPI.saveQQBotCredentials({ appId: appId.trim(), token: token.trim() })
      toast.success(t('settings.messaging.qqbot.saved', { defaultValue: 'QQ Bot 已连接' })); onOpenChange(false)
    } catch (error) { toast.error(error instanceof Error ? error.message : t('settings.messaging.qqbot.connectionFailed')) } finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>{t('settings.messaging.qqbot.connectTitle')}</DialogTitle></DialogHeader>
    <div className="space-y-3 py-2">
      <Input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder={t('settings.messaging.qqbot.appIdPlaceholder')} aria-label={t('settings.messaging.qqbot.appIdLabel')} autoComplete="off" />
      <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder={t('settings.messaging.qqbot.appSecretPlaceholder')} aria-label={t('settings.messaging.qqbot.appSecretLabel')} type="password" autoComplete="off" />
      <p className="text-xs text-muted-foreground">{t('settings.messaging.qqbot.instructions')}</p>
    </div>
    <DialogFooter><Button onClick={() => void submit()} disabled={busy || !appId.trim() || !token.trim()}>{busy ? t('settings.messaging.qqbot.connecting') : t('settings.messaging.qqbot.connect')}</Button></DialogFooter>
  </DialogContent></Dialog>
}
