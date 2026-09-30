import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeft, CheckCircle, XCircle, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { slugify } from "@/lib/slugify"
import { Input } from "../ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { AddWorkspaceContainer, AddWorkspaceStepHeader, AddWorkspacePrimaryButton, AddWorkspaceSecondaryButton } from "./primitives"

// Match the backend's endpoint identity check. Never retain a saved credential
// when the scheme, authority, path or query changes.
function isSameRemoteEndpoint(current: string, original?: string): boolean {
  try {
    const url = new URL(current)
    return !!original && ['ws:', 'wss:'].includes(url.protocol)
      && !url.username && !url.password && !url.hash
      && url.href === new URL(original).href
  } catch { return false }
}

const CREATE_NEW_VALUE = '__create_new__'

interface AddWorkspaceStep_ConnectRemoteProps {
  onBack: () => void
  onCreate: (folderPath: string, name: string, remoteServer: { url: string; token: string; remoteWorkspaceId: string }) => Promise<void>
  isCreating: boolean
  /** Pre-fill the server URL (for reconnect flow) */
  initialUrl?: string
  /** Optional newly entered token; saved tokens are intentionally redacted. */
  initialToken?: string
  /** When set, updating an existing workspace's remote config instead of creating */
  reconnectWorkspace?: { id: string; name: string; remoteWorkspaceId: string }
  /** Called when reconnect updates the remote server config */
  onUpdate?: (workspaceId: string, remoteServer: { url: string; token: string; remoteWorkspaceId: string }) => Promise<void>
}

/**
 * Resolve a unique local workspace slug by appending suffixes if needed.
 * Tries: baseName → baseName-remote → baseName-2 → baseName-3 → ...
 */
async function resolveUniqueSlug(baseName: string): Promise<{ slug: string; path: string }> {
  const baseSlug = slugify(baseName)
  if (!baseSlug) return { slug: 'remote', path: '' }

  let slug = baseSlug
  let attempt = 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await window.electronAPI.checkWorkspaceSlug(slug)
    if (!result.exists) {
      return { slug, path: result.path }
    }
    attempt++
    slug = attempt === 1 ? `${baseSlug}-remote` : `${baseSlug}-${attempt}`
    if (attempt > 20) {
      // Safety valve — shouldn't happen in practice
      return { slug: `${baseSlug}-${Date.now()}`, path: result.path.replace(baseSlug, `${baseSlug}-${Date.now()}`) }
    }
  }
}

/**
 * AddWorkspaceStep_ConnectRemote - Connect to a remote TokenBird Server
 *
 * Two paths:
 * 1. Connect to existing workspace — select from dropdown, no name needed, auto-resolve local slug
 * 2. Create new workspace — type a name, creates on server, then connects
 */
export function AddWorkspaceStep_ConnectRemote({
  onBack,
  onCreate,
  isCreating,
  initialUrl,
  initialToken,
  reconnectWorkspace,
  onUpdate,
}: AddWorkspaceStep_ConnectRemoteProps) {
  const { t } = useTranslation()
  const isReconnectMode = !!reconnectWorkspace
  const [serverUrl, setServerUrl] = useState(initialUrl ?? '')
  const [token, setToken] = useState(initialToken ?? '')
  const [homeDir, setHomeDir] = useState('')
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [testError, setTestError] = useState<string | null>(null)
  const [remoteWorkspaces, setRemoteWorkspaces] = useState<Array<{ id: string; name: string }>>([])
  const [selectedValue, setSelectedValue] = useState<string | null>(null) // workspace ID or CREATE_NEW_VALUE
  const [newWorkspaceName, setNewWorkspaceName] = useState('')
  const [serverVersion, setServerVersion] = useState<string | null>(null)
  const selectPortalRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const generation = useRef(0)
  const pendingTest = useRef<number | null>(null)
  const pendingSave = useRef<number | null>(null)
  const [saving, setSaving] = useState(false)
  const busy = isCreating || saving

  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current++ }
  }, [])

  useEffect(() => {
    let active = true
    void window.electronAPI.getHomeDir().then(value => { if (active) setHomeDir(value) }).catch(() => {})
    return () => { active = false }
  }, [])

  const resetTest = useCallback(() => {
    generation.current++
    pendingTest.current = null
    setTestState('idle')
    setTestError(null)
    setServerVersion(null)
    setRemoteWorkspaces([])
    setSelectedValue(null)
    setNewWorkspaceName('')
  }, [])

  // A reused dialog must not retain either a token or a result from another
  // workspace. Layout cleanup also invalidates pending asynchronous callbacks.
  useLayoutEffect(() => {
    resetTest()
    pendingSave.current = null
    setSaving(false)
    setServerUrl(initialUrl ?? '')
    setToken(initialToken ?? '')
    return () => { generation.current++ }
  }, [initialUrl, initialToken, reconnectWorkspace?.id, reconnectWorkspace?.remoteWorkspaceId, resetTest])

  const isCreateNew = selectedValue === CREATE_NEW_VALUE
  const selectedWorkspace = !isCreateNew ? remoteWorkspaces.find(w => w.id === selectedValue) : null
  const isFreshServer = testState === 'ok' && remoteWorkspaces.length === 0
  const canUseSavedToken = isReconnectMode && !token && isSameRemoteEndpoint(serverUrl, initialUrl)
  const canConnect = !busy && (isReconnectMode
    ? !!onUpdate && (canUseSavedToken || (!!token && testState === 'ok'))
    : !!token && testState === 'ok' && !!homeDir
      && ((isFreshServer || isCreateNew) ? !!newWorkspaceName.trim() : !!selectedWorkspace))

  const handleTestConnection = useCallback(async () => {
    if (!serverUrl || !token || busy || pendingTest.current !== null || pendingSave.current !== null) return
    const own = ++generation.current
    pendingTest.current = own
    const current = () => mounted.current && generation.current === own
    setTestState('testing')
    setTestError(null)
    setServerVersion(null)
    try {
      const result = await window.electronAPI.testRemoteConnection(serverUrl, token)
      if (!current()) return
      if (result.ok) {
        setTestState('ok')
        setServerVersion(result.serverVersion ?? null)
        const workspaces = result.needsWorkspace ? [] : result.remoteWorkspaces ?? []
        setRemoteWorkspaces(workspaces)
        setSelectedValue(workspaces.length === 1 ? workspaces[0]!.id : null)
      } else {
        setTestState('error')
        setTestError(t('workspace.remoteConnectionFailed'))
      }
    } catch {
      if (current()) {
        setTestState('error')
        setTestError(t('workspace.remoteConnectionFailed'))
      }
    } finally {
      if (pendingTest.current === own) pendingTest.current = null
    }
  }, [serverUrl, token, busy, t])

  const handleConnect = useCallback(async () => {
    if (!canConnect || pendingSave.current !== null || pendingTest.current !== null) return
    const own = ++generation.current
    pendingSave.current = own
    const current = () => mounted.current && generation.current === own
    setSaving(true)
    setTestError(null)
    try {
      if (reconnectWorkspace && onUpdate) {
        // Blank is write-only "keep existing", verified again by the backend.
        // Do not manufacture a successful connection test for this path.
        await onUpdate(reconnectWorkspace.id, {
          url: serverUrl, token, remoteWorkspaceId: reconnectWorkspace.remoteWorkspaceId,
        })
      } else {
        const defaultBasePath = `${homeDir}/.tokenbird/workspaces`
        if (isCreateNew || isFreshServer) {
          const name = newWorkspaceName.trim()
          const created = await window.electronAPI.invokeOnServer(
            serverUrl, token, 'server:createWorkspace', name
          ) as { id: string; name: string }
          if (!current()) return
          const { slug, path } = await resolveUniqueSlug(name)
          if (!current()) return
          await onCreate(path || `${defaultBasePath}/${slug}`, name, { url: serverUrl, token, remoteWorkspaceId: created.id })
        } else if (selectedWorkspace) {
          const { slug, path } = await resolveUniqueSlug(selectedWorkspace.name)
          if (!current()) return
          await onCreate(path || `${defaultBasePath}/${slug}`, selectedWorkspace.name, { url: serverUrl, token, remoteWorkspaceId: selectedWorkspace.id })
        }
      }
      if (current()) { setToken(''); resetTest() }
    } catch {
      if (current()) {
        setTestState('error')
        setTestError(t(isReconnectMode ? 'workspace.remoteReconnectFailed' : 'workspace.remoteCreateFailed'))
      }
    } finally {
      if (pendingSave.current === own) {
        pendingSave.current = null
        if (mounted.current) setSaving(false)
      }
    }
  }, [canConnect, serverUrl, token, homeDir, isCreateNew, isFreshServer, newWorkspaceName, selectedWorkspace, onCreate, isReconnectMode, onUpdate, reconnectWorkspace, resetTest, t])

  const showCreateMode = !isReconnectMode && (isCreateNew || isFreshServer)
  const buttonLabel = isReconnectMode ? t(canUseSavedToken ? 'workspace.reconnectSavedToken' : 'workspace.reconnectAction') : showCreateMode ? 'Create and Connect' : 'Connect'
  const buttonLoadingLabel = isReconnectMode ? 'Reconnecting...' : showCreateMode ? 'Creating...' : 'Connecting...'

  return (
    <AddWorkspaceContainer>
      {/* Back button */}
      <button
        onClick={() => { resetTest(); setToken(''); onBack() }}
        disabled={busy}
        className={cn(
          "self-start flex items-center gap-1 text-sm text-muted-foreground",
          "hover:text-foreground transition-colors mb-4",
          busy && "opacity-50 cursor-not-allowed"
        )}
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </button>

      <AddWorkspaceStepHeader
        title={isReconnectMode ? t("workspace.reconnect", { name: reconnectWorkspace!.name }) : "Connect to remote server"}
        description={isReconnectMode
          ? t("workspace.reconnectDescription")
          : "Connect to a remote TokenBird Server for this workspace."}
      />

      <div className="mt-6 w-full space-y-5">
        {/* Server URL */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Server URL
          </label>
          <div className="bg-background shadow-minimal rounded-lg">
            <Input
              value={serverUrl}
              onChange={(e) => { resetTest(); setServerUrl(e.target.value) }}
              aria-label="Server URL"
              placeholder="ws://192.168.1.100:9100"
              disabled={busy}
              autoFocus
              className="border-0 bg-transparent shadow-none font-mono text-sm"
            />
          </div>
        </div>

        {/* Token */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Token
          </label>
          <div className="bg-background shadow-minimal rounded-lg">
            <Input
              type="password"
              value={token}
              onChange={(e) => { resetTest(); setToken(e.target.value) }}
              aria-label={t("workspace.serverAuthToken")}
              autoComplete="off"
              placeholder={t("workspace.serverAuthToken")}
              disabled={busy}
              className="border-0 bg-transparent shadow-none"
            />
          </div>
        </div>

        {isReconnectMode && !token && (
          <p className="text-xs text-muted-foreground" role="status">
            {t(canUseSavedToken ? 'workspace.savedTokenReconnectHint' : 'workspace.changedEndpointTokenRequired')}
          </p>
        )}

        {/* Test Connection */}
        <div className="flex items-center gap-3">
          <AddWorkspaceSecondaryButton
            onClick={handleTestConnection}
            disabled={!serverUrl || !token || testState === 'testing' || busy}
          >
            {testState === 'testing' ? 'Testing...' : 'Test Connection'}
          </AddWorkspaceSecondaryButton>
          {testState === 'ok' && !isFreshServer && (
            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <CheckCircle className="h-3.5 w-3.5" />
              Connected{serverVersion ? ` — v${serverVersion}` : ''}
            </span>
          )}
          {testState === 'ok' && isFreshServer && (
            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <CheckCircle className="h-3.5 w-3.5" />
              Connected{serverVersion ? ` — v${serverVersion}` : ''} — no workspaces yet
            </span>
          )}
          {testState === 'error' && (
            <span role="alert" className="flex items-center gap-1 text-xs text-destructive">
              <XCircle className="h-3.5 w-3.5" />
              {testError || 'Failed'}
            </span>
          )}
        </div>

        {/* Old server warning */}
        {testState === 'ok' && !serverVersion && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-xs text-yellow-700 dark:text-yellow-400">
            <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{t("workspace.olderServerWarning")}</span>
          </div>
        )}

        {/* Portal container for Select — must be inside the Dialog to receive pointer events */}
        <div ref={selectPortalRef} />

        {/* Workspace selector — pick existing or create new (hidden in reconnect mode) */}
        {!isReconnectMode && testState === 'ok' && remoteWorkspaces.length > 0 && !isCreateNew && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Workspace
            </label>
            <div className="bg-background shadow-minimal rounded-lg">
              <Select
                value={selectedValue ?? ''}
                onValueChange={setSelectedValue}
                disabled={busy}
              >
                <SelectTrigger className="border-0 bg-transparent shadow-none">
                  <SelectValue placeholder={t("workspace.selectWorkspacePlaceholder")} />
                </SelectTrigger>
                <SelectContent container={selectPortalRef.current}>
                  {remoteWorkspaces.map(ws => (
                    <SelectItem key={ws.id} value={ws.id}>
                      {ws.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <button
              type="button"
              onClick={() => setSelectedValue(CREATE_NEW_VALUE)}
              disabled={busy}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Plus className="h-3 w-3" />
              Create new workspace on server
            </button>
          </div>
        )}

        {/* New workspace name — shown for fresh servers or "Create new" selection (hidden in reconnect mode) */}
        {!isReconnectMode && testState === 'ok' && showCreateMode && (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Workspace name
            </label>
            <div className="bg-background shadow-minimal rounded-lg">
              <Input
                value={newWorkspaceName}
                onChange={(e) => setNewWorkspaceName(e.target.value)}
                placeholder={t("workspace.myRemoteWorkspace")}
                disabled={busy}
                className="border-0 bg-transparent shadow-none"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              A workspace will be created on the remote server with this name.
            </p>
            {isCreateNew && remoteWorkspaces.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setSelectedValue(remoteWorkspaces.length === 1 ? remoteWorkspaces[0]!.id : null)
                  setNewWorkspaceName('')
                }}
                disabled={busy}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-3 w-3" />
                Use existing workspace
              </button>
            )}
          </div>
        )}

        {/* Connect / Create and Connect */}
        <AddWorkspacePrimaryButton
          onClick={handleConnect}
          disabled={!canConnect}
          loading={busy}
          loadingText={buttonLoadingLabel}
        >
          {buttonLabel}
        </AddWorkspacePrimaryButton>
      </div>
    </AddWorkspaceContainer>
  )
}
