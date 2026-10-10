import { join } from 'node:path'
import { bootstrapServer } from '@craft-agent/server-core/bootstrap'
import { registerCoreRpcHandlers, cleanupSessionFileWatchForClient } from '@craft-agent/server-core/handlers/rpc'
import { SessionManager, setSessionPlatform, setSessionRuntimeHooks } from '@craft-agent/server-core/sessions'
import { initModelRefreshService, setFetcherPlatform } from '@craft-agent/server-core/model-fetchers'
import { setSearchPlatform, setImageProcessor } from '@craft-agent/server-core/services'
import { addWorkspace, ensureConfigDir, loadStoredConfig, saveConfig, getLlmConnection, getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { SecureStorageBackend } from '@craft-agent/shared/credentials/backends/secure-storage'
import { setBundledAssetsRoot } from '@craft-agent/shared/utils'
import type { PlatformServices } from '@craft-agent/server-core/runtime'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getNotificationsEnabled, setNotificationsEnabled } from '@craft-agent/shared/config'
import { normalizeWin7Setup, normalizeWin7Test, NATIVE_BACKEND_ERROR } from './runtime-policy'

export async function startLocalBackend(platform: PlatformServices & { updateProxySettings(settings: any): Promise<void> }, keyProtection: any, token: string) {
  const dataRoot = process.env.TOKENBIRD_CONFIG_DIR!
  setBundledAssetsRoot(platform.appRootPath)
  ensureConfigDir()
  if (!loadStoredConfig()) saveConfig({ workspaces: [], activeWorkspaceId: null, activeSessionId: null, browserToolEnabled: false })
  let config = loadStoredConfig()!
  if (!config.workspaces.length) {
    addWorkspace({ name: 'Win7 本地工作区', rootPath: join(dataRoot, 'workspaces', 'local') })
  }
  config = loadStoredConfig()!
  const workspace = config.workspaces.find(item => item.id === config.activeWorkspaceId) || config.workspaces[0]!
  getCredentialManager().configureBackend(new SecureStorageBackend(join(dataRoot, 'credentials.enc'), keyProtection))
  const instance = await bootstrapServer<SessionManager, any>({
    rpcHost: '127.0.0.1', rpcPort: 0, serverToken: token, serverId: 'win7-local', serverVersion: platform.appVersion,
    bundledAssetsRoot: platform.appRootPath, platformFactory: () => platform,
    applyPlatformToSubsystems: platform => {
      setFetcherPlatform(platform); setSessionPlatform(platform); setSearchPlatform(platform); setImageProcessor(platform.imageProcessor)
      setSessionRuntimeHooks({ updateBadgeCount: () => {}, captureException: error => platform.captureError?.(error instanceof Error ? error : new Error(String(error))) })
    },
    createSessionManager: () => new SessionManager(),
    createHandlerDeps: ({ sessionManager, platform, oauthFlowStore }) => ({ sessionManager, platform, oauthFlowStore }),
    registerAllRpcHandlers: (server, deps, context) => {
      // Wrap only this app's handlers, never mutate the regular desktop runtime.
      const compatServer = new Proxy(server, {
        get(target, property) {
          if (property !== 'handle') {
            const value = Reflect.get(target, property)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return (channel: string, handler: any) => target.handle(channel, async (ctx, ...args) => {
            try {
              if (channel === RPC_CHANNELS.settings.SETUP_LLM_CONNECTION) args[0] = normalizeWin7Setup(args[0], getLlmConnection(args[0].slug))
              if (channel === RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP) args[0] = normalizeWin7Test(args[0])
              if (channel === RPC_CHANNELS.onboarding.START_CLAUDE_OAUTH || channel === RPC_CHANNELS.codex.INSTALL) return { success: false, error: NATIVE_BACKEND_ERROR }
              if (channel === RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED && args[0]) throw new Error('Win7 版暂未适配原生浏览器自动化，不能启用该工具。')
              if (channel === RPC_CHANNELS.llmConnections.SAVE && (args[0]?.agentRuntime === 'codex' || args[0]?.providerType === 'anthropic')) throw new Error(NATIVE_BACKEND_ERROR)
              return await handler(ctx, ...args)
            } catch (error) {
              if ([RPC_CHANNELS.settings.SETUP_LLM_CONNECTION, RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP, RPC_CHANNELS.llmConnections.SAVE].includes(channel as any)) {
                return { success: false, error: error instanceof Error ? error.message : String(error) }
              }
              throw error
            }
          })
        },
      })
      registerCoreRpcHandlers(compatServer, deps, context)
      server.handle(RPC_CHANNELS.notification.GET_ENABLED, () => getNotificationsEnabled())
      server.handle(RPC_CHANNELS.notification.SET_ENABLED, (_ctx, enabled) => setNotificationsEnabled(Boolean(enabled)))
      server.handle(RPC_CHANNELS.settings.SET_NETWORK_PROXY, (_ctx, settings) => platform.updateProxySettings!(settings))
    },
    initializeSessionManager: manager => manager.initialize(),
    setSessionEventSink: (manager, sink) => manager.setEventSink(sink),
    initModelRefreshService: () => initModelRefreshService(async slug => ({ apiKey: await getCredentialManager().getLlmApiKey(slug) || undefined })),
    cleanupSessionManager: async manager => { try { await manager.flushAllSessions() } finally { await manager.cleanup() } },
    cleanupClientResources: cleanupSessionFileWatchForClient,
  })
  return {
    instance,
    notificationsEnabled: getNotificationsEnabled,
    requireWorkspace(id: string) {
      const value = typeof id === 'string' ? getWorkspaceByNameOrId(id) : null
      if (!value || value.id !== id || value.remoteServer) throw new Error('本地工作区不存在，或此版本不支持该远程工作区')
      return value
    },
    connection: { serverUrl: `ws://127.0.0.1:${instance.port}`, token, workspaceId: workspace.id, mode: 'local' },
  }
}
