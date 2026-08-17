import { existsSync } from 'node:fs'
import { join } from 'path'
import { homedir } from 'os'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { addWorkspace, removeWorkspace, setActiveWorkspace } from '@craft-agent/shared/config'
import { getDefaultWorkspacesDir, ensureDefaultWorkspacesDir } from '@craft-agent/shared/workspaces'
import type { ServerStatus, ServerHealth, ServerRestartResult } from '@craft-agent/core/types'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { ServerHandlerContext } from '../../bootstrap/headless-start'
import { isValidWorkspaceRootPath } from '../../utils/path-validation'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.server.GET_WORKSPACES,
  RPC_CHANNELS.server.CREATE_WORKSPACE,
  RPC_CHANNELS.server.DELETE_WORKSPACE,
  RPC_CHANNELS.server.GET_STATUS,
  RPC_CHANNELS.server.GET_HEALTH,
  RPC_CHANNELS.server.GET_ACTIVE_SESSIONS,
  RPC_CHANNELS.server.RESTART,
  RPC_CHANNELS.server.RELOAD_MCP_SERVERS,
  RPC_CHANNELS.server.HOME_DIR,
] as const

export function registerServerHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  ctx: ServerHandlerContext,
): void {
  const { sessionManager } = deps
  let restartRequestedAt: number | undefined
  let restartStarted = false
  let unsubscribeRestartWaiter: (() => void) | undefined

  const getRestartActivity = () => {
    const active = sessionManager.getActiveSessionsInfo()
    return {
      activeSessions: active.length,
      activeWorkspaceIds: Array.from(new Set(active.map((session) => session.workspaceId))),
    }
  }

  const attemptPendingRestart = (): void => {
    if (!restartRequestedAt || restartStarted || !ctx.requestRestart) return
    if (sessionManager.getActiveSessionCount() > 0) return

    // Let the RPC response and the final session-complete event flush before
    // the host closes WebSocket connections and exits.
    setTimeout(() => {
      if (!restartRequestedAt || restartStarted || sessionManager.getActiveSessionCount() > 0) return
      restartStarted = true
      unsubscribeRestartWaiter?.()
      unsubscribeRestartWaiter = undefined
      Promise.resolve(ctx.requestRestart?.()).catch((error) => {
        restartStarted = false
        deps.platform.logger.error('[server:restart] Restart failed', error)
      })
    }, 100)
  }

  // -----------------------------------------------------------------------
  // Workspace discovery (moved from workspace.ts — server-level, no workspace context)
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.GET_WORKSPACES, async () => {
    const workspaces = sessionManager.getWorkspacesInfo()
    deps.platform.logger.info(`[server:getWorkspaces] returning ${workspaces.length} workspaces: ${JSON.stringify(workspaces.map(w => ({ id: w.id, name: w.name })))}`)
    return workspaces
  })

  server.handle(RPC_CHANNELS.server.CREATE_WORKSPACE, async (_ctx, name: string, requestedRootPath?: string) => {
    if (!name?.trim()) throw new Error('Workspace name is required')
    const trimmed = name.trim()

    const slug = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      || 'workspace'

    let rootPath: string
    if (requestedRootPath?.trim()) {
      rootPath = requestedRootPath.trim()
      const validation = isValidWorkspaceRootPath(rootPath)
      if (!validation.valid) throw new Error(validation.reason!)

      const existing = sessionManager.getWorkspaces().find((workspace) => workspace.rootPath === rootPath)
      if (existing) throw new Error(`A workspace already exists at ${rootPath}`)
    } else {
      ensureDefaultWorkspacesDir()
      const baseDir = getDefaultWorkspacesDir()
      rootPath = join(baseDir, slug)
      let uniqueSlug = slug
      let counter = 1
      while (existsSync(rootPath)) {
        uniqueSlug = `${slug}-${counter++}`
        rootPath = join(baseDir, uniqueSlug)
      }
    }

    const workspace = addWorkspace({ name: trimmed, rootPath })
    setActiveWorkspace(workspace.id)
    deps.platform.logger.info(`Created workspace "${trimmed}" at ${rootPath} (server:createWorkspace)`)

    const { rootPath: _rp, createdAt: _ca, ...info } = workspace
    return info
  })

  server.handle(RPC_CHANNELS.server.DELETE_WORKSPACE, async (requestContext, workspaceId: string) => {
    if (!workspaceId) throw new Error('Workspace ID is required')
    if (requestContext.workspaceId === workspaceId) {
      throw new Error('Cannot remove the active workspace')
    }
    if (sessionManager.getActiveSessionCount(workspaceId) > 0) {
      throw new Error('Cannot remove a workspace while it has active sessions')
    }

    const removed = await removeWorkspace(workspaceId)
    if (removed) {
      deps.platform.logger.info(`Removed workspace ${workspaceId} (server:deleteWorkspace)`)
    }
    return removed
  })

  // -----------------------------------------------------------------------
  // Server Status
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.GET_STATUS, async () => {
    const workspaces = sessionManager.getWorkspacesInfo()
    const workspaceStatuses = workspaces.map(ws => {
      const summary = sessionManager.getWorkspaceAutomationSummary(ws.id)
      return {
        id: ws.id,
        name: ws.name,
        slug: ws.slug,
        activeSessions: sessionManager.getActiveSessionCount(ws.id),
        automationCount: summary.automationCount,
        schedulerRunning: summary.schedulerRunning,
      }
    })

    const mem = process.memoryUsage()
    const status: ServerStatus = {
      serverId: ctx.serverId,
      version: deps.platform.appVersion,
      uptime: Math.round((Date.now() - ctx.startedAt) / 1000),
      connectedClients: ctx.getConnectedClientCount(),
      workspaces: workspaceStatuses,
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
      },
      restart: {
        pending: restartRequestedAt !== undefined,
        requestedAt: restartRequestedAt,
        ...getRestartActivity(),
      },
    }

    return status
  })

  // -----------------------------------------------------------------------
  // Server Health
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.GET_HEALTH, async () => {
    return getHealthCheck(deps)
  })

  // -----------------------------------------------------------------------
  // Active Session Discovery
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.GET_ACTIVE_SESSIONS, async () => {
    return sessionManager.getActiveSessionsInfo()
  })

  server.handle(RPC_CHANNELS.server.RESTART, async () => {
    const activity = getRestartActivity()
    if (!ctx.requestRestart) {
      return {
        accepted: false,
        status: 'unsupported',
        ...activity,
      } satisfies ServerRestartResult
    }

    if (restartRequestedAt !== undefined) {
      return {
        accepted: true,
        status: 'already_pending',
        requestedAt: restartRequestedAt,
        ...activity,
      } satisfies ServerRestartResult
    }

    restartRequestedAt = Date.now()
    unsubscribeRestartWaiter = sessionManager.onSessionComplete(() => attemptPendingRestart())
    attemptPendingRestart()

    deps.platform.logger.info(
      activity.activeSessions > 0
        ? `[server:restart] Delayed until ${activity.activeSessions} active session(s) finish`
        : '[server:restart] Restart scheduled',
    )
    return {
      accepted: true,
      status: activity.activeSessions > 0 ? 'delayed' : 'restarting',
      requestedAt: restartRequestedAt,
      ...activity,
    } satisfies ServerRestartResult
  })

  server.handle(
    RPC_CHANNELS.server.RELOAD_MCP_SERVERS,
    async (_ctx, input?: string | { workspaceId?: string }) => {
      const workspaceId = typeof input === 'string' ? input : input?.workspaceId
      return sessionManager.reloadMcpServers(workspaceId)
    },
  )

  // -----------------------------------------------------------------------
  // Server Home Directory (REMOTE_ELIGIBLE — returns this server's home)
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.HOME_DIR, async () => {
    return homedir()
  })
}

// ---------------------------------------------------------------------------
// Health check logic (reusable by both RPC handler and HTTP endpoint)
// ---------------------------------------------------------------------------

export function getHealthCheck(deps: Pick<HandlerDeps, 'sessionManager'>): ServerHealth {
  const checks: ServerHealth['checks'] = []

  // Check 1: SessionManager is operational (has loaded workspaces)
  try {
    const workspaces = deps.sessionManager.getWorkspaces()
    checks.push({
      name: 'session_manager',
      status: 'pass',
      message: `${workspaces.length} workspace(s) loaded`,
    })
  } catch {
    checks.push({
      name: 'session_manager',
      status: 'fail',
      message: 'SessionManager not initialized',
    })
  }

  // Check 2: Memory usage (warn if heap exceeds 1.5GB)
  const mem = process.memoryUsage()
  const heapGB = mem.heapUsed / (1024 * 1024 * 1024)
  checks.push({
    name: 'memory',
    status: heapGB < 1.5 ? 'pass' : 'fail',
    message: `Heap: ${Math.round(heapGB * 100) / 100} GB`,
  })

  // Aggregate status
  const allPass = checks.every(c => c.status === 'pass')
  const anyFail = checks.some(c => c.status === 'fail')

  return {
    status: allPass ? 'ok' : anyFail ? 'unhealthy' : 'degraded',
    checks,
  }
}
