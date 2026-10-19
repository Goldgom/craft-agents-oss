import { AlertCircle, ChevronDown } from 'lucide-react'
import type { SuperAgentBlockingReport } from './super-agent-blockers'
import type { SuperAgentText } from './super-agent-ui'

export function SuperAgentBlockingCard({ report, text, disabled, onProvideInput }: {
  report: SuperAgentBlockingReport; text: SuperAgentText; processing: boolean; disabled: boolean
  onProvideInput: (report: SuperAgentBlockingReport) => void
}) {
  if (!report.requiresUserAction || report.kind !== 'user') return null
  const summary = report.summary ?? text('blockerUnspecifiedSummary')
  const systemAction = report.systemAction ?? text('blockerInputNext')
  return <article className="min-w-0 space-y-4 rounded-xl border border-amber-500/20 bg-background/50 p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h3 className="min-w-0 break-words text-sm font-medium">{report.title}</h3>
      <span className="rounded-md bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-700 dark:text-amber-400">{text('blockerNeedsInput')}</span>
    </div>
    <dl className="space-y-3 text-xs leading-5">
      <div><dt className="mb-1 font-medium text-muted-foreground">{text('blockerCurrent')}</dt><dd className="flex items-start gap-2"><AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-amber-600" /><span className="whitespace-pre-wrap break-words">{summary}</span></dd></div>
      {(report.submittedCount > 0 || report.artifactCount > 0) && <div><dt className="mb-1 font-medium text-muted-foreground">{text('blockerProgress')}</dt><dd>{text('blockerProgressSummary', { tasks: report.submittedCount, artifacts: report.artifactCount })}</dd></div>}
      <div className="rounded-lg bg-foreground/5 px-3 py-2.5"><dt className="mb-1 font-medium">{text('blockerUserAction')}</dt><dd className="whitespace-pre-wrap break-words">{report.userAction}</dd></div>
      <div><dt className="mb-1 font-medium text-muted-foreground">{text('blockerSystemNext')}</dt><dd className="whitespace-pre-wrap break-words">{systemAction}</dd></div>
    </dl>
    <button type="button" disabled={disabled} onClick={() => onProvideInput(report)}
      className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 text-xs font-medium transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50">{text('blockerProvideInput')}</button>
    {(report.details || report.operations.length > 0) && <details className="group text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground [&::-webkit-details-marker]:hidden">{text('blockerTechnicalDetails')}<ChevronDown aria-hidden="true" className="size-3 transition-transform group-open:rotate-180" /></summary>
      <div className="mt-2 max-h-64 space-y-3 overflow-auto rounded-lg bg-foreground/5 p-3 text-[11px] leading-5">
        {report.operations.length > 0 && <ul className="space-y-2">{report.operations.map(operation => <li key={operation.id} className="break-all"><p className="font-medium">{operation.toolName} · {operation.status}</p><p className="font-mono text-muted-foreground">{operation.id}</p></li>)}</ul>}
        {report.details && <p className="whitespace-pre-wrap break-words">{report.details}</p>}
      </div>
    </details>}
  </article>
}
