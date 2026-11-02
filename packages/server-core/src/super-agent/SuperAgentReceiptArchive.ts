import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { getSessionFilePath, loadSession } from '@tokenbird/shared/sessions'
import { storedToMessage } from '@tokenbird/core/types'
import type { SuperAgentOperation } from '@tokenbird/shared/super-agent'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const Journal = z.object({
  version: z.literal(1), workspaceId: z.string(), operationId: z.string(), taskId: z.string().optional(), turnId: z.string(),
  sessionId: z.string(), invocationId: z.string(), toolName: z.string(), inputJson: z.string(), inputHash: z.string(),
  result: z.string().optional(), resultHash: z.string().optional(), isError: z.boolean().optional(), timestamp: z.number(),
}).strict()
type ReceiptJournal = z.infer<typeof Journal>

function journalPath(root: string, operation: SuperAgentOperation) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(operation.id)) throw new Error('Invalid operation ID')
  return join(root, 'super-agent', 'operation-receipts', `${operation.id}.json`)
}
async function save(path: string, value: ReceiptJournal) {
  const body = JSON.stringify(value)
  if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new Error('Operation receipt exceeds 16 MB')
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(body, 'utf8'); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}
export async function prepareReceipt(root: string, workspaceId: string, operation: SuperAgentOperation, input: Record<string, unknown>) {
  const inputJson = JSON.stringify(input)
  await save(journalPath(root, operation), { version: 1, workspaceId, operationId: operation.id, taskId: operation.taskId,
    turnId: operation.turnId, sessionId: operation.sessionId, invocationId: operation.invocationId, toolName: operation.toolName,
    inputJson, inputHash: hash(inputJson), timestamp: operation.createdAt })
}
async function readJournal(root: string, workspaceId: string, operation: SuperAgentOperation) {
  const path = journalPath(root, operation)
  if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error('Oversized operation receipt')
  const journal = Journal.parse(JSON.parse(await readFile(path, 'utf8')))
  if (journal.workspaceId !== workspaceId || journal.operationId !== operation.id || journal.taskId !== operation.taskId
    || journal.turnId !== operation.turnId || journal.sessionId !== operation.sessionId || journal.invocationId !== operation.invocationId
    || journal.toolName !== operation.toolName || hash(journal.inputJson) !== journal.inputHash
    || operation.inputHash && operation.inputHash !== journal.inputHash) throw new Error('Operation receipt identity mismatch')
  if (journal.result !== undefined && (hash(`${journal.toolName}\n${journal.result}`) !== journal.resultHash
    || operation.resultHash && operation.resultHash !== journal.resultHash)) throw new Error('Operation receipt hash mismatch')
  return journal
}
export async function completeReceipt(root: string, workspaceId: string, operation: SuperAgentOperation, result: string, isError: boolean, timestamp: number) {
  const journal = await readJournal(root, workspaceId, operation)
  await save(journalPath(root, operation), { ...journal, result, resultHash: hash(`${operation.toolName}\n${result}`), isError, timestamp })
}
export async function archivedReceiptSession(root: string, workspaceId: string, operation: SuperAgentOperation) {
  const journal = await readJournal(root, workspaceId, operation)
  if (journal.result === undefined) return null
  return { id: journal.sessionId, workspaceId, messages: [{ id: `receipt:${operation.id}`, role: 'tool' as const,
    content: '', timestamp: journal.timestamp, toolUseId: journal.invocationId, toolName: journal.toolName,
    toolInput: JSON.parse(journal.inputJson), toolResult: journal.result, isError: journal.isError,
    toolStatus: journal.isError ? 'error' as const : 'completed' as const }] }
}

/** Exact original session only, including archived sessions; never search other workspaces or summaries. */
export async function diskReceiptSession(root: string, workspaceId: string, operation: SuperAgentOperation) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(operation.sessionId)) return null
  const file = getSessionFilePath(root, operation.sessionId)
  const base = await realpath(root), target = await realpath(file), rel = relative(base, target)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || (await stat(target)).size > 64 * 1024 * 1024) return null
  const session = loadSession(root, operation.sessionId)
  if (!session || session.id !== operation.sessionId || resolve(session.workspaceRootPath) !== resolve(root)) return null
  return { id: session.id, workspaceId, messages: session.messages.map(storedToMessage) }
}
