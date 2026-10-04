import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SuperAgentConfig, SuperAgentState } from './types'
import { emptySuperAgentState, validateSuperAgentConfig } from './validation'

export interface SuperAgentPendingTurn {
  id: string
  nodeId: string
  kind: 'chat' | 'task' | 'inspection' | 'message' | 'summary' | 'script'
  text: string
  taskId?: string
  createdAt: number
  startedAt?: number
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
  chainCounts: Record<string, number>
}

const number = z.number().finite().min(0)
const string = z.string().max(64_000)
const PermissionRecordSchema = z.object({
  id: string, nodeId: string, toolName: string, description: string,
  command: string.optional(), reason: string.optional(), target: string.optional(), operation: string.optional(),
  status: z.enum(['pending', 'approved', 'denied', 'expired']), resolvedAt: number.optional(),
}).strict()
const StateSchema = z.object({
  version: z.literal(1), revision: number.int(),
  nodes: z.array(z.object({ nodeId: string, sessionId: string.optional(), status: z.enum(['idle', 'preparing', 'working', 'error']), activeTaskId: string.optional(), lastStartedAt: number.optional(), lastCompletedAt: number.optional(), error: string.optional() }).strict()).max(32),
  tasks: z.array(z.object({ id: string, title: string, instructions: string, nodeId: string, planId: string.optional(), sessionId: string.optional(), status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']), createdAt: number, startedAt: number.optional(), completedAt: number.optional(), output: string.optional(), error: string.optional() }).strict()).max(500),
  messages: z.array(z.object({ id: string, fromNodeId: string, toNodeId: string, kind: z.enum(['chat', 'message', 'task', 'result', 'inspection', 'script', 'error']), body: string, taskId: string.optional(), createdAt: number, permission: PermissionRecordSchema.optional() }).strict()).max(500),
  board: z.array(z.object({ id: string, title: string, content: string, revision: number.int(), updatedBy: string, updatedAt: number }).strict()).max(256),
  scripts: z.array(z.object({ scriptId: string, status: z.enum(['idle', 'running', 'completed', 'failed', 'stopped', 'missing', 'untracked']), changedAt: number.optional(), lastModifiedAt: number.optional(), sha256: string.optional(), startedAt: number.optional(), completedAt: number.optional(), exitCode: z.number().int().nullable().optional(), output: string.optional(), error: string.optional() }).strict()).max(100),
  lastUserActivityAt: number, lastInspectionAt: number.optional(),
  allIdleSince: number.optional(),
  plans: z.array(z.object({ id: string, title: string, instructions: string, status: z.enum(['planned', 'active', 'blocked', 'completed', 'cancelled']), priority: z.number().int().min(1).max(5), note: string, revision: number.int(), updatedBy: string, updatedAt: number }).strict()).max(256).default([]),
}).strict()
const TurnSchema = z.object({ id: string, nodeId: string, kind: z.enum(['chat', 'task', 'inspection', 'message', 'summary', 'script']), text: string, taskId: string.optional(), createdAt: number, startedAt: number.optional(), backgroundInspection: z.boolean().optional(), depth: number.int().max(6), chainId: string.optional() }).strict()

export async function loadSuperAgentDocument(workspaceRoot: string): Promise<SuperAgentDocument> {
  try {
    const text = await readFile(join(workspaceRoot, 'super-agent', 'state.json'), 'utf8')
    if (text.length > 64 * 1024 * 1024) throw new Error('Super Agent state is too large')
    const document = z.object({ version: z.literal(1), config: z.unknown().nullable(), state: StateSchema, pendingTurns: z.array(TurnSchema).max(200), chainCounts: z.record(z.string().regex(/^[a-z0-9_]+$/).max(64), number.int().max(32)).default({}) }).strict().parse(JSON.parse(text.replace(/^\uFEFF/, '')))
    return { ...document, pendingTurns: document.pendingTurns.map(turn => ({ ...turn, chainId: turn.chainId ?? turn.id })), config: document.config == null ? null : validateSuperAgentConfig(document.config) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, config: null, state: emptySuperAgentState(), pendingTurns: [], chainCounts: {} }
    throw error
  }
}

export async function saveSuperAgentDocument(workspaceRoot: string, document: SuperAgentDocument): Promise<void> {
  const encoded = `${JSON.stringify(document, null, 2)}\n`
  if (encoded.length > 64 * 1024 * 1024) throw new Error('Super Agent state exceeds 64 MB; reduce queued work or shared board content')
  const directory = join(workspaceRoot, 'super-agent')
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'state.json')
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, encoded, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}
