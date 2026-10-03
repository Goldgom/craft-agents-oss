import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { SuperAgentCommand, SuperAgentConfig } from '@craft-agent/shared/super-agent'
import type { RequestContext, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { getSuperAgentService, restoreSuperAgents } from '../../super-agent/registry'

export const HANDLED_CHANNELS = [RPC_CHANNELS.superAgent.GET, RPC_CHANNELS.superAgent.SAVE, RPC_CHANNELS.superAgent.COMMAND] as const

export function assertSuperAgentWorkspace(ctx: RequestContext, workspaceId: string): void {
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 200) throw new Error('A workspace ID is required')
  if (ctx.workspaceId && ctx.workspaceId !== workspaceId) throw new Error('Super Agent belongs to a different workspace')
}

export function registerSuperAgentHandlers(server: RpcServer, deps: HandlerDeps): void {
  const service = getSuperAgentService(deps.sessionManager)
  server.handle(RPC_CHANNELS.superAgent.GET, async (ctx, workspaceId: string) => {
    assertSuperAgentWorkspace(ctx, workspaceId)
    return service.get(workspaceId)
  })
  server.handle(RPC_CHANNELS.superAgent.SAVE, async (ctx, workspaceId: string, config: SuperAgentConfig) => {
    assertSuperAgentWorkspace(ctx, workspaceId)
    return service.save(workspaceId, config)
  })
  server.handle(RPC_CHANNELS.superAgent.COMMAND, async (ctx, workspaceId: string, command: SuperAgentCommand) => {
    assertSuperAgentWorkspace(ctx, workspaceId)
    return service.command(workspaceId, command)
  })
  void restoreSuperAgents(deps.sessionManager, error => deps.platform.logger.error('[SuperAgent] Restore failed:', error))
    .catch(error => deps.platform.logger.error('[SuperAgent] Initialization failed:', error))
}
