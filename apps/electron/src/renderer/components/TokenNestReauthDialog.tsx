import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useRegisterModal } from '@/context/ModalContext'
import type { TokenNestAuthorizationIssue } from '@craft-agent/shared/auth'

interface Props {
  issue: TokenNestAuthorizationIssue | null
  signingIn: boolean
  error: string | null
  onDismiss: () => void
  onSignIn: () => void
}

export function TokenNestReauthDialog({ issue, signingIn, error, onDismiss, onSignIn }: Props) {
  const { t } = useTranslation()
  useRegisterModal(issue !== null, onDismiss)

  return (
    <Dialog open={issue !== null} onOpenChange={open => !open && !signingIn && onDismiss()}>
      <DialogContent className="sm:max-w-md" showCloseButton={!signingIn}>
        <DialogHeader>
          <DialogTitle>{t('dialog.tokenNestReauth.title')}</DialogTitle>
          <DialogDescription className="pt-1 text-left">
            {issue?.reason === 'missing_scopes'
              ? t('dialog.tokenNestReauth.missingScopes')
              : t('dialog.tokenNestReauth.expired')}
          </DialogDescription>
        </DialogHeader>
        {issue?.missingScopes?.length ? (
          <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {issue.missingScopes.join(', ')}
          </p>
        ) : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" disabled={signingIn} onClick={onDismiss}>
            {t('dialog.tokenNestReauth.later')}
          </Button>
          <Button disabled={signingIn} onClick={onSignIn}>
            {t('settings.ai.tokenNestReconnect')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
