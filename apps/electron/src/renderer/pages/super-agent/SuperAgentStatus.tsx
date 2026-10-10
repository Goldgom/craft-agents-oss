import { Activity, BrainCircuit, CircleAlert, CircleOff, Clock3, Coffee, LoaderCircle, Pause, ShieldCheck } from 'lucide-react'
import type { SuperAgentSnapshot } from '@craft-agent/shared/super-agent'
import type { PermissionRequest } from '../../../shared/types'
import { cn } from '@/lib/utils'
import { useSuperAgentText, type SuperAgentTextKey } from './super-agent-ui'
import { teamWorkStatus, type SuperAgentWorkStatus } from './super-agent-status'

const statusKeys: Record<SuperAgentWorkStatus, SuperAgentTextKey> = {
  idle: 'workStatusIdle', thinking: 'workStatusThinking', working: 'working', preparing: 'preparing',
  recovering: 'recovering', waiting_permission: 'waitingPermission', error: 'error',
  queued: 'queued', blocked: 'queueBlocked', waiting: 'taskWaiting', unavailable: 'workStatusUnavailable',
}
const icons = {
  idle: Coffee, thinking: BrainCircuit, working: Activity, preparing: LoaderCircle,
  recovering: LoaderCircle, waiting_permission: ShieldCheck, error: CircleAlert,
  queued: Clock3, blocked: CircleAlert, waiting: Pause, unavailable: CircleOff,
}

export function SuperAgentStatus({ snapshot, pendingPermissions }: {
  snapshot: SuperAgentSnapshot
  pendingPermissions: Map<string, PermissionRequest[]>
}) {
  const text = useSuperAgentText()
  const { status, nodes } = teamWorkStatus(snapshot, pendingPermissions)
  const label = text(statusKeys[status])
  const Icon = icons[status]
  const running = status === 'working' || status === 'thinking' || status === 'preparing'
  const warning = status === 'recovering' || status === 'waiting_permission' || status === 'waiting' || status === 'blocked'
  return <span role="status" aria-live="polite" aria-atomic="true" aria-label={`${text('workStatus')}: ${label}`}
    title={[`${text('workStatus')}: ${label}`, ...nodes.map(node => `${node.name}: ${text(statusKeys[node.status])}`)].join('\n')}
    className={cn('ml-2 inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-1 text-[10px] font-medium',
      running ? 'bg-primary/10 text-primary' : warning ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
        : status === 'error' || status === 'unavailable' ? 'bg-destructive/10 text-destructive' : 'bg-foreground/5 text-muted-foreground')}>
    <Icon aria-hidden="true" className={cn('size-3', (status === 'preparing' || status === 'recovering') && 'animate-spin motion-reduce:animate-none',
      (status === 'working' || status === 'thinking') && 'animate-pulse motion-reduce:animate-none')} />
    {label}
  </span>
}
