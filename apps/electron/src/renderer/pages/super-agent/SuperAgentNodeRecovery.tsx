import { RefreshCw } from 'lucide-react'
import type { SuperAgentCommand, SuperAgentNodeRuntime } from '@craft-agent/shared/super-agent'
import { Button } from '@/components/ui/button'
import { formatTimestamp, useSuperAgentText } from './super-agent-ui'

export function SuperAgentNodeRecovery({ runtime, busy, onCommand }: {
  runtime: SuperAgentNodeRuntime
  busy: boolean
  onCommand: (command: SuperAgentCommand) => Promise<void>
}) {
  const text = useSuperAgentText()
  if (!['error', 'recovering'].includes(runtime.status)) return null
  return <div className="space-y-2 text-xs leading-5">
    {runtime.status === 'recovering' && <div role="status" className="text-amber-600 dark:text-amber-400">
      <p>{text('recoveryNotice', { attempt: Math.max(1, runtime.retryAttempt ?? 1) })}</p>
      {runtime.retryAt != null && <p>{text('recoveryNext', { time: formatTimestamp(runtime.retryAt, true) })}</p>}
      {runtime.retryDeadline != null && <p>{text('recoveryDeadline', { time: formatTimestamp(runtime.retryDeadline, true) })}</p>}
    </div>}
    <p className="text-[11px] text-muted-foreground">{text('nodeRefreshHint')}</p>
    <Button size="sm" variant="outline" disabled={busy} onClick={() => { void onCommand({ type: 'node-refresh', nodeId: runtime.nodeId }).catch(() => {}) }}>
      <RefreshCw className="size-3.5" />{text(runtime.status === 'recovering' ? 'retryNodeNow' : 'refreshNode')}
    </Button>
  </div>
}
