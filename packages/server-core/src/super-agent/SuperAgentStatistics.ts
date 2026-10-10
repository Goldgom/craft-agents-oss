import type { SuperAgentDocument, SuperAgentNode, SuperAgentPendingTurn } from '@craft-agent/shared/super-agent'
import type { SessionCompletionEvent } from '../sessions/SessionManager'

export const finiteUsage = (value: number | undefined) => Number.isFinite(value) && value! >= 0 ? value! : 0

export function statisticsForNode(document: SuperAgentDocument, node: SuperAgentNode, now: number) {
  const statistics = document.state.statistics ??= { since: now, nodes: [] }
  let row = statistics.nodes.find(row => row.nodeId === node.id && row.model === node.model)
  if (!row) {
    row = { nodeId: node.id, name: node.name, role: node.role, model: node.model,
      turns: 0, toolCalls: 0, failures: 0, executionMs: 0, outputTokens: 0, costUsd: 0, usageObservations: 0, costObservations: 0 }
    statistics.nodes.push(row)
  }
  return row
}

/** Input tokens in Session.tokenUsage are a context snapshot, never a cumulative billing total. */
export function recordTurnStatistics(document: SuperAgentDocument, node: SuperAgentNode, turn: SuperAgentPendingTurn, event: SessionCompletionEvent, now: number) {
  if (turn.startedAt == null) return
  const row = statisticsForNode(document, node, now)
  row.executionMs += Math.max(0, now - turn.startedAt)
  if (event.reason !== 'complete') row.failures++
  if (!event.tokenUsage || !turn.usageBaseline) return
  if (Number.isFinite(event.tokenUsage.outputTokens) && event.tokenUsage.outputTokens >= turn.usageBaseline.outputTokens) {
    row.outputTokens += event.tokenUsage.outputTokens - turn.usageBaseline.outputTokens
    row.usageObservations++
  }
  // Hosts commonly fill missing prices with zero. Zero alone does not prove free usage.
  if (Number.isFinite(event.tokenUsage.costUsd) && event.tokenUsage.costUsd > 0 && event.tokenUsage.costUsd >= turn.usageBaseline.costUsd) {
    row.costUsd += event.tokenUsage.costUsd - turn.usageBaseline.costUsd
    row.costObservations++
  }
}
