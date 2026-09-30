import type { SessionMeta } from '@/atoms/sessions'
import type { CollaborationSessionSelection } from '../../../shared/types'

export const MAX_COLLABORATORS = 32

/** Session IDs alone are insufficient when browsing more than one workspace. */
export function collaborationSessionKey(session: Pick<SessionMeta, 'id' | 'workspaceId'>): string {
  return JSON.stringify([session.workspaceId, session.id])
}

export function availableCollaborationSessions(sessions: SessionMeta[], primary?: Pick<SessionMeta, 'id' | 'workspaceId'>): SessionMeta[] {
  const primaryKey = primary && collaborationSessionKey(primary)
  return sessions.filter(session => !session.isArchived && !session.hidden && !session.collaboration
    && collaborationSessionKey(session) !== primaryKey)
}

export function collaborationSelections(
  candidates: SessionMeta[],
  selected: ReadonlySet<string>,
  newSessions: Array<{ workspaceId: string; name: string }>,
): CollaborationSessionSelection[] {
  return [
    ...candidates.filter(session => selected.has(collaborationSessionKey(session)))
      .map(session => ({ sessionId: session.id, workspaceId: session.workspaceId, name: session.name })),
    ...newSessions.map(session => ({ createNew: true as const, workspaceId: session.workspaceId, name: session.name.trim() || undefined })),
  ]
}
