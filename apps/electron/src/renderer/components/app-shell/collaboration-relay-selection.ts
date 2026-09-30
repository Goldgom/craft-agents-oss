import type { CollaborationRelayCandidate, CollaborationRelaySelection, CollaborationServerRef } from '@craft-agent/shared/protocol'

export function collaborationServerKey(server: CollaborationServerRef): string {
  return server.kind === 'local' ? 'local' : JSON.stringify(['saved', server.profileId])
}

export function collaborationRelaySessionKey(session: Pick<CollaborationRelayCandidate, 'server' | 'workspaceId' | 'sessionId'>): string {
  return JSON.stringify([collaborationServerKey(session.server), session.workspaceId, session.sessionId])
}

/** Stable across object-key order; different servers and new-row order matter. */
export function collaborationBasketFingerprint(selections: readonly CollaborationRelaySelection[]): string {
  return JSON.stringify(selections.map(item => [collaborationServerKey(item.server), item.workspaceId, item.createNew ? null : item.sessionId, !!item.createNew, item.name ?? '']))
}

export interface CollaborationBasketRow {
  key: string
  selection: CollaborationRelaySelection
  serverName: string
  workspaceName: string
  name: string
}
