import type { SuperAgentMessage, SuperAgentSnapshot, SuperAgentTask } from '@craft-agent/shared/super-agent'
import type { PermissionRequest } from '../../../shared/types'

export type SuperAgentActivity = NonNullable<SuperAgentSnapshot['activity']>[number]
export type SuperAgentApproval = NonNullable<SuperAgentSnapshot['permissionRequests']>[number]

/** Hide the complete control block as well as a block still arriving in chunks. */
export function visibleActivityText(value: string): string {
  let content = value
    .replace(/<super_agent_actions>[\s\S]*?(?:<\/super_agent_actions>|$)/gi, '')
    .replace(/<super_agent_actions[^>]*$/gi, '')
  const opening = content.lastIndexOf('<')
  if (opening >= 0 && '<super_agent_actions>'.startsWith(content.slice(opening).toLowerCase())) content = content.slice(0, opening)
  return content.trim()
}

/** The durable reply replaces its streamed copy without hiding real commentary. */
export function visibleActivityEntries(activity: SuperAgentActivity, messages: SuperAgentMessage[]) {
  return activity.entries.filter(entry => {
    const content = visibleActivityText(entry.text)
    if (!content && entry.kind !== 'tool') return false
    if (entry.kind !== 'text' || entry.status === 'running') return true
    return !messages.some(message => message.fromNodeId === activity.nodeId
      && message.toNodeId === 'user'
      && message.createdAt >= activity.startedAt
      && visibleActivityText(message.body) === content)
  })
}

/** Prefer the persisted coordinator inbox, including records already resolved. */
export function ordinaryPermissionHeads(
  sessionIds: Set<string>,
  pending: Map<string, PermissionRequest[]>,
  inbox: SuperAgentApproval[],
): PermissionRequest[] {
  const tracked = new Set(inbox.map(request => request.sessionId + ':' + request.id))
  return [...pending.entries()].flatMap(([sessionId, requests]) => {
    const head = requests[0]
    return sessionIds.has(sessionId) && head && !tracked.has(sessionId + ':' + head.requestId) ? [head] : []
  })
}

/** Task/session correlation prevents current output from attaching to an old task. */
export function taskActivity(snapshot: SuperAgentSnapshot, task: SuperAgentTask): SuperAgentActivity | undefined {
  if (task.status !== 'running') return undefined
  return snapshot.activity?.find(activity => activity.nodeId === task.nodeId && activity.taskId === task.id
    && (!task.sessionId || task.sessionId === activity.sessionId))
}

export function tasklessWorkerActivities(snapshot: SuperAgentSnapshot): SuperAgentActivity[] {
  const workers = new Set(snapshot.config?.nodes.filter(node => node.role === 'worker').map(node => node.id))
  return snapshot.activity?.filter(activity => workers.has(activity.nodeId) && !activity.taskId
    && snapshot.state.nodes.some(node => node.nodeId === activity.nodeId && node.sessionId === activity.sessionId
      && (node.status === 'working' || node.status === 'preparing' || node.status === 'error'))) ?? []
}

/** Bound progress disclosures to the most recently updated, visible provider events. */
export function recentActivityEntries(activity: SuperAgentActivity, limit = 4): SuperAgentActivity['entries'] {
  return visibleActivityEntries(activity, []).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function recentPermissionResolutions(inbox: SuperAgentApproval[], limit = 4): SuperAgentApproval[] {
  return inbox.filter(request => request.status !== 'pending')
    .sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt)).slice(0, limit)
}
