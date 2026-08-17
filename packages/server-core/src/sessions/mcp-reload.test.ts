import { describe, expect, it, mock } from 'bun:test'
import { SessionManager } from './SessionManager'

const workspace = {
  id: 'ws-1',
  name: 'Workspace 1',
  slug: 'workspace-1',
  rootPath: '/tmp/workspace-1',
  createdAt: Date.now(),
}

describe('SessionManager.reloadMcpServers', () => {
  it('forces idle runtimes, defers busy sessions, and leaves cold sessions fresh', async () => {
    const manager = new SessionManager() as any
    manager.getWorkspaces = () => [workspace]
    manager.sessions.set('idle', {
      id: 'idle', workspace, isProcessing: false, agent: {},
    })
    manager.sessions.set('busy', {
      id: 'busy', workspace, isProcessing: true, agent: {},
    })
    manager.sessions.set('cold', {
      id: 'cold', workspace, isProcessing: false, agent: null,
    })
    const reloadSessionSources = mock(async () => {})
    manager.reloadSessionSources = reloadSessionSources

    const result = await manager.reloadMcpServers()

    expect(result).toEqual({
      workspaceIds: ['ws-1'],
      reloadedSessionIds: ['idle'],
      deferredSessionIds: ['busy'],
      freshOnNextUseSessionIds: ['cold'],
      failures: [],
    })
    expect(reloadSessionSources).toHaveBeenCalledWith(manager.sessions.get('idle'), true)
    expect(manager.pendingMcpReloadSessionIds.has('busy')).toBe(true)
  })

  it('rejects an unknown workspace scope', async () => {
    const manager = new SessionManager() as any
    manager.getWorkspaces = () => [workspace]

    await expect(manager.reloadMcpServers('missing')).rejects.toThrow('Workspace not found: missing')
  })
})
