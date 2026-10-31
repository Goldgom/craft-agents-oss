import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { McpIcon } from '../icons/McpIcon'

/** Historical notices retain a language-neutral marker in stored transcripts. */
export function parseSourceActivation(content: string): string | null {
  return /^\[([^\[\]\s]+) activated\]$/.exec(content)?.[1] ?? null
}

export function SourceActivationNotice({ sourceSlug, className }: { sourceSlug: string; className?: string }) {
  const { t } = useTranslation()
  return <div data-source-activation role="status" className={cn('flex w-fit max-w-full min-w-0 items-center gap-2.5 rounded-lg border border-success/15 bg-success/5 px-3 py-2 text-success', className)}>
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-success/10"><McpIcon aria-hidden="true" className="size-3.5" /></span>
    <span className="min-w-0 break-words text-[13px] leading-5 [overflow-wrap:anywhere]">{t('chat.sourceActivated', { name: sourceSlug })}</span>
  </div>
}
