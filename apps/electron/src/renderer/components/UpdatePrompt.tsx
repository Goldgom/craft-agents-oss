import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { UpdateInfo } from '../../shared/types'
import { useRegisterModal } from '@/context/ModalContext'

interface UpdatePromptProps {
  info: UpdateInfo | null
  version: string | null
  onInstall: () => void
  onDismiss: () => void
}

export function UpdatePrompt({ info, version, onInstall, onDismiss }: UpdatePromptProps) {
  const { t } = useTranslation()
  const ready = info?.downloadState === 'ready'
  const downloading = info?.downloadState === 'downloading'
  useRegisterModal(Boolean(version), onDismiss)

  return (
    <Dialog open={Boolean(version && info?.available)} onOpenChange={open => !open && onDismiss()}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('updatePrompt.title', { version })}</DialogTitle>
          <DialogDescription>
            {ready ? t('toast.restartToApply') : t('updatePrompt.description')}
          </DialogDescription>
        </DialogHeader>
        {downloading && (
          <div className="space-y-2 text-sm text-muted-foreground">
            <div>{t('settings.about.downloading', { version, percent: info.downloadProgress })}</div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${info.downloadProgress}%` }} />
            </div>
          </div>
        )}
        {info?.downloadState === 'error' && (
          <p className="text-sm text-destructive">{info.error}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss}>{t('updatePrompt.later')}</Button>
          <Button disabled={!ready} onClick={onInstall}>{t('updatePrompt.install')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
