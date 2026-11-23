import { RPC_CHANNELS } from '@tokenbird/shared/protocol'
import type { VideoExecuteRequest } from '@tokenbird/shared/video'
import { getWorkspaceByNameOrId } from '@tokenbird/shared/config'
import type { RpcServer } from '@tokenbird/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { getVideoService, setVideoAnalyzer } from '../../services/video/service'
import { createVideoAnalyzer } from '../../services/video/agent-analysis'

export const HANDLED_CHANNELS = [RPC_CHANNELS.video.EXECUTE] as const

/** UI commands are explicitly initiated by the user. Agent commands use the session tool policy. */
export function registerVideoHandlers(server: RpcServer, deps: HandlerDeps): void {
  setVideoAnalyzer(createVideoAnalyzer(deps.sessionManager))
  server.handle(RPC_CHANNELS.video.EXECUTE, async (ctx, request: VideoExecuteRequest) => {
    if (!request || typeof request !== 'object' || typeof request.action !== 'string') throw new Error('无效的视频操作')
    const requested = request.args?.workspaceId
    const bound = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    const workspace = bound ? getWorkspaceByNameOrId(bound) : null
    if (!workspace) throw new Error('请先连接工作区')
    if (requested !== undefined && requested !== workspace.id && requested !== bound) throw new Error('视频操作不能访问其他工作区')
    return getVideoService().execute(workspace.id, request.action, request.args ?? {})
  })
}
