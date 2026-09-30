import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { loadWorkspaceSources } from '@craft-agent/shared/sources'
import { safeJsonParse } from '@craft-agent/shared/utils/files'
import type { RequestContext, RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.sources.GET,
  RPC_CHANNELS.sources.CREATE,
  RPC_CHANNELS.sources.DELETE,
  RPC_CHANNELS.sources.START_OAUTH,
  RPC_CHANNELS.sources.SAVE_CREDENTIALS,
  RPC_CHANNELS.sources.SAVE_CREDENTIALS_BATCH,
  RPC_CHANNELS.sources.GET_PERMISSIONS,
  RPC_CHANNELS.workspace.GET_PERMISSIONS,
  RPC_CHANNELS.permissions.GET_DEFAULTS,
  RPC_CHANNELS.sources.GET_MCP_TOOLS,
] as const

export function registerSourcesHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  const assertCredentialWorkspace = (ctx: RequestContext, workspaceId: string): void => {
    if (!ctx.workspaceId || ctx.workspaceId !== workspaceId) throw new Error('Credential workspace does not match the connected workspace')
  }

  // Get all sources for a workspace
  server.handle(RPC_CHANNELS.sources.GET, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.error(`SOURCES_GET: Workspace not found: ${workspaceId}`)
      return []
    }
    return loadWorkspaceSources(workspace.rootPath)
  })

  // Create a new source
  server.handle(RPC_CHANNELS.sources.CREATE, async (_ctx, workspaceId: string, config: Partial<import('@craft-agent/shared/sources').CreateSourceInput>) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { createSource } = await import('@craft-agent/shared/sources')
    return createSource(workspace.rootPath, {
      name: config.name || 'New Source',
      provider: config.provider || 'custom',
      type: config.type || 'mcp',
      enabled: config.enabled ?? true,
      mcp: config.mcp,
      api: config.api,
      local: config.local,
    })
  })

  // Delete a source
  server.handle(RPC_CHANNELS.sources.DELETE, async (_ctx, workspaceId: string, sourceSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { deleteSource } = await import('@craft-agent/shared/sources')
    deleteSource(workspace.rootPath, sourceSlug)

    // Clean up stale slug from workspace default sources
    const { loadWorkspaceConfig, saveWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
    const config = loadWorkspaceConfig(workspace.rootPath)
    if (config?.defaults?.enabledSourceSlugs?.includes(sourceSlug)) {
      config.defaults.enabledSourceSlugs = config.defaults.enabledSourceSlugs.filter(s => s !== sourceSlug)
      saveWorkspaceConfig(workspace.rootPath, config)
    }
  })

  // Start OAuth flow for a source (DEPRECATED — use oauth:start + performOAuth client-side)
  // Kept for backward compatibility with old IPC preload; WS clients use performOAuth().
  server.handle(RPC_CHANNELS.sources.START_OAUTH, async () => {
    return {
      success: false,
      error: 'Deprecated: use the client-side performOAuth() flow (oauth:start + oauth:complete) instead',
    }
  })

  // Save credentials for a source (bearer token or API key)
  server.handle(RPC_CHANNELS.sources.SAVE_CREDENTIALS, async (ctx, workspaceId: string, sourceSlug: string, credential: string) => {
    assertCredentialWorkspace(ctx, workspaceId)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { saveSourceCredentialBatch } = await import('@craft-agent/shared/sources')
    const result = await saveSourceCredentialBatch(workspace.rootPath, [{ sourceSlug, credential }])
    if (result.statusUpdateFailed.length) log.warn('Credential saved, but source status could not be updated')
    log.info(`Saved credentials for source: ${sourceSlug}`)
  })

  server.handle(RPC_CHANNELS.sources.SAVE_CREDENTIALS_BATCH, async (ctx, workspaceId: string, entries: import('@craft-agent/shared/sources').SourceCredentialUpdate[]) => {
    assertCredentialWorkspace(ctx, workspaceId)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const { saveSourceCredentialBatch } = await import('@craft-agent/shared/sources')
    return saveSourceCredentialBatch(workspace.rootPath, entries)
  })

  // Get permissions config for a source (raw format for UI display)
  server.handle(RPC_CHANNELS.sources.GET_PERMISSIONS, async (_ctx, workspaceId: string, sourceSlug: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null

    const { existsSync, readFileSync } = await import('fs')
    const { getSourcePermissionsPath } = await import('@craft-agent/shared/agent')
    const path = getSourcePermissionsPath(workspace.rootPath, sourceSlug)

    if (!existsSync(path)) return null

    try {
      const content = readFileSync(path, 'utf-8')
      return safeJsonParse(content)
    } catch (error) {
      log.error('Error reading permissions config:', error)
      return null
    }
  })

  // Get permissions config for a workspace (raw format for UI display)
  server.handle(RPC_CHANNELS.workspace.GET_PERMISSIONS, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null

    const { existsSync, readFileSync } = await import('fs')
    const { getWorkspacePermissionsPath } = await import('@craft-agent/shared/agent')
    const path = getWorkspacePermissionsPath(workspace.rootPath)

    if (!existsSync(path)) return null

    try {
      const content = readFileSync(path, 'utf-8')
      return safeJsonParse(content)
    } catch (error) {
      log.error('Error reading workspace permissions config:', error)
      return null
    }
  })

  // Get default permissions from ~/.tokenbird/permissions/default.json
  server.handle(RPC_CHANNELS.permissions.GET_DEFAULTS, async () => {
    const { existsSync, readFileSync } = await import('fs')
    const { getAppPermissionsDir } = await import('@craft-agent/shared/agent')
    const { join } = await import('path')

    const defaultPath = join(getAppPermissionsDir(), 'default.json')
    if (!existsSync(defaultPath)) return { config: null, path: defaultPath }

    try {
      const content = readFileSync(defaultPath, 'utf-8')
      return { config: safeJsonParse(content), path: defaultPath }
    } catch (error) {
      log.error('Error reading default permissions config:', error)
      return { config: null, path: defaultPath }
    }
  })

  // Get MCP tools for a source with permission status
  server.handle(RPC_CHANNELS.sources.GET_MCP_TOOLS, async (_ctx, workspaceId: string, sourceSlug: string, forceRefresh = false) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return { success: false, error: 'Workspace not found' }

    let refreshedSource: Awaited<ReturnType<typeof loadWorkspaceSources>>[number] | undefined
    try {
      const sources = await loadWorkspaceSources(workspace.rootPath)
      const source = sources.find(s => s.config.slug === sourceSlug)
      if (!source) return { success: false, error: 'Source not found' }
      if (source.config.type !== 'mcp') return { success: false, error: 'Source is not an MCP server' }
      if (!source.config.mcp) return { success: false, error: 'MCP config not found' }
      refreshedSource = source

      if (!forceRefresh && source.config.connectionStatus === 'needs_auth') {
        return { success: false, error: 'Source requires authentication' }
      }
      if (!forceRefresh && source.config.connectionStatus === 'failed') {
        return { success: false, error: source.config.connectionError || 'Connection failed' }
      }
      if (!forceRefresh && source.config.connectionStatus === 'untested') {
        return { success: false, error: 'Source has not been tested yet' }
      }

      const { CraftMcpClient } = await import('@craft-agent/shared/mcp')
      let client: InstanceType<typeof CraftMcpClient>

      if (source.config.mcp.transport === 'stdio') {
        if (!source.config.mcp.command) {
          return { success: false, error: 'Stdio MCP source is missing required "command" field' }
        }
        log.info(`Fetching MCP tools via stdio: ${source.config.mcp.command}`)
        client = new CraftMcpClient({
          transport: 'stdio',
          command: source.config.mcp.command,
          args: source.config.mcp.args,
          env: source.config.mcp.env,
        })
      } else {
        if (!source.config.mcp.url) {
          return { success: false, error: 'MCP source URL is required for HTTP/SSE transport' }
        }

        const { getSourceCredentialManager, getSourceServerBuilder, TokenRefreshManager } = await import('@craft-agent/shared/sources')
        const credentials = getSourceCredentialManager()
        let accessToken: string | undefined
        if ((source.config.mcp.authType === 'oauth' || source.config.mcp.authType === 'bearer') && !source.config.mcp.headerNames?.length) {
          const fresh = await new TokenRefreshManager(credentials).ensureFreshToken(source)
          if (!fresh.success || !fresh.token) throw new Error('Authentication required. Please re-authenticate with this source.')
          accessToken = fresh.token
        }
        const headerCredentials = source.config.mcp.headerNames?.length ? await credentials.getApiCredential(source) : null
        if (source.config.mcp.headerNames?.length && !headerCredentials) throw new Error('Authentication required. Please save credentials for this source.')
        const config = getSourceServerBuilder().buildMcpServer(source, accessToken ?? null, headerCredentials)
        if (!config || config.type === 'stdio') throw new Error('MCP connection configuration is invalid')
        client = new CraftMcpClient({
          transport: config.type,
          url: config.url,
          headers: config.headers,
        })
      }

      const tools = await client.listTools().finally(() => client.close())
      if (forceRefresh) {
        const { saveSourceConfig } = await import('@craft-agent/shared/sources')
        source.config.connectionStatus = 'connected'
        source.config.isAuthenticated = true
        source.config.connectionError = undefined
        source.config.lastTestedAt = Date.now()
        saveSourceConfig(workspace.rootPath, source.config)
      }

      const { loadSourcePermissionsConfig, permissionsConfigCache } = await import('@craft-agent/shared/agent')
      const permissionsConfig = loadSourcePermissionsConfig(workspace.rootPath, sourceSlug)

      const mergedConfig = permissionsConfigCache.getMergedConfig({
        workspaceRootPath: workspace.rootPath,
        activeSourceSlugs: [sourceSlug],
      })

      const toolsWithPermission = tools.map(tool => {
        const allowed = mergedConfig.readOnlyMcpPatterns.some((pattern: RegExp) => pattern.test(tool.name))
        return {
          name: tool.name,
          description: tool.description,
          allowed,
        }
      })

      return { success: true, tools: toolsWithPermission }
    } catch (error) {
      // SDK/provider exceptions may echo request headers or response bodies.
      // Classify locally, but never log, persist, or return their raw text.
      const { sanitizeMcpConnectionError } = await import('@craft-agent/shared/mcp')
      const { needsAuth, message: errorMessage } = sanitizeMcpConnectionError(error)
      log.error('Failed to get MCP tools:', errorMessage)
      if (forceRefresh && refreshedSource) {
        const { saveSourceConfig } = await import('@craft-agent/shared/sources')
        refreshedSource.config.connectionStatus = needsAuth ? 'needs_auth' : 'failed'
        if (refreshedSource.config.connectionStatus === 'needs_auth') refreshedSource.config.isAuthenticated = false
        refreshedSource.config.connectionError = errorMessage
        refreshedSource.config.lastTestedAt = Date.now()
        saveSourceConfig(workspace.rootPath, refreshedSource.config)
      }
      return { success: false, error: errorMessage }
    }
  })
}
