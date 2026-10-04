import type { SuperAgentConfig, SuperAgentMessage, SuperAgentPermissionRecord } from '@craft-agent/shared/super-agent'
import type { SuperAgentApproval } from './super-agent-activity'

export interface PermissionNotice {
  record: Omit<SuperAgentPermissionRecord, 'status'> & { status: SuperAgentPermissionRecord['status'] | 'archived' }
  owner?: string
  legacyDetails?: string
}

export function approvalNotice(request: SuperAgentApproval): PermissionNotice {
  return { record: { id: request.id, nodeId: request.nodeId, toolName: request.toolName,
    description: request.description, command: request.command, reason: request.reason,
    target: request.scope?.target, operation: request.scope?.operation,
    status: request.status, resolvedAt: request.resolvedAt } }
}

/** Recognize only system approval notices, keeping ordinary conversation untouched. */
export function permissionNotice(message: SuperAgentMessage, inbox: SuperAgentApproval[], config: SuperAgentConfig): PermissionNotice | undefined {
  if (message.fromNodeId !== 'system' || message.toNodeId !== 'user') return
  if (message.permission) return { record: message.permission }
  const legacy = message.body.match(/^([^\n]+) is waiting for user permission: ([\s\S]+)\nThe current turn remains paused until the user approves or denies this operation\.$/)
  if (!legacy) return
  const [, owner, details] = legacy
  const description = details.split(/\n(?:Reason:|Target \(|Requested command:|Requested operation:)/, 1)[0]
  const matches = inbox.filter(request => request.description === description && request.taskId === message.taskId
    && config.nodes.some(node => node.id === request.nodeId && node.name === owner)
    && Math.abs(request.createdAt - message.createdAt) < 2_000)
  // Ambiguous historical notices must not inherit another operation's decision.
  if (matches.length === 1) return approvalNotice(matches[0])
  return { owner, legacyDetails: details, record: { id: message.id, nodeId: '', description,
    toolName: details.match(/Super Agent policy: tool "([^"]+)"/)?.[1] ?? '',
    target: details.match(/\nTarget \([^\n]+\): ([^\n]*)/)?.[1], status: 'archived' } }
}
