import type { ReactNode } from 'react'
import { ChevronRight, MessagesSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentMessageEnvelope } from './agent-message'

/** A peer message is distinct from a human's right-aligned chat bubble. */
export function AgentMessageCard({ envelope, children }: { envelope: AgentMessageEnvelope; children: ReactNode }) {
  const { t } = useTranslation()
  return <article data-agent-message className="w-full min-w-0 self-stretch overflow-hidden rounded-xl border border-accent/20 bg-background/60 text-foreground select-text">
    <header className="flex items-center gap-2.5 border-b border-accent/10 bg-accent/5 px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"><MessagesSquare aria-hidden="true" className="size-4" /></span>
      <div className="min-w-0">
        <p className="text-[10px] font-medium tracking-wide text-muted-foreground">{t('chat.agentMessage.label')}</p>
        <p className="mt-0.5 break-words text-xs font-semibold [overflow-wrap:anywhere]">{envelope.senderName}</p>
      </div>
    </header>
    <div className="min-w-0 break-words px-4 py-3 text-sm leading-6 [overflow-wrap:anywhere] [&_p]:m-0">{children}</div>
    <details className="group/agent-message border-t border-foreground/5 px-4 py-2">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-[10px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-3 transition-transform group-open/agent-message:rotate-90" />{t('chat.agentMessage.details')}
      </summary>
      <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">{envelope.header}</pre>
    </details>
  </article>
}
