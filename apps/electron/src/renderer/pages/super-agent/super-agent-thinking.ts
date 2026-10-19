import type { SuperAgentSnapshot } from '@tokenbird/shared/super-agent'

export type SuperAgentThinkingPhase = 'mainQueued' | 'mainPreparing' | 'mainThinking' | 'mainReplying' | 'mainRecovering'

export function superAgentThinkingPhase(snapshot: SuperAgentSnapshot, sending = false, waitingForPermission = false): SuperAgentThinkingPhase | undefined {
  const coordinator = snapshot.config?.nodes.find(node => node.role === 'coordinator')
  if (!coordinator || waitingForPermission) return
  const runtime = snapshot.state.nodes.find(node => node.nodeId === coordinator.id)
  const activity = snapshot.activity?.find(item => item.nodeId === coordinator.id && item.sessionId === runtime?.sessionId)
  if (activity?.status === 'waiting_permission' && runtime?.status === 'working') return
  if (sending) return 'mainQueued'
  if (runtime?.status === 'error') return
  if (runtime?.status === 'preparing') return 'mainPreparing'
  if (runtime?.status === 'recovering') return 'mainRecovering'
  if (runtime?.status === 'working') {
    const latest = activity?.entries.findLast(entry => entry.kind === 'text' || entry.kind === 'thinking')
    return latest?.kind === 'text' ? 'mainReplying' : 'mainThinking'
  }
  if (snapshot.interactionPending && !snapshot.recoverySuspended) return 'mainQueued'
}
