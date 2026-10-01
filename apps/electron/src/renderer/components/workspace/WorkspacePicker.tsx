/**
 * WorkspacePicker — shown when a window opens without a workspace ID.
 * Lists the active server's workspaces and allows selection or creation.
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { Spinner } from '@craft-agent/ui'
import { ServerSwitcher } from '../app-shell/ServerSwitcher'
import type { WorkspaceInfo } from '../../../shared/types'
import {
  AddWorkspaceContainer,
  AddWorkspaceStepHeader,
  AddWorkspacePrimaryButton,
} from './primitives'

interface WorkspacePickerProps {
  onSelectWorkspace: (workspaceId: string) => void | Promise<void>
}

export function WorkspacePicker({ onSelectWorkspace }: WorkspacePickerProps) {
  const { t } = useTranslation()
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)

  const errorMessage = useCallback(async (err: unknown) => {
    const code = (err as { code?: string } | null)?.code
    const state = await window.electronAPI.getTransportConnectionState().catch(() => null)
    // Electron's context bridge may omit custom Error properties. Connection
    // state carries the safe category independently of the rejected promise.
    const kind = state?.status !== 'connected' ? state?.lastError?.kind : undefined
    const url = state?.url ?? ''
    if (code === 'PROTOCOL' || code === 'UNSUPPORTED' || kind === 'protocol') return t('transport.protocolMismatch')
    if (code === 'AUTH' || kind === 'auth') return t('transport.authFailed')
    if (code === 'NETWORK' || kind === 'network') return t('transport.networkError', { url })
    if (code === 'TIMEOUT' || kind === 'timeout') return t('transport.timeout', { url })
    return err instanceof Error ? err.message : t('transport.failed')
  }, [t])

  // Load workspaces from server
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    // Retry discovery only. Workspace creation is never replayed automatically.
    const load = async () => {
      if (loadAttempt > 0) await window.electronAPI.reconnectTransport()
      if (!alive) return
      return window.electronAPI.getServerWorkspaces()
    }
    load()
      .then((ws) => {
        if (!alive || !ws) return
        setWorkspaces(ws)
        setLoaded(true)
        setLoading(false)
      })
      .catch(async err => {
        const message = await errorMessage(err)
        if (!alive) return
        setError(message)
        setLoading(false)
      })
    return () => { alive = false }
  }, [loadAttempt, errorMessage])

  const handleCreate = useCallback(async () => {
    if (!loaded || creating || !newName.trim()) return
    setCreating(true)
    setError(null)
    try {
      const ws = await window.electronAPI.createServerWorkspace(newName.trim())
      // If switching fails, let the user select the workspace already created.
      setWorkspaces(previous => previous.some(row => row.id === ws.id) ? previous : [...previous, ws])
      await onSelectWorkspace(ws.id)
    } catch (err) {
      setError(await errorMessage(err))
      setCreating(false)
    }
  }, [loaded, creating, newName, onSelectWorkspace, errorMessage])

  const handleSelect = useCallback(async (id: string) => {
    if (creating) return
    setCreating(true)
    setError(null)
    try { await onSelectWorkspace(id) }
    catch (err) { setError(await errorMessage(err)); setCreating(false) }
  }, [creating, onSelectWorkspace, errorMessage])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-sidebar px-4">
        <AddWorkspaceContainer>
          <Spinner className="h-6 w-6" />
          <p className="mt-3 text-sm text-muted-foreground">{t("workspace.loadingWorkspaces")}</p>
        </AddWorkspaceContainer>
      </div>
    )
  }

  return (
    <div className="flex h-screen items-center justify-center bg-sidebar px-4">
      <AddWorkspaceContainer>
        {window.electronAPI.getRuntimeEnvironment() === 'electron' && (
          <div className="mb-4"><ServerSwitcher /></div>
        )}
        <AddWorkspaceStepHeader
          title={!loaded ? t('transport.failed') : workspaces.length === 0
            ? t("workspace.firstWorkspaceTitle")
            : t("workspace.selectWorkspace")}
          description={!loaded ? undefined : workspaces.length === 0
            ? t("workspace.firstWorkspaceDesc")
            : t("workspace.selectWorkspaceDesc")}
        />

        {error && (
          <p className="mt-3 w-full text-center text-sm text-destructive">{error}</p>
        )}

        {!loaded && (
          <AddWorkspacePrimaryButton className="mt-5" onClick={() => setLoadAttempt(attempt => attempt + 1)}>
            {t('common.retry')}
          </AddWorkspacePrimaryButton>
        )}

        {/* Workspace list */}
        {workspaces.length > 0 && (
          <div className="mt-5 w-full space-y-1.5">
            {workspaces.map(ws => (
              <button
                key={ws.id}
                onClick={() => void handleSelect(ws.id)}
                disabled={creating}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-foreground/5"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent text-xs font-semibold uppercase">
                  {ws.name.charAt(0)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{ws.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{ws.slug}</div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Divider */}
        {loaded && <div className="mt-5 mb-4 w-full border-t" />}

        {/* Create new */}
        {loaded && <div className="w-full space-y-2">
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            placeholder={t("workspace.newWorkspaceName")}
            autoFocus={workspaces.length === 0}
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <AddWorkspacePrimaryButton
            onClick={handleCreate}
            disabled={!newName.trim()}
            loading={creating}
            loadingText={t("workspace.creating")}
            className="bg-accent hover:bg-accent/90 text-white"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t("workspace.createWorkspace")}
          </AddWorkspacePrimaryButton>
        </div>}
      </AddWorkspaceContainer>
    </div>
  )
}
