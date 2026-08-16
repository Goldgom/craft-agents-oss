/**
 * Resources RPC Handlers
 *
 * Handles workspace resource export/import (sources, skills, automations).
 */

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { getCredentialManager, SOURCE_CREDENTIAL_TYPES } from '@craft-agent/shared/credentials'
import { RESOURCE_BUNDLE_FILE_EXTENSION } from '@craft-agent/shared/resources'
import {
  requestClientOpenFileDialog,
  requestClientSaveFileDialog,
} from '@craft-agent/server-core/transport'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type {
  ResourceBundle,
  ResourceImportMode,
  ExportResourcesOptions,
  ResourceImportResult,
} from '@craft-agent/shared/resources'

type WorkspaceInfo = NonNullable<ReturnType<typeof getWorkspaceByNameOrId>>

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.resources.EXPORT,
  RPC_CHANNELS.resources.IMPORT,
  RPC_CHANNELS.resources.EXPORT_TO_FILE,
  RPC_CHANNELS.resources.IMPORT_FROM_FILE,
] as const

export function registerResourcesHandlers(server: RpcServer, deps: HandlerDeps): void {
  // Export workspace resources to a portable bundle
  server.handle(
    RPC_CHANNELS.resources.EXPORT,
    async (_ctx, workspaceId: string, options: ExportResourcesOptions) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

      const { exportResources } = await import('@craft-agent/shared/resources')
      const result = exportResources(workspace.rootPath, options)

      deps.platform.logger?.info(
        `RESOURCES_EXPORT: Exported from ${workspaceId}: ` +
        `${result.bundle.resources.sources?.length ?? 0} sources, ` +
        `${result.bundle.resources.skills?.length ?? 0} skills, ` +
        `${result.bundle.resources.automations?.length ?? 0} automations` +
        (result.warnings.length > 0 ? ` (${result.warnings.length} warnings)` : ''),
      )

      return result
    },
  )

  // Import a resource bundle into a workspace
  server.handle(
    RPC_CHANNELS.resources.IMPORT,
    async (_ctx, workspaceId: string, bundle: ResourceBundle, mode: ResourceImportMode) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
      return applyResourceImport(deps, workspace, bundle, mode)
    },
  )

  // Export workspace resources to a portable archive file (打包存档).
  // When filePath is omitted, a native save dialog is shown to the calling
  // client. Returns { filePath, counts, warnings }.
  server.handle(
    RPC_CHANNELS.resources.EXPORT_TO_FILE,
    async (ctx, workspaceId: string, options: ExportResourcesOptions, filePath?: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

      let targetPath = filePath ?? ''
      if (!targetPath) {
        const dialog = await requestClientSaveFileDialog(server, ctx.clientId, {
          title: 'Export Craft resources',
          defaultPath: `${workspace.name.replace(/[\/\\:*?"<>|]/g, '-')}${RESOURCE_BUNDLE_FILE_EXTENSION}`,
          filters: [{ name: 'Craft resource bundle', extensions: ['json'] }],
        })
        if (dialog.canceled || !dialog.filePath) {
          return { canceled: true }
        }
        targetPath = dialog.filePath
      }

      const { exportResources, writeResourceBundleFile } = await import('@craft-agent/shared/resources')
      const { bundle, warnings } = exportResources(workspace.rootPath, options)
      writeResourceBundleFile(targetPath, bundle)

      const counts = {
        sources: bundle.resources.sources?.length ?? 0,
        skills: bundle.resources.skills?.length ?? 0,
        automations: bundle.resources.automations?.length ?? 0,
      }

      deps.platform.logger?.info(
        `RESOURCES_EXPORT_FILE: Exported ${workspaceId} → ${targetPath}: ` +
        `${counts.sources} sources, ${counts.skills} skills, ${counts.automations} automations` +
        (warnings.length > 0 ? ` (${warnings.length} warnings)` : ''),
      )

      return { filePath: targetPath, counts, warnings }
    },
  )

  // Import a portable archive file into a workspace (一键导入).
  // When filePath is omitted, a native open dialog is shown to the calling
  // client. Returns the standard ResourceImportResult.
  server.handle(
    RPC_CHANNELS.resources.IMPORT_FROM_FILE,
    async (ctx, workspaceId: string, filePath?: string, mode?: ResourceImportMode) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

      let sourcePath = filePath ?? ''
      if (!sourcePath) {
        const dialog = await requestClientOpenFileDialog(server, ctx.clientId, {
          title: 'Import Craft resources',
          properties: ['openFile'],
          filters: [{ name: 'Craft resource bundle', extensions: ['json'] }],
        })
        if (dialog.canceled || dialog.filePaths.length === 0) {
          return { canceled: true }
        }
        sourcePath = dialog.filePaths[0]!
      }

      const { readResourceBundleFile } = await import('@craft-agent/shared/resources')
      const bundle = readResourceBundleFile(sourcePath)
      return applyResourceImport(deps, workspace, bundle, mode ?? 'skip')
    },
  )
}

/** Shared import pipeline for in-memory and file-based bundles. */
async function applyResourceImport(
  deps: HandlerDeps,
  workspace: WorkspaceInfo,
  bundle: ResourceBundle,
  mode: ResourceImportMode,
): Promise<ResourceImportResult> {
  const { importResources } = await import('@craft-agent/shared/resources')
  const credManager = getCredentialManager()

  const result = await importResources(workspace.rootPath, bundle, mode, {
    // Clear all credential types for a source slug on overwrite
    clearSourceCredentials: async (wsId: string, sourceSlug: string) => {
      for (const credType of SOURCE_CREDENTIAL_TYPES) {
        try {
          await credManager.delete({
            type: credType,
            workspaceId: wsId,
            sourceId: sourceSlug,
          })
        } catch {
          // Ignore errors for credential types that don't exist
        }
      }
    },
  })

  deps.platform.logger?.info(
    `RESOURCES_IMPORT: Imported into ${workspace.id} (mode=${mode}): ` +
    `sources=${result.sources.imported.length} imported, ${result.sources.skipped.length} skipped, ${result.sources.failed.length} failed; ` +
    `skills=${result.skills.imported.length} imported, ${result.skills.skipped.length} skipped, ${result.skills.failed.length} failed; ` +
    `automations=${result.automations.imported.length} imported, ${result.automations.skipped.length} skipped, ${result.automations.failed.length} failed`,
  )

  // Notify ConfigWatcher of imported files so UI refreshes on Linux
  // (Bun's fs.watch doesn't reliably detect atomic renames)
  if (result.automations.imported.length > 0 || result.automations.skipped.length === 0 && bundle.resources.automations?.length) {
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, 'automations.json')
  }
  for (const slug of result.sources.imported) {
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `sources/${slug}/config.json`)
  }
  for (const slug of result.skills.imported) {
    deps.sessionManager.notifyConfigFileChange(workspace.rootPath, `skills/${slug}/SKILL.md`)
  }

  return result
}
