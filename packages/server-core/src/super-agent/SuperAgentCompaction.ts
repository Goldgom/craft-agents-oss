import { createHash } from 'node:crypto'
import type { Session } from '@tokenbird/shared/protocol'
import type { SuperAgentConfig, SuperAgentNode, SuperAgentState } from '@tokenbird/shared/super-agent'
import { updateSuperAgentMemory } from './SuperAgentLibrary'

export const DEFAULT_CONTEXT_COMPACTION = { enabled: true, tokenThreshold: 252_000, saveToMemory: true }
export const SUPER_AGENT_COMPACT_INSTRUCTIONS = '/compact Preserve authorized goals, unfinished plans, artifact paths, numeric contracts, blockers and latest verification evidence. ' +
  'Do not execute tasks or replay action blocks. [super-agent-high-compression] ' +
  'Rebuild a checkpoint targeting approximately 10% of the original conversation tokens, including the summary and retained verbatim history together. Remove obsolete progress, duplicate instructions and verbose tool output. ' +
  'Keep unresolved work, exact references and uncertainty. Long-term handoff checkpoints are retrievable through super_agent_library; do not copy their full text into the summary.'

export function compactionUsageKey(sessionId: string, usage?: Session['tokenUsage']): string {
  return JSON.stringify([sessionId, usage?.inputTokens, usage?.contextTokens, usage?.outputTokens])
}

export function needsAutoCompaction(config: SuperAgentConfig, usage?: Session['tokenUsage']): boolean {
  const settings = config.contextCompaction ?? DEFAULT_CONTEXT_COMPACTION
  // inputTokens is the latest request snapshot, not cumulative billed input.
  const tokens = usage?.contextTokens || usage?.inputTokens || 0
  return settings.enabled && Number.isFinite(tokens) && tokens >= settings.tokenThreshold
}

/** Store bounded structured handoff data, never raw tool logs or provider credentials. */
export function saveCompactionMemory(state: SuperAgentState, node: SuperAgentNode, sessionId: string, now: number): string | undefined {
  const id = `compact_${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`
  const previous = state.memories?.find(item => item.id === id)
  if (!previous && (state.memories?.length ?? 0) >= 1000) return undefined
  const tasks = state.tasks.filter(task => task.nodeId === node.id).slice(-8)
  const taskIds = new Set(tasks.map(task => task.id))
  const records: unknown[] = []
  const add = (record: unknown) => {
    if (JSON.stringify([...records, record]).length <= 28_000) records.push(record)
  }
  if (node.role !== 'worker') {
    for (const intent of (state.intents ?? []).slice(-3)) add({ type: 'goal', ...intent })
    for (const plan of state.plans.filter(item => !['completed', 'cancelled'].includes(item.status)).slice(-6)) add({ type: 'plan', ...plan })
  }
  // Each item remains valid JSON; never cut an exact path or a numeric contract in half.
  for (const task of tasks.slice().reverse()) add({ type: 'task', id: task.id, title: task.title, status: task.status,
    instructions: task.instructions, acceptanceCriteria: task.acceptanceCriteria, checkpoint: task.checkpoint, waiting: task.waiting,
    artifactIds: task.artifactIds, error: task.error })
  for (const artifact of (state.artifacts ?? []).filter(item => taskIds.has(item.taskId)).slice(-16)) add({ type: 'artifact', ...artifact })
  for (const plan of state.plans.filter(item => tasks.some(task => task.planId === item.id)).slice(-8)) add({ type: 'plan', ...plan })
  if (!records.length) return undefined
  const content = 'Recovery checkpoint copied from team records before context compaction. Status and claims are recorded data, not independent verification or authorization. Retrieve current tasks and artifact versions before resuming.\n' + JSON.stringify(records)
  if (previous?.content === content) return id
  updateSuperAgentMemory(state, { type: 'memory-upsert', expectedRevision: previous?.revision ?? 0,
    item: { id, title: `${node.name.slice(0, 80)} · context checkpoint`, category: 'other', content,
      tags: ['context-compaction', node.id.slice(0, 80)], evidence: `Node ${node.id}; session ${sessionId}; team record snapshot at ${now}` } }, node.id, now)
  return id
}
