import { basename, resolve } from 'node:path'

/** All agent modes use the workspace resource catalog and source credential namespace. */
export function superAgentResourceScope(workspaceRoot: string): { rootPath: string; credentialWorkspaceId: string } {
  const rootPath = resolve(workspaceRoot)
  return { rootPath, credentialWorkspaceId: basename(rootPath) }
}
