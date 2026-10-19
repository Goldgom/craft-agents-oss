import { z } from 'zod'
import type { SuperAgentConfig, SuperAgentModelEntry, SuperAgentState } from './types'
import { THINKING_LEVEL_IDS } from '../agent/thinking-levels'
import { withSuperAgentOrchestrator } from './architecture'

export const SuperAgentModelEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), name: z.string().trim().min(1).max(120),
  llmConnection: z.string().min(1).max(200), model: z.string().min(1).max(200),
  agentRuntime: z.union([z.enum(['pi', 'claude-code', 'codex']), z.string().regex(/^plugin:[a-z0-9][a-z0-9_-]*$/).transform(value => value as `plugin:${string}`)]).optional(),
  capabilityNotes: z.string().max(16000).optional(), intelligenceScore: z.number().int().min(0).max(100).optional(),
  // Read old settings once without confusing a new score of 0–5 with the old star scale.
  description: z.string().max(4000).optional(), evaluation: z.string().max(4000).optional(), intelligenceRating: z.number().int().min(1).max(5).optional(),
  enabled: z.boolean(), supportedThinkingLevels: z.array(z.enum(THINKING_LEVEL_IDS)).min(1).max(6),
  skillSlugs: z.array(z.string().min(1).max(200)).max(100), sourceSlugs: z.array(z.string().min(1).max(200)).max(100),
  capabilities: z.array(z.string().min(1).max(200)).max(32), maxCallsPerMinute: z.number().min(0.1).max(60),
}).strict().transform(({ description, evaluation, intelligenceRating, ...entry }) => ({
  ...entry,
  capabilityNotes: entry.capabilityNotes ?? [...new Set([description, entry.capabilities.length ? entry.capabilities.join(', ') : '', evaluation].filter((value): value is string => !!value?.trim()))].join('\n\n'),
  intelligenceScore: entry.intelligenceScore ?? (intelligenceRating ?? 3) * 20,
}))

export const SuperAgentReportSchema = z.object({
  id: z.string().min(1), sequence: z.number().int().min(1), nodeId: z.string().min(1), turnId: z.string().min(1),
  taskId: z.string().optional(), goalId: z.string().optional(), goalRevision: z.number().int().min(1).optional(),
  kind: z.enum(['progress', 'stage', 'final', 'failure', 'question']), content: z.string().min(1).max(64000),
  verification: z.enum(['unverified', 'verified', 'stale']), artifactIds: z.array(z.string()).max(100),
  supersedes: z.string().optional(), createdAt: z.number().finite().min(0),
}).strict()

export const SuperAgentWorkEventSchema = z.object({
  id: z.string().min(1), sequence: z.number().int().min(1), kind: z.enum(['work', 'board', 'report', 'runtime', 'automation']),
  actor: z.string().min(1), targetId: z.string().optional(), revision: z.number().int().min(0), createdAt: z.number().finite().min(0),
}).strict()

/** Legacy workers become selectable models; their old sessions remain read-only history. */
export function rebuildSuperAgentConfig(input: SuperAgentConfig): SuperAgentConfig {
  if (input.architecture === 'dynamic') return { ...input, modelPool: input.modelPool?.map(entry => SuperAgentModelEntrySchema.parse(entry)) }
  const config = withSuperAgentOrchestrator({ ...input, nodes: input.nodes.filter(node => node.role !== 'worker') })
  const models: SuperAgentModelEntry[] = []
  for (const node of input.nodes.filter(node => node.role === 'worker')) {
    models.push({ id: `model-${models.length + 1}`, name: node.model, llmConnection: node.llmConnection, model: node.model,
      agentRuntime: node.agentRuntime, capabilityNotes: (node.capabilities ?? []).join(', '),
      intelligenceScore: node.intelligenceRating * 20, enabled: true, supportedThinkingLevels: [...THINKING_LEVEL_IDS],
      skillSlugs: [], sourceSlugs: [], capabilities: node.capabilities ?? [], maxCallsPerMinute: node.maxCallsPerMinute })
  }
  return { ...config, architecture: 'dynamic', maxConcurrentSubagents: config.workflow?.maxParallelTasks ?? 4,
    reportCheckSeconds: 5, continuousWork: false, modelPool: models,
    sourceSlugs: [], scripts: [],
    nodes: config.nodes.filter(node => node.role !== 'worker').map(node => ({ ...node, sourceSlugs: [], skillSlugs: [], abilityProfileIds: [] })) }
}

/** All nodes see the same work contracts, without exposing worker transcripts or tool results. */
export function superAgentWorkList(state: SuperAgentState) {
  return { requirements: state.intents ?? [], plans: state.plans,
    tasks: state.tasks.map(({ output: _output, error: _error, checkpoint: _checkpoint, inputArtifacts: _inputs, actionReceipt: _receipt, ...task }) => task) }
}

/** Finished task instances remain available as evidence, never as reusable team members. */
export function activeSuperAgentNodes(config: SuperAgentConfig, state: SuperAgentState) {
  return config.nodes.filter(node => {
    if (config.architecture !== 'dynamic' || !node.dynamic) return true
    const runtime = state.nodes.find(item => item.nodeId === node.id)
    if (runtime && ['preparing', 'working', 'recovering', 'error'].includes(runtime.status)) return true
    return state.tasks.some(task => task.nodeId === node.id && ['queued', 'running'].includes(task.status))
  })
}
