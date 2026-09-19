import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from './handler-deps'

export const GUI_HANDLED_CHANNELS = [
  RPC_CHANNELS.power.SET_KEEP_AWAKE,
  RPC_CHANNELS.settings.SET_NETWORK_PROXY,
  RPC_CHANNELS.tools.GET_RUNTIME_TOOLS,
  RPC_CHANNELS.tools.SET_RUNTIME_TOOL_PATH,
] as const

// ============================================================
// GUI-only settings (require Electron-specific APIs)
// ============================================================

export function registerSettingsGuiHandlers(server: RpcServer, _deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.tools.GET_RUNTIME_TOOLS, async () => {
    const { getRuntimeToolStatuses } = await import('../runtime-toolchains')
    return getRuntimeToolStatuses()
  })

  server.handle(RPC_CHANNELS.tools.SET_RUNTIME_TOOL_PATH, async (_ctx, tool: import('@craft-agent/shared/config/types').RuntimeToolId, path?: string) => {
    if (!['java', 'python', 'node'].includes(tool)) throw new Error(`Unsupported runtime tool: ${tool}`)
    const { updateRuntimeToolPath } = await import('../runtime-toolchains')
    return updateRuntimeToolPath(tool, path)
  })

  // Set keep awake while running setting (requires Electron power-manager)
  server.handle(RPC_CHANNELS.power.SET_KEEP_AWAKE, async (_ctx, enabled: boolean) => {
    const { setKeepAwakeWhileRunning } = await import('@craft-agent/shared/config/storage')
    const { setKeepAwakeSetting } = await import('../power-manager')
    // Save to config
    setKeepAwakeWhileRunning(enabled)
    // Update the power manager's cached value and power state
    setKeepAwakeSetting(enabled)
  })

  // Set network proxy settings (requires Electron session proxy)
  server.handle(RPC_CHANNELS.settings.SET_NETWORK_PROXY, async (_ctx, settings: import('@craft-agent/shared/config/types').NetworkProxySettings) => {
    const { updateConfiguredProxySettings } = await import('../network-proxy')
    await updateConfiguredProxySettings(settings)
  })
}
