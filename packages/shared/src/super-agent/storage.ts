import { appendFile, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SuperAgentConfig, SuperAgentState } from './types'
import { emptySuperAgentState, validateSuperAgentConfig } from './validation'
import { SuperAgentPermissionGrantSchema } from './permissions'
import { ContinuityTaskFields, ArtifactSchema, OperationSchema, MetricsSchema } from './continuity'

export interface SuperAgentPendingTurn {
  id: string
  nodeId: string
  kind: 'chat' | 'task' | 'inspection' | 'message' | 'summary' | 'script' | 'compact'
  text: string
  taskId?: string
  /** Async result correlation only; it must never re-complete the worker task. */
  scriptRunId?: string
  createdAt: number
  startedAt?: number
  retryAt?: number
  retryAttempt?: number
  retryDeadline?: number
  manualRecovery?: boolean
  recoveryError?: string
  emptyResponseRetryAttempt?: number
  backgroundInspection?: boolean
  /** Bound model-to-model message chains to prevent autonomous ping-pong. */
  depth: number
  chainId: string
}

/** Config and runtime are replaced together to keep their references consistent. */
export interface SuperAgentDocument {
  version: 1
  config: SuperAgentConfig | null
  state: SuperAgentState
  pendingTurns: SuperAgentPendingTurn[]
  failedTurns?: SuperAgentPendingTurn[]
  chainCounts: Record<string, number>
}

const number = z.number().finite().min(0)
const string = z.string().max(64_000)
const PermissionRecordSchema = z.object({
  id: string, nodeId: string, toolName: string, description: string,
  command: string.optional(), reason: string.optional(), target: string.optional(), operation: string.optional(),
  status: z.enum(['pending', 'approved', 'denied', 'expired']), resolvedAt: number.optional(),
}).strict()
const ActionReceiptSchema = z.object({
  turnId: string, status: z.enum(['applied', 'rejected', 'partially_applied']),
  applied: z.array(z.object({ id: string, type: string, targetId: string.optional() }).strict()).max(8),
  rejected: z.object({ id: string, type: string, targetId: string.optional(), error: z.string().max(2_000) }).strict().optional(),
  notAttempted: z.array(z.object({ id: string, type: string, targetId: string.optional() }).strict()).max(8).optional(),
  createdAt: number,
}).strict()
const TaskContractSchema = {
  ...ContinuityTaskFields,
  dependsOn: z.array(string).max(32).optional(), resources: z.array(string).max(32).optional(),
  acceptanceCriteria: z.array(string).max(16).optional(), requiresIndependentReview: z.boolean().optional(),
  reviewOf: string.optional(),
  acceptance: z.object({ status: z.enum(['accepted', 'rejected', 'stale']), evidenceTaskId: string, note: string, reviewedBy: string, reviewedAt: number,
    artifactHashes: z.array(z.object({ id: string, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(100).optional() }).strict().optional(),
}
const StateSchema = z.object({
  version: z.literal(1), revision: number.int(),
  permissionGrants: z.array(SuperAgentPermissionGrantSchema).max(256).default([]),
  nodes: z.array(z.object({ nodeId: string, sessionId: string.optional(), status: z.enum(['idle', 'preparing', 'working', 'recovering', 'error']), retryAt: number.optional(), retryAttempt: number.int().optional(), retryDeadline: number.optional(), activeTaskId: string.optional(), lastStartedAt: number.optional(), lastCompletedAt: number.optional(), error: string.optional() }).strict()).max(32),
  tasks: z.array(z.object({ ...TaskContractSchema, id: string, title: string, instructions: string, nodeId: string, planId: string.optional(), sessionId: string.optional(), status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']), createdAt: number, startedAt: number.optional(), completedAt: number.optional(), output: string.optional(), error: string.optional(), actionReceipt: ActionReceiptSchema.optional() }).strict()).max(500),
  intents: z.array(z.object({ id: string, revision: number.int().min(1).optional(), status: z.enum(['active', 'delivered', 'cancelled']).optional(), goal: string, constraints: z.array(string).max(16), deliverables: z.array(string).max(16), acceptanceCriteria: z.array(string).max(16), createdAt: number, sourceTurnId: string }).strict()).max(100).default([]),
  artifacts: z.array(ArtifactSchema).max(1000).default([]),
  operations: z.array(OperationSchema).max(2000).default([]),
  metrics: MetricsSchema.optional(),
  connectionStarts: z.array(z.object({ connection: string, at: number }).strict()).max(20_000).optional(),
  messages: z.array(z.object({ id: string, fromNodeId: string, toNodeId: string, kind: z.enum(['chat', 'message', 'task', 'result', 'inspection', 'script', 'error']), body: string, taskId: string.optional(), createdAt: number, userFacing: z.boolean().optional(), actionReceipt: ActionReceiptSchema.optional(), permission: PermissionRecordSchema.optional() }).strict()).max(500),
  board: z.array(z.object({ id: string, title: string, content: string, revision: number.int(), updatedBy: string, updatedAt: number }).strict()).max(256),
  scripts: z.array(z.object({ scriptId: string, runId: string.optional(), taskId: string.optional(), planId: string.optional(), resultPending: z.boolean().optional(), resultQueuedAt: number.optional(), resultReportedAt: number.optional(), resultDeliveryAttempts: number.int().max(3).optional(), resultDeliveryPaused: z.boolean().optional(), resultDeliveryError: z.string().max(2_000).optional(), status: z.enum(['idle', 'running', 'completed', 'failed', 'stopped', 'missing', 'untracked']), changedAt: number.optional(), lastModifiedAt: number.optional(), sha256: string.optional(), startedAt: number.optional(), completedAt: number.optional(), exitCode: z.number().int().nullable().optional(), exitSignal: z.string().max(64).optional(), output: string.optional(), error: string.optional() }).strict()).max(100),
  lastUserActivityAt: number, lastInspectionAt: number.optional(),
  allIdleSince: number.optional(),
  plans: z.array(z.object({ id: string, goalId: string.optional(), goalRevision: number.int().min(1).optional(), title: string, instructions: string, status: z.enum(['planned', 'active', 'blocked', 'completed', 'cancelled']), priority: z.number().int().min(1).max(5), note: string, revision: number.int(), updatedBy: string, updatedAt: number }).strict()).max(256).default([]),
}).strict()
const TurnSchema = z.object({ id: string, nodeId: string, kind: z.enum(['chat', 'task', 'inspection', 'message', 'summary', 'script', 'compact']), text: string, taskId: string.optional(), scriptRunId: string.optional(), createdAt: number, startedAt: number.optional(), retryAt: number.optional(), retryAttempt: number.int().optional(), retryDeadline: number.optional(), manualRecovery: z.boolean().optional(), recoveryError: string.optional(), emptyResponseRetryAttempt: number.int().optional(), backgroundInspection: z.boolean().optional(), depth: number.int().max(6), chainId: string.optional() }).strict()

export async function loadSuperAgentDocument(workspaceRoot: string): Promise<SuperAgentDocument> {
  const candidates: SuperAgentDocument[] = []; const errors: unknown[] = []
  for (const name of ['state.json', 'commit.json']) try {
    const text = await readFile(join(workspaceRoot, 'super-agent', name), 'utf8')
    if (text.length > 64 * 1024 * 1024) throw new Error('Super Agent state is too large')
    const document = z.object({ version: z.literal(1), config: z.unknown().nullable(), state: StateSchema, pendingTurns: z.array(TurnSchema).max(200), failedTurns: z.array(TurnSchema).max(32).default([]), chainCounts: z.record(z.string().regex(/^[a-z0-9_]+$/).max(64), number.int().max(32)).default({}) }).strict().parse(JSON.parse(text.replace(/^\uFEFF/, '')))
    candidates.push({ ...document, pendingTurns: document.pendingTurns.map(turn => ({ ...turn, chainId: turn.chainId ?? turn.id })), failedTurns: document.failedTurns.map(turn => ({ ...turn, chainId: turn.chainId ?? turn.id })), config: document.config == null ? null : validateSuperAgentConfig(document.config) })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error)
  }
  if (candidates.length) return candidates.sort((a, b) => b.state.revision - a.state.revision)[0]!
  if (errors.length) throw errors[0]
  return { version: 1, config: null, state: emptySuperAgentState(), pendingTurns: [], chainCounts: {} }
}

export async function saveSuperAgentDocument(workspaceRoot: string, document: SuperAgentDocument): Promise<void> {
  const encoded = `${JSON.stringify(document, null, 2)}\n`
  if (encoded.length > 64 * 1024 * 1024) throw new Error('Super Agent state exceeds 64 MB; reduce queued work or shared board content')
  const directory = join(workspaceRoot, 'super-agent')
  await mkdir(directory, { recursive: true })
  // The synced commit file is authoritative if updating the compatibility snapshot is interrupted.
  for (const name of ['commit.json', 'state.json']) {
    const path = join(directory, name), temporary = `${path}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(encoded, 'utf8'); await file.sync() } finally { await file.close() }
      await rename(temporary, path)
    } catch (error) { await unlink(temporary).catch(() => undefined); throw error }
  }
  // This index is observational; commit.json remains the recovery authority.
  try {
    const eventsPath = join(directory, 'events.jsonl')
    if (((await stat(eventsPath).catch(() => null))?.size ?? 0) >= 8 * 1024 * 1024) {
      await mkdir(join(directory, 'history'), { recursive: true })
      await rename(eventsPath, join(directory, 'history', `events-${Date.now()}-${randomUUID()}.jsonl`))
    }
    await appendFile(eventsPath, JSON.stringify({ revision: document.state.revision, at: Date.now(),
    pendingTurns: document.pendingTurns.map(turn => turn.id), metrics: document.state.metrics,
    tasks: document.state.tasks.filter(task => ['running', 'failed'].includes(task.status)).map(task => ({ id: task.id, status: task.status, phase: task.phase })),
    }) + '\n', { mode: 0o600 })
  } catch { /* Observational log failure does not invalidate the synced commit. */ }
}
