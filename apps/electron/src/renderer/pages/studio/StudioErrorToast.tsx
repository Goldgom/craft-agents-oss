import { createPortal } from 'react-dom'
import { AlertCircle, RotateCcw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { classifyStudioError } from './studio-error'

const copyKeys = {
  policy: ['studio.error.policyTitle', 'studio.error.policyMessage'],
  billing: ['chat.billingErrorTitle', 'chat.billingErrorMessage'],
  auth: ['chat.credentialsErrorTitle', 'chat.credentialsErrorMessage'],
  rate: ['chat.rateLimitedTitle', 'chat.rateLimitedMessage'],
  timeout: ['studio.error.timeoutTitle', 'studio.error.timeoutMessage'],
  network: ['chat.networkErrorTitle', 'chat.networkErrorMessage'],
  service: ['chat.serviceErrorTitle', 'chat.serviceErrorMessage'],
  model: ['studio.error.modelTitle', 'studio.error.modelMessage'],
  request: ['chat.invalidRequestTitle', 'chat.invalidRequestMessage'],
  unknown: ['studio.error.title', 'studio.error.unknownMessage'],
} as const

export function StudioErrorToast({ error, onClose, onRetry }: { error: string; onClose: () => void; onRetry?: () => void }) {
  const { t } = useTranslation()
  if (!error) return null
  const { kind, message } = classifyStudioError(error)
  const title = kind === 'message' ? t('studio.error.title') : t(copyKeys[kind][0])
  const description = kind === 'message' ? message : t(copyKeys[kind][1])
  const retryable = ['timeout', 'network', 'service', 'rate', 'unknown'].includes(kind)

  // Portal out of the scrolling inspector and any translucent/scaled panels.
  return createPortal(<section data-studio-error-toast className="fixed z-[100] w-[380px] max-w-[calc(100vw-32px)] rounded-2xl border border-destructive/30 p-4 text-foreground shadow-modal-small"
    style={{ right: 'max(16px, env(safe-area-inset-right))', bottom: 'max(16px, env(safe-area-inset-bottom))', backgroundColor: 'oklch(from var(--background) l c h / 1)', maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto' }}>
    <div className="flex items-start gap-3">
      <AlertCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1" role="alert" aria-atomic="true">
        <h2 className="text-sm font-semibold leading-6">{title}</h2>
        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <button type="button" aria-label={t('common.close')} onClick={onClose} className="-mr-2 -mt-2 flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="size-4" /></button>
    </div>
    {kind !== 'message' && <details key={error} className="mt-3 border-t border-border pt-2">
      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">{t('chat.showTechnicalDetails')}</summary>
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border p-2 text-[11px] leading-4 text-muted-foreground">{error}</pre>
    </details>}
    {onRetry && retryable && <button type="button" onClick={onRetry} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs hover:bg-accent"><RotateCcw className="size-3.5" />{t('studio.retry')}</button>}
  </section>, document.body)
}
