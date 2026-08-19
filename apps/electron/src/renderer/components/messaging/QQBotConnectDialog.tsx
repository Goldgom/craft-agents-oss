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
      if (!result.success) throw new Error(result.error ?? 'QQ Bot connection failed')
      await window.electronAPI.saveQQBotCredentials({ appId: appId.trim(), token: token.trim() })
      toast.success(t('settings.messaging.qqbot.saved', { defaultValue: 'QQ Bot 已连接' })); onOpenChange(false)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'QQ Bot 连接失败') } finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>{t('settings.messaging.qqbot.connectTitle', { defaultValue: '连接 QQ Bot' })}</DialogTitle></DialogHeader>
    <div className="space-y-3 py-2">
      <Input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="App ID（机器人 ID）" autoComplete="off" />
      <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="AppSecret" type="password" autoComplete="off" />
      <p className="text-xs text-muted-foreground">使用 QQ 开放平台机器人页面显示的 AppSecret。服务端会自动换取短期 Access Token，请勿填写旧版 AppToken。</p>
    </div>
    <DialogFooter><Button onClick={() => void submit()} disabled={busy || !appId.trim() || !token.trim()}>{busy ? '连接中…' : '连接'}</Button></DialogFooter>
  </DialogContent></Dialog>
}
