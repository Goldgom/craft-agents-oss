import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import './studio-mobile.css'

export function StudioMobileSheet({ open, onOpenChange, title, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode
}) {
  const { t } = useTranslation()
  const [viewport, setViewport] = useState<CSSProperties>({})
  useEffect(() => {
    if (!open) return
    const subscribedViewport = window.visualViewport
    const update = () => {
      const visible = window.visualViewport
      setViewport({
        '--studio-visible-height': `${visible?.height ?? window.innerHeight}px`,
        '--studio-sheet-height': `${Math.min(window.innerHeight * .78, visible?.height ?? window.innerHeight)}px`,
        '--studio-viewport-top': `${visible?.offsetTop ?? 0}px`,
        '--studio-keyboard-inset': `${Math.max(0, window.innerHeight - (visible?.height ?? window.innerHeight) - (visible?.offsetTop ?? 0))}px`,
      } as CSSProperties)
    }
    update()
    subscribedViewport?.addEventListener('resize', update)
    subscribedViewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      subscribedViewport?.removeEventListener('resize', update)
      subscribedViewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [open])
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent data-studio-mobile-sheet aria-describedby={undefined} showCloseButton={false}
      style={viewport}>
      <div className="studio-sheet-heading">
        <DialogTitle>{title}</DialogTitle>
        <button aria-label={t('common.close')} onClick={() => onOpenChange(false)}><X className="size-5" /></button>
      </div>
      <div className="studio-sheet-body">{children}</div>
    </DialogContent>
  </Dialog>
}
