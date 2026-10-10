import type { SuperAgentSnapshot } from '@craft-agent/shared/super-agent'
import { formatTimestamp, useSuperAgentText } from './super-agent-ui'

export function SuperAgentStatistics({ snapshot }: { snapshot: SuperAgentSnapshot }) {
  const text = useSuperAgentText()
  const { state } = snapshot
  const metrics = state.metrics
  const rows = state.statistics?.nodes ?? []
  const outputTokens = rows.reduce((sum, row) => sum + row.outputTokens, 0)
  const cost = rows.reduce((sum, row) => sum + row.costUsd, 0)
  const usageCount = rows.reduce((sum, row) => sum + row.usageObservations, 0)
  const costCount = rows.reduce((sum, row) => sum + row.costObservations, 0)
  const turns = rows.reduce((sum, row) => sum + row.turns, 0)
  const duration = (ms: number) => `${(ms / 60_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} min`
  const cards = [
    ['modelTurns', metrics?.modelTurns ?? 0], ['toolCalls', metrics?.toolCalls ?? 0],
    ['retryCount', metrics?.retries ?? 0], ['resumeCount', metrics?.resumptions ?? 0],
    ['executionTime', duration(rows.reduce((sum, row) => sum + row.executionMs, 0))], ['queueTime', duration(metrics?.queueMs ?? 0)],
    ['retainedTasks', state.tasks.length], ['acceptedTasks', state.tasks.filter(task => task.acceptance?.status === 'accepted').length],
    ['failedTasks', state.tasks.filter(task => task.status === 'failed' || task.status === 'cancelled').length],
    ['deliveredGoals', state.intents?.filter(goal => goal.status === 'delivered').length ?? 0],
    ['observedOutputTokens', usageCount ? outputTokens.toLocaleString() : text('noUsage')],
    ['recordedCost', costCount ? `$${cost.toFixed(6)}` : text('noUsage')],
  ] as const
  return <div className="mx-auto max-w-5xl space-y-5 p-6">
    <div><h2 className="text-lg font-semibold">{text('statistics')}</h2><p className="mt-2 text-xs leading-5 text-muted-foreground">{text('statisticsHint')}</p></div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{cards.map(([key, value]) => <div key={key} className="rounded-xl border border-border/70 p-4"><p className="text-xs text-muted-foreground">{text(key)}</p><p className="mt-2 text-xl font-semibold tabular-nums">{value}</p></div>)}</div>
    {state.statistics && <p className="text-xs text-muted-foreground">{text('statisticsSince', { time: formatTimestamp(state.statistics.since, true) })}</p>}
    <p className="rounded-xl bg-primary/5 p-4 text-xs leading-5 text-muted-foreground">{text('usageCoverage', { count: usageCount, total: turns })}</p>
    {!rows.length ? <p className="text-sm text-muted-foreground">{text('noStatistics')}</p> : <div className="overflow-x-auto rounded-xl border border-border/70">
      <table className="w-full text-left text-xs"><thead><tr className="border-b border-border bg-foreground/4">{(['name', 'model', 'modelTurns', 'toolCalls', 'failures', 'executionTime', 'observedOutputTokens', 'recordedCost'] as const).map(key => <th key={key} className="whitespace-nowrap p-3 font-medium">{text(key)}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={`${row.nodeId}:${row.model}`} className="border-b border-border/50 last:border-0">
          <td className="p-3">{row.name}</td><td className="p-3">{row.model}</td><td className="p-3 tabular-nums">{row.turns}</td><td className="p-3 tabular-nums">{row.toolCalls}</td><td className="p-3 tabular-nums">{row.failures}</td>
          <td className="whitespace-nowrap p-3">{duration(row.executionMs)}</td><td className="p-3 tabular-nums">{row.usageObservations ? row.outputTokens.toLocaleString() : text('noUsage')}</td><td className="p-3 tabular-nums">{row.costObservations ? `$${row.costUsd.toFixed(6)}` : text('noUsage')}</td>
        </tr>)}</tbody></table>
    </div>}
  </div>
}
