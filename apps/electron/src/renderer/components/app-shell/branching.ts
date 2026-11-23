import type { Message } from '@tokenbird/core/types'

export function resolveBranchNewPanelOption(options?: { newPanel?: boolean }): boolean {
  return options?.newPanel ?? true
}

/** Resolve stable renderer IDs to the persisted IDs used by history operations. */
export function resolveBranchMessageId(messages: readonly Message[], messageId: string): string {
  return messages.find(message => message.id === messageId)?.backendMessageId ?? messageId
}
