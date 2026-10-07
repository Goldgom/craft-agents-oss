import type { SuperAgentNode, SuperAgentDocument } from '@craft-agent/shared/super-agent'

/** Lower bounds from durable state, never an invented estimate of model execution time. */
export function nodeSchedulingState(document: SuperAgentDocument, node: SuperAgentNode, now: number) {
  const runtime = document.state.nodes.find(item => item.nodeId === node.id)
  const turns = document.pendingTurns.filter(turn => turn.nodeId === node.id)
  const busy = runtime?.status === 'working' || runtime?.status === 'preparing' || turns.some(turn => turn.startedAt != null)
  const retryAt = Math.max(runtime?.retryAt ?? 0, ...turns.map(turn => turn.retryAt ?? 0))
  const rateLimitAt = runtime?.lastStartedAt == null ? 0 : runtime.lastStartedAt + 60_000 / node.maxCallsPerMinute
  const notBefore = Math.max(now, rateLimitAt, retryAt)
  return {
    queuedTurns: turns.filter(turn => turn.startedAt == null).length,
    activeTurns: turns.filter(turn => turn.startedAt != null).length,
    busy,
    needsRecovery: runtime?.status === 'error' || runtime?.status === 'recovering',
    nextStartNotBefore: notBefore,
    startDelayMs: Math.max(0, notBefore - now),
    lastAssignedAt: Math.max(0, ...document.state.tasks.filter(task => task.nodeId === node.id).map(task => task.createdAt)),
    lastAssignmentOrder: document.state.tasks.findLastIndex(task => task.nodeId === node.id) + 1,
  }
}

/** Automatic fallback only: the coordinator should name a worker for specialized tasks. */
export function selectSuperAgentWorker(document: SuperAgentDocument, now: number): SuperAgentNode | undefined {
  const candidates = document.config?.nodes.filter(node => node.role === 'worker').map(node => ({ node, state: nodeSchedulingState(document, node, now) })) ?? []
  return candidates.sort((a, b) => Number(a.state.needsRecovery) - Number(b.state.needsRecovery)
    || Number(a.state.busy) - Number(b.state.busy)
    || a.state.queuedTurns - b.state.queuedTurns
    || a.state.startDelayMs - b.state.startDelayMs
    || a.state.lastAssignedAt - b.state.lastAssignedAt
    || a.state.lastAssignmentOrder - b.state.lastAssignmentOrder
    || (document.state.nodes.find(node => node.nodeId === a.node.id)?.lastStartedAt ?? 0) - (document.state.nodes.find(node => node.nodeId === b.node.id)?.lastStartedAt ?? 0))[0]?.node
}

/** Prompt/display edits retain transcripts; provider, thinking, sources and environment changes do not. */
export function sameNodeSessionIdentity(before: SuperAgentNode | undefined, after: SuperAgentNode): boolean {
  return !!before && before.role === after.role && before.llmConnection === after.llmConnection
    && before.model === after.model && before.thinkingLevel === after.thinkingLevel
    && [...before.sourceSlugs].sort().join('\0') === [...after.sourceSlugs].sort().join('\0')
}
