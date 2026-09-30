import { describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RpcServer } from '../../transport'

const workspaces = [
  { id: 'alpha', rootPath: '/tmp/alpha' },
  { id: 'beta', rootPath: '/tmp/beta' },
  { id: 'remote', rootPath: '/tmp/remote', remoteServer: { url: 'wss://fixture.invalid', token: 'synthetic-must-not-leak', remoteWorkspaceId: 'hosted' } },
]
mock.module('@craft-agent/shared/config', () => ({
  getWorkspaceByNameOrId: (id: string) => workspaces.find(workspace => workspace.id === id),
  addWorkspace: () => { throw new Error('Not used') },
  setActiveWorkspace: () => {},
  updateWorkspaceRemoteServer: () => {},
}))
const { registerWorkspaceCoreHandlers } = await import('./workspace')

function fixture() {
  const handlers = new Map<string, HandlerFn>()
  const routing: unknown[][] = []
  const windowCalls: string[] = []
  const server = {
    handle: (channel: string, handler: HandlerFn) => handlers.set(channel, handler),
    updateClientWorkspace: (...args: unknown[]) => routing.push(args),
  } as unknown as RpcServer
  registerWorkspaceCoreHandlers(server, {
    sessionManager: { getWorkspaces: () => workspaces, setupConfigWatcher: () => {} },
    windowManager: {
      getWorkspaceForWindow: () => { windowCalls.push('read'); return 'victim' },
      updateWindowWorkspace: () => { windowCalls.push('write'); return true },
      getWindowByWebContentsId: () => { windowCalls.push('lookup'); return {} },
      registerWindow: () => { windowCalls.push('register') },
      getAllWindowsForWorkspace: () => [],
    },
  } as any)
  return { handlers, routing, windowCalls }
}

describe('network workspace identity is not native window authority', () => {
  it('spoofed window id updates only attacker routing and never leaks remote credentials', async () => {
    const f = fixture()
    const result = await f.handlers.get(RPC_CHANNELS.window.SWITCH_WORKSPACE)!({ clientId: 'attacker', workspaceId: 'alpha', webContentsId: 7 }, 'remote')
    expect(result).toEqual({ workspaceId: 'remote', remoteServer: null })
    expect(JSON.stringify(result)).not.toContain('synthetic-must-not-leak')
    expect(f.routing).toEqual([['attacker', 'remote']])
    expect(f.windowCalls).toEqual([])
  })

  it('unknown target cannot change routing and missing workspace cannot read a claimed window', async () => {
    const f = fixture()
    const context = { clientId: 'attacker', workspaceId: null, webContentsId: 7 }
    await expect(f.handlers.get(RPC_CHANNELS.window.SWITCH_WORKSPACE)!(context, 'missing')).rejects.toThrow('Workspace not found')
    expect(f.handlers.get(RPC_CHANNELS.window.GET_WORKSPACE)!(context)).toBeNull()
    expect(f.routing).toEqual([])
    expect(f.windowCalls).toEqual([])
  })
})
