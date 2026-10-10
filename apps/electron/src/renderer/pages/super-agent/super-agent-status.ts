import type { SuperAgentActivityEntry, SuperAgentSnapshot } from '@craft-agent/shared/super-agent'
import { superAgentTaskBlocker } from '@craft-agent/shared/super-agent'
import type { PermissionRequest } from '../../../shared/types'

export type SuperAgentWorkStatus = 'idle' | 'thinking' | 'working' | 'preparing' | 'recovering'
  | 'waiting_permission' | 'error' | 'queued' | 'blocked' | 'waiting' | 'unavailable'

/** Use live events only while they belong to the node's current session and turn. */
export function nodeWorkStatus(
  snapshot: SuperAgentSnapshot,
  nodeId: string,
  pendingPermissions: Map<string, PermissionRequest[]> = new Map(),
): SuperAgentWorkStatus {
  const runtime = snapshot.state.nodes.find(node => node.nodeId === nodeId)
  if (runtime?.status === 'error' || runtime?.status === 'recovering') return runtime.status
  if (runtime && (runtime.status === 'working' || runtime.status === 'preparing')) {
    const activity = snapshot.activity?.find(item => item.nodeId === nodeId && item.sessionId === runtime.sessionId
      && (runtime.lastStartedAt == null || item.startedAt >= runtime.lastStartedAt))
    const awaitingApproval = snapshot.permissionRequests?.some(request => request.nodeId === nodeId
      && request.sessionId === runtime.sessionId && request.status === 'pending')
      || (runtime.sessionId != null && (pendingPermissions.get(runtime.sessionId)?.length ?? 0) > 0)
    if (awaitingApproval || activity?.status === 'waiting_permission') return 'waiting_permission'
    if (runtime.status === 'preparing') return 'preparing'
    if (activity?.status === 'recovering' || activity?.status === 'error') return activity.status
    // Tools may run concurrently with model output; active execution takes precedence.
    if (activity?.entries.some(entry => entry.kind === 'tool' && entry.status === 'running')) return 'working'
    const output = activity?.entries.filter(entry => entry.kind === 'thinking' || entry.kind === 'text')
      .reduce<SuperAgentActivityEntry | undefined>(
        (latest, entry) => !latest || entry.updatedAt >= latest.updatedAt ? entry : latest, undefined)
    return output?.kind === 'thinking' && output.status === 'running' ? 'thinking' : 'working'
  }
  if (snapshot.state.scripts.some(script => script.status === 'running'
    && (snapshot.state.tasks.find(task => task.id === script.taskId)?.nodeId
      ?? snapshot.config?.scripts.find(config => config.id === script.scriptId)?.nodeId) === nodeId)) return 'working'
  const tasks = snapshot.state.tasks.filter(task => task.nodeId === nodeId)
  if (tasks.some(task => task.status === 'running' && task.phase !== 'waiting')) return 'working'
  if (tasks.some(task => task.status === 'queued' && task.phase !== 'waiting' && !superAgentTaskBlocker(snapshot.state, task))) return 'queued'
  if (tasks.some(task => task.status === 'queued' && superAgentTaskBlocker(snapshot.state, task))) return 'blocked'
  if (tasks.some(task => (task.status === 'queued' || task.status === 'running') && task.phase === 'waiting')) return 'waiting'
  return 'idle'
}

/** A busy worker keeps the team busy even when the coordinator is idle. */
export function teamWorkStatus(snapshot: SuperAgentSnapshot, pendingPermissions: Map<string, PermissionRequest[]> = new Map()) {
  const nodes = (snapshot.config?.nodes ?? []).map(node => ({
    nodeId: node.id, name: node.name, status: nodeWorkStatus(snapshot, node.id, pendingPermissions),
  }))
  const priority: SuperAgentWorkStatus[] = ['working', 'thinking', 'preparing', 'waiting_permission', 'recovering', 'error', 'queued', 'blocked', 'waiting']
  const statuses = new Set<SuperAgentWorkStatus>(nodes.map(node => node.status))
  if (snapshot.state.scripts.some(script => script.status === 'running')) statuses.add('working')
  // Unassigned work can be queued before an executor node is selected.
  const nodeIds = new Set(nodes.map(node => node.nodeId))
  for (const task of snapshot.state.tasks.filter(task => !nodeIds.has(task.nodeId))) {
    if (task.status !== 'running' && task.status !== 'queued') continue
    statuses.add(task.status === 'queued' && superAgentTaskBlocker(snapshot.state, task) ? 'blocked' : task.phase === 'waiting' ? 'waiting' : task.status === 'running' ? 'working' : 'queued')
  }
  if (snapshot.state.plans.some(plan => plan.status === 'blocked')) statuses.add('blocked')
  const status: SuperAgentWorkStatus = !snapshot.environment.available ? 'unavailable'
    : priority.find(value => statuses.has(value)) ?? 'idle'
  return { status, nodes }
}
