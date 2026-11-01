import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { formatHostContext, type HostContext } from '../../shared/src/agent/core/host-context.ts'

export const HOST_CONTEXT_TYPE = 'tokenbird.super-agent-context.v1'
type HostMessage = Extract<AgentMessage, { role: 'custom' }> & { details: { origin: 'tokenbird-host'; snapshotId: string } }

export function hostContextMessage(context: HostContext): HostMessage {
  return { role: 'custom', customType: HOST_CONTEXT_TYPE, display: false,
    content: formatHostContext(context), timestamp: Date.now(),
    details: { origin: 'tokenbird-host', snapshotId: context.snapshotId } }
}

export function isHostMessage(message: AgentMessage): message is HostMessage {
  return message.role === 'custom' && message.customType === HOST_CONTEXT_TYPE
    && (message.details as HostMessage['details'])?.origin === 'tokenbird-host'
}

/** Request-only projection: user text and tool call/result pairs are never edited. */
export function projectHostContext(messages: AgentMessage[], latest?: HostMessage): AgentMessage[] {
  const current = latest ?? [...messages].reverse().find(isHostMessage)
  if (!current) return messages
  let retained = false
  const projected = messages.filter(message => {
    if (!isHostMessage(message)) return true
    if (!retained && message.details?.snapshotId === current.details?.snapshotId) {
      retained = true
      return true
    }
    return false
  })
  // Compaction can remove the custom entry. Restore this turn's pinned state.
  return retained ? projected : [...projected, current]
}

export function hostContextExtension(getLatest: () => HostMessage | undefined,
  onProjection?: (record: { messagesRemoved: number; charactersRemoved: number; snapshotId?: string }) => void): ExtensionFactory {
  return pi => {
    pi.on('context', event => {
      const messages = projectHostContext(event.messages, getLatest())
      const size = (items: AgentMessage[]) => items.filter(isHostMessage).reduce((sum, message) => sum + JSON.stringify(message.content).length, 0)
      onProjection?.({ messagesRemoved: event.messages.length - messages.length,
        charactersRemoved: size(event.messages) - size(messages), snapshotId: getLatest()?.details?.snapshotId })
      return { messages }
    })
    pi.on('session_before_compact', event => {
      // Keep the original branch intact; only reduce the summarizer's input.
      event.preparation.messagesToSummarize = projectHostContext(event.preparation.messagesToSummarize)
    })
  }
}
