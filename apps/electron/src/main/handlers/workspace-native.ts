import type { RemoteServerConfig } from '@craft-agent/core/types'
import { advanceNativeWindowBinding, type NativeAuthorityEvent } from '../native-window-authority'

export const NATIVE_SWITCH_WORKSPACE = '__workspace:switch'

/** Network clients can change only their own WS routing, never a native window. */
export function registerNativeWorkspaceSwitch(ipc: {
  handle(channel: string, listener: (event: any, workspaceId: unknown) => Promise<unknown>): void
}, deps: {
  assertSender(event: NativeAuthorityEvent): { workspaceId: string; bindingId: string }
  getWorkspace(id: string): { id: string; rootPath?: string; remoteServer?: RemoteServerConfig } | null | undefined | Promise<{ id: string; rootPath?: string; remoteServer?: RemoteServerConfig } | null | undefined>
  updateWindowWorkspace(id: number, workspaceId: string): boolean
  getAllWindowsForWorkspace(id: string): unknown[]
  clearActiveViewingSession(id: string): void
  setupConfigWatcher(rootPath: string, workspaceId: string): void
}): void {
  ipc.handle(NATIVE_SWITCH_WORKSPACE, async (event: NativeAuthorityEvent, input: unknown) => {
    const current = deps.assertSender(event)
    if (typeof input !== 'string' || !input || input.length > 256) throw new Error('Invalid workspace')
    const workspace = await deps.getWorkspace(input)
    if (!workspace || workspace.id !== input) throw new Error('Workspace not found')
    // Navigation or another switch while async discovery ran invalidates this
    // operation; it must not bind a replacement window to an obsolete target.
    const latest = deps.assertSender(event)
    if (latest.bindingId !== current.bindingId) throw new Error('Application workspace changed. Retry.')
    if (!deps.updateWindowWorkspace(event.sender.id, workspace.id)) throw new Error('Application window is no longer registered')
    advanceNativeWindowBinding(event.sender)
    if (current.workspaceId && current.workspaceId !== workspace.id && deps.getAllWindowsForWorkspace(current.workspaceId).length === 0) {
      deps.clearActiveViewingSession(current.workspaceId)
    }
    if (workspace.rootPath) deps.setupConfigWatcher(workspace.rootPath, workspace.id)
    // Legacy remote transport is consumed inside isolated preload only. Native
    // secret-reference resolution replaces this field during vault migration.
    return { workspaceId: workspace.id, remoteServer: workspace.remoteServer ?? null }
  })
}
