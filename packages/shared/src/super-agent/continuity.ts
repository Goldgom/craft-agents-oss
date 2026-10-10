import { z } from 'zod'
import { THINKING_LEVEL_IDS } from '../agent/thinking-levels'

const id = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/)
export const WaitConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('time'), notBefore: z.number().finite().min(0) }).strict(),
  z.object({ kind: z.literal('board'), itemId: id, afterRevision: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal('task'), taskId: id }).strict(),
  z.object({ kind: z.literal('file'), path: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
])
export type SuperAgentWaitCondition = z.infer<typeof WaitConditionSchema>
export const CheckpointSchema = z.object({
  revision: z.number().int().min(1), completedSteps: z.array(z.string().min(1).max(500)).max(100),
  nextStep: z.string().min(1).max(4000), note: z.string().max(4000), updatedAt: z.number().finite().min(0),
}).strict()
export const ContinuityTaskFields = {
  thinkingLevel: z.enum(THINKING_LEVEL_IDS).optional(),
  goalId: id.optional(), goalRevision: z.number().int().min(1).optional(),
  goalCriteria: z.array(z.number().int().min(0).max(15)).max(16).optional(),
  requiredCapabilities: z.array(z.string().min(1).max(100)).max(32).optional(),
  phase: z.enum(['executing', 'waiting', 'outcome-unknown', 'submitted']).optional(),
  checkpoint: CheckpointSchema.optional(),
  waiting: z.object({ reason: z.string().min(1).max(4000), condition: WaitConditionSchema, since: z.number(), resumeAttempts: z.number().int().min(0) }).strict().optional(),
  lastProgressAt: z.number().optional(), stallNotifiedAt: z.number().optional(), attempt: z.number().int().min(0).optional(),
  lastResultHash: z.string().optional(),
  artifactIds: z.array(id).max(100).optional(),
  inputArtifacts: z.array(z.object({ id, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(100).optional(),
}
export const ArtifactSchema = z.object({ id, taskId: id, goalId: id.optional(), path: z.string().min(1).max(4096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().min(1), description: z.string().max(4000),
  updatedAt: z.number(), missing: z.boolean().optional() }).strict()
export const OperationSchema = z.object({ id, key: z.string().regex(/^[a-f0-9]{64}$/), taskId: id.optional(), turnId: id,
  nodeId: id, sessionId: z.string().min(1).max(200), invocationId: z.string().min(1).max(300), toolName: z.string().max(300),
  status: z.enum(['prepared', 'running', 'completed', 'unknown', 'reconciled']),
  createdAt: z.number(), updatedAt: z.number(), resultHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  reconciliation: z.object({ evidenceTaskId: id, note: z.string().min(1).max(4000), outcome: z.enum(['completed', 'not-executed']) }).strict().optional(),
}).strict()
export const MetricsSchema = z.object({ modelTurns: z.number().int().min(0), toolCalls: z.number().int().min(0), retries: z.number().int().min(0),
  resumptions: z.number().int().min(0), stalls: z.number().int().min(0), completedTasks: z.number().int().min(0),
  executionMs: z.number().min(0), queueMs: z.number().min(0) }).strict()
export const emptyContinuityMetrics = () => ({ modelTurns: 0, toolCalls: 0, retries: 0, resumptions: 0, stalls: 0, completedTasks: 0, executionMs: 0, queueMs: 0 })

/** Host validates ownership and current execution identity on every update. */
export const SuperAgentTaskUpdateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get'), taskId: id.optional() }).strict(),
  z.object({ action: z.literal('checkpoint'), taskId: id, expectedRevision: z.number().int().min(0),
    completedSteps: z.array(z.string().min(1).max(500)).max(100), nextStep: z.string().min(1).max(4000), note: z.string().max(4000).default('') }).strict(),
  z.object({ action: z.literal('wait'), taskId: id, reason: z.string().min(1).max(4000), condition: WaitConditionSchema }).strict(),
  z.object({ action: z.literal('artifact'), taskId: id, id, path: z.string().min(1).max(4096), description: z.string().max(4000).default('') }).strict(),
  z.object({ action: z.literal('reconcile'), operationId: id, evidenceTaskId: id,
    outcome: z.enum(['completed', 'not-executed']), note: z.string().min(1).max(4000) }).strict(),
])
export type SuperAgentTaskUpdate = z.infer<typeof SuperAgentTaskUpdateSchema>
export type SuperAgentCheckpoint = z.infer<typeof CheckpointSchema>
export type SuperAgentArtifact = z.infer<typeof ArtifactSchema>
export type SuperAgentOperation = z.infer<typeof OperationSchema>
export type SuperAgentMetrics = z.infer<typeof MetricsSchema>

export const StatisticsSchema = z.object({
  since: z.number().min(0),
  nodes: z.array(z.object({ nodeId: id, name: z.string(), role: z.enum(['coordinator', 'orchestrator', 'worker']), model: z.string(),
    turns: z.number().int().min(0), toolCalls: z.number().int().min(0), failures: z.number().int().min(0),
    executionMs: z.number().min(0), outputTokens: z.number().min(0), costUsd: z.number().min(0),
    usageObservations: z.number().int().min(0), costObservations: z.number().int().min(0),
  }).strict()).max(1024),
}).strict()
export type SuperAgentStatistics = z.infer<typeof StatisticsSchema>
