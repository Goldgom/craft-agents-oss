import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useRegisterModal } from '@/context/ModalContext'

export function OAuthReauthDialog({ connectionName, onDismiss, onSignIn }: {
  connectionName: string | null
  onDismiss: () => void
  onSignIn: () => void
}) {
  const { t } = useTranslation()
  useRegisterModal(connectionName !== null, onDismiss)
  return (
    <Dialog open={connectionName !== null} onOpenChange={open => !open && onDismiss()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('chat.loginExpiredTitle')}</DialogTitle>
          <DialogDescription>{t('chat.loginExpiredMessage')}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{connectionName}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss}>{t('dialog.tokenNestReauth.later')}</Button>
          <Button onClick={onSignIn}>{t('settings.ai.tokenNestReconnect')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
