import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getPreferencesPath, getSessionDraft, setSessionDraft, deleteSessionDraft, getAllSessionDrafts, getWorkspaceByNameOrId, getDefaultThinkingLevel, setDefaultThinkingLevel } from '@craft-agent/shared/config'
import { isValidThinkingLevel, normalizeThinkingLevel, THINKING_LEVEL_IDS } from '@craft-agent/shared/agent/thinking-levels'

const VALID_THINKING_LEVELS_LIST = THINKING_LEVEL_IDS.map(id => `'${id}'`).join(', ')
import { getWorkspaceOrThrow } from '@craft-agent/server-core/handlers'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { requestClientOpenFileDialog } from '@craft-agent/server-core/transport'
import { requestClientSaveFileDialog } from '@craft-agent/server-core/transport'
import { isValidWorkingDirectory } from '../../utils/path-validation'
import type { WorkspacePrompt } from '@craft-agent/shared/workspaces'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.workspace.SETTINGS_GET,
  RPC_CHANNELS.workspace.SETTINGS_UPDATE,
  RPC_CHANNELS.settings.PROMPTS_GET,
  RPC_CHANNELS.settings.PROMPTS_SAVE,
  RPC_CHANNELS.settings.PROMPTS_DELETE,
  RPC_CHANNELS.settings.PROMPTS_GENERATE,
  RPC_CHANNELS.settings.EXPORT_ALL_DATA,
  RPC_CHANNELS.settings.IMPORT_ALL_DATA,
  RPC_CHANNELS.preferences.READ,
  RPC_CHANNELS.preferences.WRITE,
  RPC_CHANNELS.drafts.GET,
  RPC_CHANNELS.drafts.SET,
  RPC_CHANNELS.drafts.DELETE,
  RPC_CHANNELS.drafts.GET_ALL,
  RPC_CHANNELS.input.GET_AUTO_CAPITALISATION,
  RPC_CHANNELS.input.SET_AUTO_CAPITALISATION,
  RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.GET_SPELL_CHECK,
  RPC_CHANNELS.input.SET_SPELL_CHECK,
  RPC_CHANNELS.power.GET_KEEP_AWAKE,
  RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS,
  RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS,
  RPC_CHANNELS.caching.GET_EXTENDED_PROMPT_CACHE,
  RPC_CHANNELS.caching.SET_EXTENDED_PROMPT_CACHE,
  RPC_CHANNELS.caching.GET_ENABLE_1M_CONTEXT,
  RPC_CHANNELS.caching.SET_ENABLE_1M_CONTEXT,
  RPC_CHANNELS.sessions.GET_MODEL,
  RPC_CHANNELS.sessions.SET_MODEL,
  RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED,
  RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED,
  RPC_CHANNELS.settings.GET_NETWORK_PROXY,
  RPC_CHANNELS.dialog.OPEN_FOLDER,
  RPC_CHANNELS.rtk.GET_ENABLED,
  RPC_CHANNELS.rtk.SET_ENABLED,
  RPC_CHANNELS.rtk.GET_STATUS,
  RPC_CHANNELS.rtk.GET_GAIN,
] as const

/**
 * Build the one-shot generation request for an AI-authored workspace
 * preference prompt. The model must answer with a strict JSON object.
 */
function buildWorkspacePromptGenerationPrompt(description: string): string {
  return `You are helping a user create a workspace preference prompt for their AI coding assistant.

A workspace preference is a standing instruction that is injected into every conversation in the workspace. It should describe conventions the assistant must follow (style, terminology, architecture, constraints, workflow, environment notes, etc.).

Based on the user's description below, write a concise, reusable preference. Write the content as imperative instructions for the assistant (e.g. "Always use...", "Never...", "Prefer..."). Use the language the user used in the description.

Reply with ONLY a JSON object (no markdown fences, no commentary) in exactly this shape:
{"title": "<short title, at most 60 characters>", "content": "<the preference instructions, 2-8 sentences>"}

User's description:
${description}`
}

/**
 * Parse the model's JSON answer, tolerating markdown fences and surrounding
 * prose. Falls back to using the raw text as content when JSON parsing fails.
 */
function parseGeneratedWorkspacePrompt(
  raw: string,
  titleMax: number,
  contentMax: number,
): { title: string; content: string } {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
      const title = String(obj.title ?? '').trim().slice(0, titleMax)
      const content = String(obj.content ?? '').trim().slice(0, contentMax)
      if (title && content) return { title, content }
    } catch {
      // fall through to raw-text fallback
    }
  }
  return {
    title: raw.slice(0, 60) || 'Workspace preference',
    content: raw.slice(0, contentMax),
  }
}

export function registerSettingsHandlers(server: RpcServer, deps: HandlerDeps): void {
  // ============================================================
  // Settings - Default Thinking Level (App-Level)
  // ============================================================

  server.handle(RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL, async () => {
    return getDefaultThinkingLevel()
  })

  server.handle(RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL, async (_ctx, level: string) => {
    if (!isValidThinkingLevel(level)) {
      throw new Error(`Invalid thinking level: ${level}. Valid values: ${VALID_THINKING_LEVELS_LIST}`)
    }
    const success = setDefaultThinkingLevel(level)
    if (!success) {
      throw new Error('Failed to persist default thinking level')
    }
    return { success: true }
  })

  // ============================================================
  // Settings - Model (Session-Specific)
  // ============================================================

  // Get session-specific model
  server.handle(RPC_CHANNELS.sessions.GET_MODEL, async (_ctx, sessionId: string, _workspaceId: string): Promise<string | null> => {
    const session = await deps.sessionManager.getSession(sessionId)
    return session?.model ?? null
  })

  // Set session-specific model (and optionally connection)
  server.handle(RPC_CHANNELS.sessions.SET_MODEL, async (_ctx, sessionId: string, workspaceId: string, model: string | null, connection?: string) => {
    await deps.sessionManager.updateSessionModel(sessionId, workspaceId, model, connection)
    deps.platform.logger.info(`Session ${sessionId} model updated to: ${model}${connection ? ` (connection: ${connection})` : ''}`)
  })

  // Open native folder dialog for selecting working directory (routed to client)
  server.handle(RPC_CHANNELS.dialog.OPEN_FOLDER, async (ctx) => {
    const result = await requestClientOpenFileDialog(server, ctx.clientId, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Working Directory',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // ============================================================
  // Workspace Settings (per-workspace configuration)
  // ============================================================

  // Get workspace settings (model, permission mode, working directory, credential strategy)
  server.handle(RPC_CHANNELS.workspace.SETTINGS_GET, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      deps.platform.logger.error(`Workspace not found: ${workspaceId}`)
      return null
    }

    // Load workspace config
    const { loadWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
    const config = loadWorkspaceConfig(workspace.rootPath)

    return {
      name: config?.name,
      model: config?.defaults?.model,
      permissionMode: config?.defaults?.permissionMode,
      cyclablePermissionModes: config?.defaults?.cyclablePermissionModes,
      thinkingLevel: normalizeThinkingLevel(config?.defaults?.thinkingLevel),
      workingDirectory: config?.defaults?.workingDirectory,
      localMcpEnabled: config?.localMcpServers?.enabled ?? true,
      defaultLlmConnection: config?.defaults?.defaultLlmConnection,
      enabledSourceSlugs: config?.defaults?.enabledSourceSlugs ?? [],
    }
  })

  // Update a workspace setting
  server.handle(RPC_CHANNELS.workspace.SETTINGS_UPDATE, async (_ctx, workspaceId: string, key: string, value: unknown) => {
    const workspace = getWorkspaceOrThrow(workspaceId)
    const normalizedValue = key === 'workingDirectory' && typeof value === 'string'
      ? value.trim()
      : value

    // Validate key is a known workspace setting
    const validKeys = ['name', 'model', 'enabledSourceSlugs', 'permissionMode', 'cyclablePermissionModes', 'thinkingLevel', 'workingDirectory', 'localMcpEnabled', 'defaultLlmConnection']
    if (!validKeys.includes(key)) {
      throw new Error(`Invalid workspace setting key: ${key}. Valid keys: ${validKeys.join(', ')}`)
    }

    // Validate defaultLlmConnection exists before saving
    if (key === 'defaultLlmConnection' && normalizedValue !== undefined && normalizedValue !== null) {
      const { getLlmConnection } = await import('@craft-agent/shared/config/storage')
      if (!getLlmConnection(normalizedValue as string)) {
        throw new Error(`LLM connection "${normalizedValue}" not found`)
      }
    }

    if (key === 'workingDirectory' && normalizedValue !== undefined && normalizedValue !== null) {
      const validation = isValidWorkingDirectory(String(normalizedValue))
      if (!validation.valid) {
        throw new Error(validation.reason!)
      }
    }

    const { loadWorkspaceConfig, saveWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
    const config = loadWorkspaceConfig(workspace.rootPath)
    if (!config) {
      throw new Error(`Failed to load workspace config: ${workspaceId}`)
    }

    // Handle 'name' specially - it's a top-level config property, not in defaults
    if (key === 'name') {
      config.name = String(normalizedValue).trim()
    } else if (key === 'localMcpEnabled') {
      // Store in localMcpServers.enabled (top-level, not in defaults)
      config.localMcpServers = config.localMcpServers || { enabled: true }
      config.localMcpServers.enabled = Boolean(normalizedValue)
    } else {
      // Update the setting in defaults
      config.defaults = config.defaults || {}
      ;(config.defaults as Record<string, unknown>)[key] = normalizedValue
    }

    // Save the config
    saveWorkspaceConfig(workspace.rootPath, config)
    deps.platform.logger.info(`Workspace setting updated: ${key} = ${JSON.stringify(normalizedValue)}`)
  })

  // ============================================================
  // User Preferences
  // ============================================================

  // Read user preferences file
  server.handle(RPC_CHANNELS.preferences.READ, async () => {
    const path = getPreferencesPath()
    if (!existsSync(path)) {
      return { content: '{}', exists: false, path }
    }
    return { content: readFileSync(path, 'utf-8'), exists: true, path }
  })

  // Write user preferences file (validates JSON before saving)
  server.handle(RPC_CHANNELS.preferences.WRITE, async (_, content: string) => {
    try {
      JSON.parse(content) // Validate JSON
      const path = getPreferencesPath()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, 'utf-8')
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // ============================================================
  // Session Drafts (persisted input text)
  // ============================================================

  // Get draft for a session (text + attachment refs)
  server.handle(RPC_CHANNELS.drafts.GET, async (_ctx, sessionId: string) => {
    return getSessionDraft(sessionId)
  })

  // Set draft for a session (empty drafts are cleared)
  server.handle(RPC_CHANNELS.drafts.SET, async (_ctx, sessionId: string, draft: import('@craft-agent/shared/config').SessionDraft) => {
    setSessionDraft(sessionId, draft)
  })

  // Delete draft for a session
  server.handle(RPC_CHANNELS.drafts.DELETE, async (_ctx, sessionId: string) => {
    deleteSessionDraft(sessionId)
  })

  // Get all drafts (for loading on app start)
  server.handle(RPC_CHANNELS.drafts.GET_ALL, async () => {
    return getAllSessionDrafts()
  })

  // ============================================================
  // Input Settings
  // ============================================================

  // Get auto-capitalisation setting
  server.handle(RPC_CHANNELS.input.GET_AUTO_CAPITALISATION, async () => {
    const { getAutoCapitalisation } = await import('@craft-agent/shared/config/storage')
    return getAutoCapitalisation()
  })

  // Set auto-capitalisation setting
  server.handle(RPC_CHANNELS.input.SET_AUTO_CAPITALISATION, async (_ctx, enabled: boolean) => {
    const { setAutoCapitalisation } = await import('@craft-agent/shared/config/storage')
    setAutoCapitalisation(enabled)
  })

  // Get send message key setting
  server.handle(RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY, async () => {
    const { getSendMessageKey } = await import('@craft-agent/shared/config/storage')
    return getSendMessageKey()
  })

  // Set send message key setting
  server.handle(RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY, async (_ctx, key: 'enter' | 'cmd-enter') => {
    const { setSendMessageKey } = await import('@craft-agent/shared/config/storage')
    setSendMessageKey(key)
  })

  // Get spell check setting
  server.handle(RPC_CHANNELS.input.GET_SPELL_CHECK, async () => {
    const { getSpellCheck } = await import('@craft-agent/shared/config/storage')
    return getSpellCheck()
  })

  // Set spell check setting
  server.handle(RPC_CHANNELS.input.SET_SPELL_CHECK, async (_ctx, enabled: boolean) => {
    const { setSpellCheck } = await import('@craft-agent/shared/config/storage')
    setSpellCheck(enabled)
  })

  // ============================================================
  // Power Settings
  // ============================================================

  // Get keep awake while running setting
  server.handle(RPC_CHANNELS.power.GET_KEEP_AWAKE, async () => {
    const { getKeepAwakeWhileRunning } = await import('@craft-agent/shared/config/storage')
    return getKeepAwakeWhileRunning()
  })

  // ============================================================
  // Appearance Settings
  // ============================================================

  // Get rich tool descriptions setting
  server.handle(RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS, async () => {
    const { getRichToolDescriptions } = await import('@craft-agent/shared/config/storage')
    return getRichToolDescriptions()
  })

  // Set rich tool descriptions setting
  server.handle(RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS, async (_ctx, enabled: boolean) => {
    const { setRichToolDescriptions } = await import('@craft-agent/shared/config/storage')
    setRichToolDescriptions(enabled)
  })

  // ============================================================
  // Prompt Caching Settings
  // ============================================================

  // Get extended prompt cache (1h TTL) setting
  server.handle(RPC_CHANNELS.caching.GET_EXTENDED_PROMPT_CACHE, async () => {
    const { getExtendedPromptCache } = await import('@craft-agent/shared/config/storage')
    return getExtendedPromptCache()
  })

  // Set extended prompt cache (1h TTL) setting
  server.handle(RPC_CHANNELS.caching.SET_EXTENDED_PROMPT_CACHE, async (_ctx, enabled: boolean) => {
    const { setExtendedPromptCache } = await import('@craft-agent/shared/config/storage')
    setExtendedPromptCache(enabled)
  })

  // Get 1M context window setting
  server.handle(RPC_CHANNELS.caching.GET_ENABLE_1M_CONTEXT, async () => {
    const { getEnable1MContext } = await import('@craft-agent/shared/config/storage')
    return getEnable1MContext()
  })

  // Set 1M context window setting
  server.handle(RPC_CHANNELS.caching.SET_ENABLE_1M_CONTEXT, async (_ctx, enabled: boolean) => {
    const { setEnable1MContext } = await import('@craft-agent/shared/config/storage')
    setEnable1MContext(enabled)
  })

  // ============================================================
  // RTK Token-Optimization Settings
  // ============================================================

  // Get rtk Bash-output compression setting
  server.handle(RPC_CHANNELS.rtk.GET_ENABLED, async () => {
    const { getRtkEnabled } = await import('@craft-agent/shared/config/storage')
    return getRtkEnabled()
  })

  // Set rtk Bash-output compression setting
  server.handle(RPC_CHANNELS.rtk.SET_ENABLED, async (_ctx, enabled: boolean) => {
    const { setRtkEnabled } = await import('@craft-agent/shared/config/storage')
    setRtkEnabled(enabled)
  })

  // Detect rtk installation (used by Settings UI to swap install prompt ↔ toggle)
  server.handle(RPC_CHANNELS.rtk.GET_STATUS, async (_ctx, opts?: { forceRecheck?: boolean }) => {
    const { getRtkStatus } = await import('@craft-agent/shared/agent')
    return getRtkStatus(opts)
  })

  // Token-savings summary from `rtk gain --format json` (efficiency meter)
  server.handle(RPC_CHANNELS.rtk.GET_GAIN, async () => {
    const { getRtkGain } = await import('@craft-agent/shared/agent')
    return getRtkGain()
  })

  // ============================================================
  // Tools Settings
  // ============================================================

  server.handle(RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED, async () => {
    const { getBrowserToolEnabled } = await import('@craft-agent/shared/config/storage')
    return getBrowserToolEnabled()
  })

  server.handle(RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED, async (_ctx, enabled: boolean) => {
    const { setBrowserToolEnabled } = await import('@craft-agent/shared/config/storage')
    setBrowserToolEnabled(enabled)
  })

  // ============================================================
  // Network Proxy Settings
  // ============================================================

  // Get network proxy settings
  server.handle(RPC_CHANNELS.settings.GET_NETWORK_PROXY, async () => {
    const { getNetworkProxySettings } = await import('@craft-agent/shared/config/storage')
    return getNetworkProxySettings()
  })

  // ============================================================
  // Workspace Preference Prompts (全局提示词)
  // ============================================================

  // List all preference prompts for a workspace
  server.handle(RPC_CHANNELS.settings.PROMPTS_GET, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceOrThrow(workspaceId)
    const { loadWorkspacePrompts } = await import('@craft-agent/shared/workspaces')
    return loadWorkspacePrompts(workspace.rootPath)
  })

  // Upsert a preference prompt (manual or AI-generated)
  server.handle(RPC_CHANNELS.settings.PROMPTS_SAVE, async (_ctx, workspaceId: string, input: unknown): Promise<WorkspacePrompt> => {
    const workspace = getWorkspaceOrThrow(workspaceId)
    const { loadWorkspaceConfig, saveWorkspaceConfig, loadWorkspacePrompts, WORKSPACE_PROMPT_LIMITS } = await import('@craft-agent/shared/workspaces')
    const { randomUUID } = await import('node:crypto')

    if (!input || typeof input !== 'object') {
      throw new Error('Invalid prompt payload')
    }
    const raw = input as Record<string, unknown>
    const title = String(raw.title ?? '').trim()
    const content = String(raw.content ?? '').trim()
    if (!title) throw new Error('Prompt title is required')
    if (!content) throw new Error('Prompt content is required')
    if (title.length > WORKSPACE_PROMPT_LIMITS.titleMax) {
      throw new Error(`Prompt title must be at most ${WORKSPACE_PROMPT_LIMITS.titleMax} characters`)
    }
    if (content.length > WORKSPACE_PROMPT_LIMITS.contentMax) {
      throw new Error(`Prompt content must be at most ${WORKSPACE_PROMPT_LIMITS.contentMax} characters`)
    }

    const config = loadWorkspaceConfig(workspace.rootPath)
    if (!config) {
      throw new Error(`Failed to load workspace config: ${workspaceId}`)
    }
    const prompts = loadWorkspacePrompts(workspace.rootPath)
    const existingId = typeof raw.id === 'string' ? raw.id : null
    const existing = existingId ? prompts.find(p => p.id === existingId) : undefined

    if (!existing && prompts.length >= WORKSPACE_PROMPT_LIMITS.maxPrompts) {
      throw new Error(`At most ${WORKSPACE_PROMPT_LIMITS.maxPrompts} preference prompts per workspace`)
    }

    const now = Date.now()
    const prompt: WorkspacePrompt = {
      id: existing?.id ?? randomUUID(),
      title,
      content,
      enabled: existing
        ? (raw.enabled === undefined ? existing.enabled : Boolean(raw.enabled))
        : raw.enabled !== false,
      source: existing
        ? (raw.source === 'ai' ? 'ai' : existing.source)
        : (raw.source === 'ai' ? 'ai' : 'manual'),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }

    const next = prompts.filter(p => p.id !== prompt.id)
    next.push(prompt)
    config.prompts = next
    saveWorkspaceConfig(workspace.rootPath, config)
    deps.platform.logger.info(`Workspace preference prompt saved: ${prompt.title} (${workspaceId})`)
    return prompt
  })

  // Delete a preference prompt
  server.handle(RPC_CHANNELS.settings.PROMPTS_DELETE, async (_ctx, workspaceId: string, id: string) => {
    const workspace = getWorkspaceOrThrow(workspaceId)
    const { loadWorkspaceConfig, saveWorkspaceConfig, loadWorkspacePrompts } = await import('@craft-agent/shared/workspaces')
    const config = loadWorkspaceConfig(workspace.rootPath)
    if (!config) {
      throw new Error(`Failed to load workspace config: ${workspaceId}`)
    }
    const remaining = loadWorkspacePrompts(workspace.rootPath).filter(p => p.id !== id)
    config.prompts = remaining
    saveWorkspaceConfig(workspace.rootPath, config)
    deps.platform.logger.info(`Workspace preference prompt deleted: ${id} (${workspaceId})`)
    return { success: true }
  })

  // AI-generate a preference prompt from a description via a hidden one-shot session
  server.handle(RPC_CHANNELS.settings.PROMPTS_GENERATE, async (_ctx, workspaceId: string, description: string) => {
    const workspace = getWorkspaceOrThrow(workspaceId)
    const { WORKSPACE_PROMPT_LIMITS } = await import('@craft-agent/shared/workspaces')

    const desc = String(description ?? '').trim()
    if (!desc) throw new Error('A description is required to generate a preference prompt')
    if (desc.length > WORKSPACE_PROMPT_LIMITS.descriptionMax) {
      throw new Error(`Description must be at most ${WORKSPACE_PROMPT_LIMITS.descriptionMax} characters`)
    }

    // One-shot hidden session: the workspace's default model/connection answers
    // the generation request, then we parse the JSON result and delete the session.
    const session = await deps.sessionManager.createSession(
      workspaceId,
      { name: 'Generate workspace preference', hidden: true },
      { emitCreatedEvent: false },
    )

    try {
      const finalText = await new Promise<string>((resolve, reject) => {
        let settled = false
        const settle = (fn: () => void) => {
          if (settled) return
          settled = true
          fn()
        }
        const timeout = setTimeout(() => {
          settle(() => {
            unsubscribe()
            reject(new Error('Prompt generation timed out'))
          })
        }, 120_000)
        const unsubscribe = deps.sessionManager.onSessionComplete((evt) => {
          if (evt.sessionId !== session.id) return
          settle(() => {
            clearTimeout(timeout)
            unsubscribe()
            if (evt.reason === 'complete' && evt.finalText?.trim()) resolve(evt.finalText.trim())
            else reject(new Error(`Prompt generation failed (${evt.reason})`))
          })
        })
        void deps.sessionManager.sendMessage(session.id, buildWorkspacePromptGenerationPrompt(desc)).catch((err: unknown) => {
          settle(() => {
            clearTimeout(timeout)
            unsubscribe()
            reject(err instanceof Error ? err : new Error(String(err)))
          })
        })
      })

      const { title, content } = parseGeneratedWorkspacePrompt(finalText, WORKSPACE_PROMPT_LIMITS.titleMax, WORKSPACE_PROMPT_LIMITS.contentMax)
      return { title, content }
    } finally {
      // Best-effort cleanup of the hidden one-shot session
      await deps.sessionManager.archiveSession(session.id).catch(() => {})
      await deps.sessionManager.deleteSession(session.id).catch(() => {})
    }
  })

  // ============================================================
  // Data Migration — export all workspaces and settings
  // ============================================================

  // Ask the client for a save location, then export the entire app state
  // (global settings + every workspace) to a portable ZIP archive.
  server.handle(RPC_CHANNELS.settings.EXPORT_ALL_DATA, async (ctx) => {
    const stamp = new Date().toISOString().slice(0, 10)
    const dialogResult = await requestClientSaveFileDialog(server, ctx.clientId, {
      title: 'Export Craft Agent data',
      defaultPath: `craft-agent-backup-${stamp}.zip`,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    })
    if (dialogResult.canceled || !dialogResult.filePath) {
      return { canceled: true }
    }

    try {
      const { exportAllData } = await import('@craft-agent/shared/migration')
      const result = await exportAllData({ destPath: dialogResult.filePath })
      deps.platform.logger.info(
        `Data export complete: ${result.workspaceCount} workspace(s), ${result.fileCount} file(s) → ${result.destPath} (${result.bytes} bytes)`,
      )
      return {
        canceled: false,
        success: true,
        destPath: result.destPath,
        bytes: result.bytes,
        fileCount: result.fileCount,
        workspaceCount: result.workspaceCount,
        warnings: result.warnings,
      }
    } catch (error) {
      deps.platform.logger.error('Data export failed', error)
      return {
        canceled: false,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  // Ask the client for a backup archive, then restore all workspaces and
  // settings onto this machine (cross-platform path remapping included).
  server.handle(RPC_CHANNELS.settings.IMPORT_ALL_DATA, async (ctx) => {
    const dialogResult = await requestClientOpenFileDialog(server, ctx.clientId, {
      title: 'Import Craft Agent data',
      properties: ['openFile'],
      filters: [{ name: 'Craft Agent backup', extensions: ['zip'] }],
    })
    if (dialogResult.canceled || !dialogResult.filePaths[0]) {
      return { canceled: true }
    }

    try {
      const { importAllData } = await import('@craft-agent/shared/migration')
      const result = await importAllData({ sourcePath: dialogResult.filePaths[0] })
      deps.platform.logger.info(
        `Data import complete: ${result.importedWorkspaces.length} workspace(s), ${result.fileCount} file(s)`,
      )
      return {
        canceled: false,
        success: true,
        fileCount: result.fileCount,
        importedWorkspaces: result.importedWorkspaces,
        warnings: result.warnings,
      }
    } catch (error) {
      deps.platform.logger.error('Data import failed', error)
      return {
        canceled: false,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })
}
