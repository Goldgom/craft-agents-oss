/**
 * WeComConnectDialog — Bot ID + Secret pairing flow for WeCom (企业微信).
 *
 * Same modal shape as `LarkConnectDialog`. WeCom smart robots use a
 * long-connection (WebSocket) API mode: two secret fields (BotID + Secret)
 * from the robot's API-mode config page in the WeCom admin console.
 */

import * as React from 'react'
import { Check, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@craft-agent/ui'
import { SettingsSecretInput } from '@/components/settings'

interface WeComConnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When true, treat the flow as "replace existing credentials". */
  reconfigure?: boolean
  onSaved?: () => void
}

type TestResult =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'success' }
  | { state: 'error'; error: string }

export function WeComConnectDialog({
  open,
  onOpenChange,
  reconfigure = false,
  onSaved,
}: WeComConnectDialogProps) {
  const { t } = useTranslation()
  const [botId, setBotId] = React.useState('')
  const [secret, setSecret] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [test, setTest] = React.useState<TestResult>({ state: 'idle' })

  React.useEffect(() => {
    if (!open) {
      setBotId('')
      setSecret('')
      setTest({ state: 'idle' })
      setSaving(false)
    }
  }, [open])

  const ready = botId.trim().length > 0 && secret.trim().length > 0

  const handleTest = async () => {
    if (!ready) return
    setTest({ state: 'testing' })
    try {
      const result = await window.electronAPI.testWeComCredentials({
        botId: botId.trim(),
        secret: secret.trim(),
      })
      if (result.success) {
        setTest({ state: 'success' })
      } else {
        setTest({ state: 'error', error: result.error ?? t('common.error') })
      }
    } catch (err) {
      setTest({ state: 'error', error: err instanceof Error ? err.message : t('common.error') })
    }
  }

  const handleSave = async () => {
    if (!ready) return
    setSaving(true)
    try {
      await window.electronAPI.saveWeComCredentials({
        botId: botId.trim(),
        secret: secret.trim(),
      })
      toast.success(t('settings.messaging.wecom.saved'))
      onSaved?.()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.messaging.wecom.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {reconfigure
              ? t('settings.messaging.wecom.reconfigureTitle')
              : t('settings.messaging.wecom.connectTitle')}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-line">
            {t('settings.messaging.wecom.instructions')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div>
            <div className="mb-1.5 text-xs text-muted-foreground">
              {t('settings.messaging.wecom.botIdLabel')}
            </div>
            <SettingsSecretInput
              value={botId}
              onChange={setBotId}
              placeholder={t('settings.messaging.wecom.botIdPlaceholder')}
              disabled={saving}
            />
          </div>

          <div>
            <div className="mb-1.5 text-xs text-muted-foreground">
              {t('settings.messaging.wecom.secretLabel')}
            </div>
            <SettingsSecretInput
              value={secret}
              onChange={setSecret}
              placeholder={t('settings.messaging.wecom.secretPlaceholder')}
              disabled={saving}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={!ready || test.state === 'testing' || saving}
            >
              {test.state === 'testing' && <Spinner className="mr-1 text-[14px]" />}
              {t('settings.messaging.wecom.testConnection')}
            </Button>

            {test.state === 'success' && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                {t('settings.messaging.wecom.testOk')}
              </span>
            )}
            {test.state === 'error' && (
              <span className="inline-flex items-center gap-1 text-xs text-destructive">
                <X className="h-3.5 w-3.5" />
                {test.error}
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSave}
            disabled={!ready || test.state !== 'success' || saving}
          >
            {saving && <Spinner className="mr-1 text-[14px]" />}
            {t('settings.messaging.wecom.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
