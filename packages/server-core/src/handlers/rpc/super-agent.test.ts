import { describe, expect, it } from 'bun:test'
import { assertSuperAgentWorkspace } from './super-agent'

describe('Super Agent workspace boundary', () => {
  it('rejects operations against a workspace outside the authenticated context', () => {
    const context = { clientId: 'client', workspaceId: 'workspace-a', webContentsId: null }
    expect(() => assertSuperAgentWorkspace(context, 'workspace-b')).toThrow('different workspace')
    expect(() => assertSuperAgentWorkspace(context, 'workspace-a')).not.toThrow()
    expect(() => assertSuperAgentWorkspace(context, '')).toThrow('workspace ID')
  })

  it('permits canonical explicit workspace selection on a local unscoped connection', () => {
    expect(() => assertSuperAgentWorkspace({ clientId: 'local', workspaceId: null, webContentsId: 1 }, 'workspace-a')).not.toThrow()
  })
})
