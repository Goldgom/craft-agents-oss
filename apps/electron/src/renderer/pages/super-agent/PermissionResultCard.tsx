import { Check, ChevronDown, History, ShieldCheck, X } from 'lucide-react'
import type { SuperAgentText } from './super-agent-ui'
import type { PermissionNotice } from './super-agent-permission-notice'

export function PermissionResultCard({ notice, owner, timestamp, text }: {
  notice: PermissionNotice
  owner: string
  timestamp: string
  text: SuperAgentText
}) {
  const { record, legacyDetails } = notice
  const status = record.status
  const approved = status === 'approved'
  const color = approved ? 'text-emerald-600 dark:text-emerald-400'
    : status === 'denied' ? 'text-destructive' : status === 'pending' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
  const Icon = approved ? Check : status === 'denied' ? X : status === 'pending' ? ShieldCheck : History
  const operation = record.operation ?? record.command
  return <details className="group min-w-0 rounded-xl border border-border/60 bg-foreground/2">
    <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
      <span className={`flex size-7 shrink-0 items-center justify-center rounded-lg bg-background ${color}`}><Icon className="size-3.5" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"><span className={`font-medium ${color}`}>{text(status === 'archived' ? 'approvalArchived' : status === 'pending' ? 'waitingPermission' : status)}</span><span className="truncate text-muted-foreground">{owner}</span></div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{[record.toolName, record.target ?? record.description].filter(Boolean).join(' · ')}</p>
      </div>
      <span className="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">{timestamp}</span>
      <ChevronDown className="size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-label={text('approvalDetails')} />
    </summary>
    <div className="space-y-3 border-t border-border/50 px-3 py-3 text-xs leading-5">
      <p className="text-[10px] text-muted-foreground sm:hidden">{timestamp}</p>
      {legacyDetails ? <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">{legacyDetails}</pre>
        : <>
          <p className="whitespace-pre-wrap break-words text-foreground/80">{record.description}</p>
          {record.target && <div><p className="text-muted-foreground">{text('approvalTarget')}</p><p className="break-all font-mono text-[11px]">{record.target}</p></div>}
          {record.reason && <div><p className="text-muted-foreground">{text('approvalReason')}</p><p className="whitespace-pre-wrap break-words text-foreground/80">{record.reason}</p></div>}
          {operation && <div><p className="mb-1 text-muted-foreground">{text('approvalOperation')}</p><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background/80 p-2 font-mono text-[11px]">{operation}</pre></div>}
          {record.command && record.command !== operation && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{record.command}</pre>}
        </>}
    </div>
  </details>
}
