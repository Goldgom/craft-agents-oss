import { describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { ActiveSessionInfo } from '@craft-agent/core/types'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import type { ServerHandlerContext } from '../../bootstrap/headless-start'
import { registerServerHandlers } from './server'

function createHarness(options?: { restartSupported?: boolean }) {
  const handlers = new Map<string, HandlerFn>()
  let activeSessions: ActiveSessionInfo[] = []
  let completionListener: (() => void) | undefined
  const requestRestart = mock(async () => {})
  const reloadMcpServers = mock(async (workspaceId?: string) => ({
    workspaceIds: workspaceId ? [workspaceId] : ['ws-1'],
    reloadedSessionIds: [],
    deferredSessionIds: [],
    freshOnNextUseSessionIds: [],
    failures: [],
  }))

  const server = {
    handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as RpcServer

  const sessionManager = {
    getWorkspacesInfo: () => [],
    getWorkspaceAutomationSummary: () => ({ automationCount: 0, schedulerRunning: false }),
    getActiveSessionCount: (workspaceId?: string) => workspaceId
      ? activeSessions.filter((session) => session.workspaceId === workspaceId).length
      : activeSessions.length,
    getActiveSessionsInfo: () => activeSessions,
    onSessionComplete(listener: () => void) {
      completionListener = listener
      return () => { completionListener = undefined }
    },
    reloadMcpServers,
  } as unknown as HandlerDeps['sessionManager']

  const deps = {
    sessionManager,
    oauthFlowStore: {},
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      imageProcessor: { getMetadata: async () => null, process: async () => Buffer.from('') },
    },
  } as unknown as HandlerDeps

  const context: ServerHandlerContext = {
    getConnectedClientCount: () => 1,
    serverId: 'test-server',
    startedAt: Date.now(),
    ...(options?.restartSupported === false ? {} : { requestRestart }),
  }
  registerServerHandlers(server, deps, context)

  const requestContext: RequestContext = {
    clientId: 'client-1',
    workspaceId: null,
    webContentsId: null,
  }

  return {
    getHandler(channel: string) {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`Handler not registered: ${channel}`)
      return handler
    },
    requestContext,
    requestRestart,
    reloadMcpServers,
    setActiveSessions(value: ActiveSessionInfo[]) { activeSessions = value },
    emitCompletion() { completionListener?.() },
  }
}

const ACTIVE_SESSION: ActiveSessionInfo = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  workspaceName: 'Workspace 1',
  status: 'processing',
  createdAt: Date.now(),
}

describe('server lifecycle RPC handlers', () => {
  it('refuses to delete the workspace currently used by the client', async () => {
    const harness = createHarness()
    const remove = harness.getHandler(RPC_CHANNELS.server.DELETE_WORKSPACE)

    await expect(remove({ ...harness.requestContext, workspaceId: 'ws-1' }, 'ws-1'))
      .rejects.toThrow('Cannot remove the active workspace')
  })

  it('refuses to delete a workspace with an active session', async () => {
    const harness = createHarness()
    harness.setActiveSessions([ACTIVE_SESSION])
    const remove = harness.getHandler(RPC_CHANNELS.server.DELETE_WORKSPACE)

    await expect(remove(harness.requestContext, 'ws-1'))
      .rejects.toThrow('Cannot remove a workspace while it has active sessions')
  })

  it('restarts after the response when the server is idle', async () => {
    const harness = createHarness()
    const restart = harness.getHandler(RPC_CHANNELS.server.RESTART)

    const result = await restart(harness.requestContext)
    expect(result).toMatchObject({ accepted: true, status: 'restarting', activeSessions: 0 })
    expect(harness.requestRestart).toHaveBeenCalledTimes(0)

    await Bun.sleep(130)
    expect(harness.requestRestart).toHaveBeenCalledTimes(1)
  })

  it('delays restart until every active workspace is idle', async () => {
    const harness = createHarness()
    harness.setActiveSessions([ACTIVE_SESSION])
    const restart = harness.getHandler(RPC_CHANNELS.server.RESTART)

    const result = await restart(harness.requestContext)
    expect(result).toMatchObject({
      accepted: true,
      status: 'delayed',
      activeSessions: 1,
      activeWorkspaceIds: ['ws-1'],
    })
    await Bun.sleep(130)
    expect(harness.requestRestart).toHaveBeenCalledTimes(0)

    harness.setActiveSessions([])
    harness.emitCompletion()
    await Bun.sleep(130)
    expect(harness.requestRestart).toHaveBeenCalledTimes(1)
  })

  it('makes repeated restart requests idempotent', async () => {
    const harness = createHarness()
    harness.setActiveSessions([ACTIVE_SESSION])
    const restart = harness.getHandler(RPC_CHANNELS.server.RESTART)

    await restart(harness.requestContext)
    const repeated = await restart(harness.requestContext)
    expect(repeated).toMatchObject({ accepted: true, status: 'already_pending' })
  })

  it('reports unsupported when the host has no process restart hook', async () => {
    const harness = createHarness({ restartSupported: false })
    const restart = harness.getHandler(RPC_CHANNELS.server.RESTART)

    expect(await restart(harness.requestContext)).toMatchObject({
      accepted: false,
      status: 'unsupported',
    })
  })

  it('forwards optional workspace scope to the MCP reload API', async () => {
    const harness = createHarness()
    const reload = harness.getHandler(RPC_CHANNELS.server.RELOAD_MCP_SERVERS)

    await reload(harness.requestContext, { workspaceId: 'ws-2' })
    expect(harness.reloadMcpServers).toHaveBeenCalledWith('ws-2')

    await reload(harness.requestContext, 'ws-3')
    expect(harness.reloadMcpServers).toHaveBeenLastCalledWith('ws-3')
  })
})
