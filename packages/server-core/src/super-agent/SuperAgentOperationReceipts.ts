import { createHash } from 'node:crypto'
import type { Session } from '@tokenbird/shared/protocol'
import type { SuperAgentOperation } from '@tokenbird/shared/super-agent'

/** The shell bridge marks a dispatched process and its terminal exit explicitly.
 * This proves the invocation finished, never that its requested business work succeeded. */
export function terminalProgramResult(toolName: string, result: string): boolean {
  return ['bash', 'localbash', 'runshell', 'mcp__session__bash', 'mcp__session__localbash', 'mcp__session__runshell'].includes(toolName.toLowerCase())
    && /^\[ERROR\] \[executed on (?:server|client)\]/.test(result)
    && /(?:^|\n)exit code -?\d+(?:\r?\n|$)/.test(result)
}

/** Original host transcript evidence; never infer execution from an error or a hash. */
export function operationReceipt(operation: SuperAgentOperation, session: {
  id: string; workspaceId: string; messages?: Session['messages']
} | null, workspaceId: string) {
  const identity = { operationId: operation.id, sessionId: operation.sessionId, invocationId: operation.invocationId }
  if (!session || session.id !== operation.sessionId || session.workspaceId !== workspaceId) return { ...identity, availability: 'missing' as const }
  const matches = session.messages?.filter(message => message.role === 'tool'
    && message.toolUseId === operation.invocationId && message.toolName === operation.toolName
    && typeof message.toolResult === 'string') ?? []
  // Older recordings lost the result event/hash while retaining the host transcript.
  // Recover only one unambiguous terminal result; an existing hash must still match.
  const terminal = matches.filter(message => message.toolStatus === 'completed' || message.toolStatus === 'error')
  const message = operation.resultHash ? terminal.findLast(message =>
    createHash('sha256').update(`${operation.toolName}\n${message.toolResult}`).digest('hex') === operation.resultHash)
    : terminal.length === 1 ? terminal[0] : undefined
  if (!message) return { ...identity, availability: matches.length ? 'hash-mismatch' as const : 'missing' as const }
  // Bound returned evidence, preserving the full-result hash and explicit truncation.
  const input = message.toolInput === undefined ? undefined : JSON.stringify(message.toolInput)
  if (operation.inputHash && (input === undefined || createHash('sha256').update(input).digest('hex') !== operation.inputHash)) return { ...identity, availability: 'hash-mismatch' as const }
  const result = message.toolResult!
  return { ...identity, availability: 'available' as const, messageId: message.id, timestamp: message.timestamp,
    toolName: operation.toolName, toolStatus: message.toolStatus, isError: message.isError,
    inputJson: input?.slice(0, 16_000), result: result.slice(0, 32_000),
    resultHash: operation.resultHash ?? createHash('sha256').update(`${operation.toolName}\n${result}`).digest('hex'),
    hashSource: operation.resultHash ? 'operation' as const : 'transcript' as const,
    inputTruncated: (input?.length ?? 0) > 16_000, resultTruncated: result.length > 32_000 }
}

/** Closed list of native read tools. A remote MCP tool with a similar suffix is not trusted. */
export function terminalReceiptOutcome(receipt: ReturnType<typeof operationReceipt>): 'succeeded' | 'failed' | 'unknown' {
  if (receipt.availability !== 'available') return 'unknown'
  if (receipt.toolStatus === 'completed' && receipt.isError !== true) return 'succeeded'
  if (receipt.resultTruncated) return 'unknown'
  if (receipt.toolStatus !== 'error' && receipt.isError !== true) return 'unknown'
  if (terminalProgramResult(receipt.toolName, receipt.result)) return 'failed'
  if (['read', 'glob', 'grep', 'ls'].includes(receipt.toolName.toLowerCase())) return 'failed'
  // A desktop observation has bounded effects; typing/clicking and remote errors remain unknown.
  if (['computer_use', 'mcp__session__computer_use'].includes(receipt.toolName.toLowerCase()) && !receipt.inputTruncated && receipt.inputJson) {
    try {
      if (['status', 'screenshot', 'position', 'windows', 'snapshot', 'focus', 'move', 'wait'].includes(JSON.parse(receipt.inputJson).action)) return 'failed'
    } catch { /* Malformed evidence remains unknown. */ }
  }
  return 'unknown'
}
