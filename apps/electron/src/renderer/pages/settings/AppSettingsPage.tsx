/**
 * AppSettingsPage
 *
 * Global app-level settings that apply across all workspaces.
 *
 * Settings:
 * - Notifications
 * - Network (proxy)
 * - About (version, updates)
 *
 * Note: AI settings (connections, model, thinking) have been moved to AiSettingsPage.
 * Note: Appearance settings (theme, font) have been moved to AppearanceSettingsPage.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Upload, HardDrive, Cloud } from 'lucide-react'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { routes } from '@/lib/navigate'
import { Spinner } from '@craft-agent/ui'
import { useAppShellContext } from '@/context/AppShellContext'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { NetworkProxySettings, ImportAllDataResponse } from '../../../shared/types'

import {
  SettingsSection,
  SettingsCard,
  SettingsCardFooter,
  SettingsRow,
  SettingsToggle,
  SettingsInput,
} from '@/components/settings'
import { useUpdateChecker } from '@/hooks/useUpdateChecker'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'app',
}

// ============================================
// Proxy form helpers
// ============================================

interface ProxyFormState {
  enabled: boolean
  httpProxy: string
  httpsProxy: string
  noProxy: string
}

const EMPTY_PROXY_FORM: ProxyFormState = {
  enabled: false,
  httpProxy: '',
  httpsProxy: '',
  noProxy: '',
}

function toProxyFormState(settings?: NetworkProxySettings): ProxyFormState {
  if (!settings) return EMPTY_PROXY_FORM
  return {
    enabled: settings.enabled,
    httpProxy: settings.httpProxy ?? '',
    httpsProxy: settings.httpsProxy ?? '',
    noProxy: settings.noProxy ?? '',
  }
}

function toNetworkProxySettings(form: ProxyFormState): NetworkProxySettings {
  return {
    enabled: form.enabled,
    httpProxy: form.httpProxy.trim() || undefined,
    httpsProxy: form.httpsProxy.trim() || undefined,
    noProxy: form.noProxy.trim() || undefined,
  }
}

function validateProxyUrl(url: string): string | undefined {
  if (!url.trim()) return undefined
  try {
    const parsed = new URL(url.trim())
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol)) {
      return 'proxyErrorProtocol'
    }
    return undefined
  } catch {
    return 'proxyErrorFormat'
  }
}

/** Human-readable byte size for the export toast. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

// ============================================
// Main Component
// ============================================

export default function AppSettingsPage() {
  const { t } = useTranslation()
  const appShellContext = useAppShellContext()

  // Notifications state
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)

  // Power state
  const [keepAwakeEnabled, setKeepAwakeEnabled] = useState(false)

  // Tools state
  const [browserToolEnabled, setBrowserToolEnabled] = useState(true)
  const [requireSourceGuide, setRequireSourceGuide] = useState(true)

  // Proxy state
  const [proxyForm, setProxyForm] = useState<ProxyFormState>(EMPTY_PROXY_FORM)
  const [savedProxyForm, setSavedProxyForm] = useState<ProxyFormState>(EMPTY_PROXY_FORM)
  const [proxyError, setProxyError] = useState<string | undefined>()
  const [isSavingProxy, setIsSavingProxy] = useState(false)

  // Auto-update state (Check Now / Update Ready only shown in Electron, not WebUI)
  const isElectron = window.electronAPI.getRuntimeEnvironment() === 'electron'
  const updateChecker = useUpdateChecker()
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false)
  const [clientVersion, setClientVersion] = useState<string | null>(null)
  const [serverVersion, setServerVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.electronAPI.getClientVersion()
      .then((version) => { if (!cancelled) setClientVersion(version) })
      .catch(() => { if (!cancelled) setClientVersion(null) })
    void window.electronAPI.getRuntimeServerStatus()
      .then((status) => { if (!cancelled) setServerVersion(status.version) })
      .catch(() => { if (!cancelled) setServerVersion(null) })
    return () => { cancelled = true }
  }, [])

  const handleCheckForUpdates = useCallback(async () => {
    setIsCheckingForUpdates(true)
    try {
      await updateChecker.checkForUpdates()
    } finally {
      setIsCheckingForUpdates(false)
    }
  }, [updateChecker])

  // Load settings on mount
  const loadSettings = useCallback(async () => {
    if (!window.electronAPI) return
    try {
      const [notificationsOn, keepAwakeOn, browserToolOn, requireGuideOn, proxySettings] = await Promise.all([
        window.electronAPI.getNotificationsEnabled(),
        window.electronAPI.getKeepAwakeWhileRunning(),
        window.electronAPI.getBrowserToolEnabled(),
        window.electronAPI.getRequireSourceGuide(),
        window.electronAPI.getNetworkProxySettings(),
      ])
      setNotificationsEnabled(notificationsOn)
      setKeepAwakeEnabled(keepAwakeOn)
      setBrowserToolEnabled(browserToolOn)
      setRequireSourceGuide(requireGuideOn)
      const form = toProxyFormState(proxySettings)
      setProxyForm(form)
      setSavedProxyForm(form)
    } catch (error) {
      console.error('Failed to load settings:', error)
    }
  }, [])

  useEffect(() => {
    loadSettings()
  }, [])

  const handleNotificationsEnabledChange = useCallback(async (enabled: boolean) => {
    setNotificationsEnabled(enabled)
    await window.electronAPI.setNotificationsEnabled(enabled)
  }, [])

  const handleKeepAwakeEnabledChange = useCallback(async (enabled: boolean) => {
    setKeepAwakeEnabled(enabled)
    await window.electronAPI.setKeepAwakeWhileRunning(enabled)
  }, [])

  const handleBrowserToolEnabledChange = useCallback(async (enabled: boolean) => {
    setBrowserToolEnabled(enabled)
    await window.electronAPI.setBrowserToolEnabled(enabled)
  }, [])

  const handleRequireSourceGuideChange = useCallback(async (enabled: boolean) => {
    setRequireSourceGuide(enabled)
    await window.electronAPI.setRequireSourceGuide(enabled)
  }, [])

  // Proxy handlers
  const isProxyDirty = useMemo(() => {
    return JSON.stringify(proxyForm) !== JSON.stringify(savedProxyForm)
  }, [proxyForm, savedProxyForm])

  const handleSaveProxy = useCallback(async () => {
    // Validate URLs
    const httpErr = validateProxyUrl(proxyForm.httpProxy)
    const httpsErr = validateProxyUrl(proxyForm.httpsProxy)
    if (httpErr || httpsErr) {
      setProxyError(httpErr || httpsErr)
      return
    }
    setProxyError(undefined)
    setIsSavingProxy(true)
    try {
      const settings = toNetworkProxySettings(proxyForm)
      await window.electronAPI.setNetworkProxySettings(settings)
      // Re-read persisted state to confirm
      const persisted = await window.electronAPI.getNetworkProxySettings()
      const form = toProxyFormState(persisted)
      setProxyForm(form)
      setSavedProxyForm(form)
    } catch (error) {
      setProxyError(error instanceof Error ? error.message : 'Failed to save')
    } finally {
      setIsSavingProxy(false)
    }
  }, [proxyForm])

  const handleResetProxy = useCallback(() => {
    setProxyForm(savedProxyForm)
    setProxyError(undefined)
  }, [savedProxyForm])

  // Data migration export/import
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)

  const handleExportAllData = useCallback(async () => {
    setExporting(true)
    try {
      const res = await window.electronAPI.exportAllData()
      if (res.canceled) return
      if (res.success) {
        toast.success(
          t('settings.data.exportSuccess', {
            path: res.destPath,
            size: formatBytes(res.bytes ?? 0),
            workspaces: res.workspaceCount ?? 0,
          }),
        )
      } else {
        toast.error(res.error ?? t('settings.data.exportError'))
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.data.exportError'))
    } finally {
      setExporting(false)
    }
  }, [t])

  const handleImportAllData = useCallback(async (operation: () => Promise<ImportAllDataResponse>) => {
    setImporting(true)
    try {
      const res = await operation()
      if (res.canceled) return
      if (res.success) {
        toast.success(
          t('settings.data.importSuccess', {
            workspaces: res.importedWorkspaces?.length ?? 0,
            files: res.fileCount ?? 0,
          }),
        )
        // New workspaces were added to config — refresh the workspace list.
        await appShellContext.onRefreshWorkspaces?.()
      } else {
        toast.error(res.error ?? t('settings.data.importError'))
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.data.importError'))
    } finally {
      setImporting(false)
    }
  }, [appShellContext, t])

  // ── Import source chooser: 本地文件 / 远程文件 ───────────────────────────
  const [importSourceOpen, setImportSourceOpen] = useState(false)
  const [remotePathOpen, setRemotePathOpen] = useState(false)
  const [remotePath, setRemotePath] = useState('')

  const handleImportLocalFile = useCallback(async () => {
    setImportSourceOpen(false)
    try {
      const paths = await window.electronAPI.openFileDialog()
      const first = paths?.[0]
      if (!first) return
      await handleImportAllData(() => window.electronAPI.importAllDataFromLocalFile(first))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.data.importError'))
    }
  }, [handleImportAllData, t])

  const handleOpenRemotePathDialog = useCallback(() => {
    setImportSourceOpen(false)
    setRemotePath('')
    setRemotePathOpen(true)
  }, [])

  const handleImportRemotePath = useCallback(async () => {
    const path = remotePath.trim()
    if (!path) return
    setRemotePathOpen(false)
    await handleImportAllData(() => window.electronAPI.importAllDataFromPath(path))
  }, [remotePath, handleImportAllData])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("settings.app.title")} actions={<HeaderMenu route={routes.view.settings('app')} helpFeature="app-settings" />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              {/* Notifications */}
              <SettingsSection title={t("settings.notifications.title")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.notifications.desktopNotifications")}
                    description={t("settings.notifications.desktopNotificationsDesc")}
                    checked={notificationsEnabled}
                    onCheckedChange={handleNotificationsEnabledChange}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Power */}
              <SettingsSection title={t("settings.power.title")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.power.keepScreenAwake")}
                    description={t("settings.power.keepScreenAwakeDesc")}
                    checked={keepAwakeEnabled}
                    onCheckedChange={handleKeepAwakeEnabledChange}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Tools */}
              <SettingsSection title={t("settings.tools.title")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.tools.builtInBrowser")}
                    description={t("settings.tools.builtInBrowserDesc")}
                    checked={browserToolEnabled}
                    onCheckedChange={handleBrowserToolEnabledChange}
                  />
                  <SettingsToggle
                    label={t("settings.tools.requireSourceGuide")}
                    description={t("settings.tools.requireSourceGuideDesc")}
                    checked={requireSourceGuide}
                    onCheckedChange={handleRequireSourceGuideChange}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Network */}
              <SettingsSection title={t("settings.network.title")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.network.httpProxy")}
                    description={t("settings.network.httpProxyDesc")}
                    checked={proxyForm.enabled}
                    onCheckedChange={(enabled) => setProxyForm(prev => ({ ...prev, enabled }))}
                  />
                  {proxyForm.enabled && (
                    <>
                      <SettingsInput
                        label={t("settings.network.httpProxyLabel")}
                        value={proxyForm.httpProxy}
                        onChange={(value) => setProxyForm(prev => ({ ...prev, httpProxy: value }))}
                        placeholder={t("settings.network.proxyPlaceholder")}
                        inCard
                      />
                      <SettingsInput
                        label={t("settings.network.httpsProxyLabel")}
                        value={proxyForm.httpsProxy}
                        onChange={(value) => setProxyForm(prev => ({ ...prev, httpsProxy: value }))}
                        placeholder={t("settings.network.proxyPlaceholder")}
                        inCard
                      />
                      <SettingsInput
                        label={t("settings.network.bypassRules")}
                        value={proxyForm.noProxy}
                        onChange={(value) => setProxyForm(prev => ({ ...prev, noProxy: value }))}
                        placeholder={t("settings.network.bypassPlaceholder")}
                        inCard
                      />
                    </>
                  )}
                  {(isProxyDirty || proxyError) && (
                    <SettingsCardFooter>
                      {proxyError && (
                        <span className="text-destructive text-sm mr-auto">{proxyError === 'proxyErrorProtocol' ? t("settings.network.proxyErrorProtocol") : proxyError === 'proxyErrorFormat' ? t("settings.network.proxyErrorFormat") : proxyError}</span>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleResetProxy}
                        disabled={!isProxyDirty || isSavingProxy}
                      >
                        {t("common.reset")}
                      </Button>
                      <Button
                        size="sm"
                        onClick={handleSaveProxy}
                        disabled={!isProxyDirty || isSavingProxy}
                      >
                        {isSavingProxy ? (
                          <>
                            <Spinner className="mr-1.5" />
                            {t("common.saving")}
                          </>
                        ) : (
                          t("common.save")
                        )}
                      </Button>
                    </SettingsCardFooter>
                  )}
                </SettingsCard>
              </SettingsSection>

              {/* Data */}
              <SettingsSection title={t("settings.data.title")} description={t("settings.data.exportDesc")}>
                <SettingsCard divided>
                  <SettingsRow
                    label={t("settings.data.export")}
                    description={t("settings.data.credentialsNote")}
                    action={
                      <Button
                        size="sm"
                        onClick={handleExportAllData}
                        disabled={exporting || importing}
                      >
                        {exporting ? (
                          <>
                            <Spinner className="mr-1.5" />
                            {t("settings.data.exporting")}
                          </>
                        ) : (
                          <>
                            <Download className="h-3.5 w-3.5 mr-1.5" />
                            {t("settings.data.exportAction")}
                          </>
                        )}
                      </Button>
                    }
                  />
                  <SettingsRow
                    label={t("settings.data.import")}
                    description={t("settings.data.importDesc")}
                    action={
                      <DropdownMenu open={importSourceOpen} onOpenChange={setImportSourceOpen}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={exporting || importing}
                          >
                            {importing ? (
                              <>
                                <Spinner className="mr-1.5" />
                                {t("settings.data.importing")}
                              </>
                            ) : (
                              <>
                                <Upload className="h-3.5 w-3.5 mr-1.5" />
                                {t("settings.data.importAction")}
                              </>
                            )}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuLabel className="text-xs text-foreground/50">
                            {t("settings.data.importSourceTitle")}
                          </DropdownMenuLabel>
                          <DropdownMenuItem onSelect={() => void handleImportLocalFile()}>
                            <HardDrive className="h-3.5 w-3.5" />
                            {t("settings.data.importLocalFile")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={handleOpenRemotePathDialog}>
                            <Cloud className="h-3.5 w-3.5" />
                            {t("settings.data.importRemoteFile")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    }
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Remote import path dialog (远程文件) */}
              <Dialog open={remotePathOpen} onOpenChange={setRemotePathOpen}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{t("settings.data.remotePathTitle")}</DialogTitle>
                    <DialogDescription>{t("settings.data.remotePathDesc")}</DialogDescription>
                  </DialogHeader>
                  <SettingsInput
                    value={remotePath}
                    onChange={setRemotePath}
                    placeholder={t("settings.data.remotePathPlaceholder")}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleImportRemotePath() }}
                  />
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setRemotePathOpen(false)}>
                      {t("common.cancel")}
                    </Button>
                    <Button onClick={() => void handleImportRemotePath()} disabled={!remotePath.trim() || importing}>
                      {t("settings.data.importAction")}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              {/* About */}
              <SettingsSection title={t("settings.about.title")}>
                <SettingsCard>
                  <SettingsRow label="客户端版本">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">
                        {clientVersion ?? updateChecker.updateInfo?.currentVersion ?? t("common.loading")}
                      </span>
                      {isElectron && updateChecker.isDownloading && updateChecker.updateInfo?.latestVersion && (
                        <div className="flex items-center gap-2 text-muted-foreground text-sm">
                          <Spinner className="w-3 h-3" />
                          <span>{t("settings.about.downloading", { version: updateChecker.updateInfo.latestVersion, percent: updateChecker.downloadProgress })}</span>
                        </div>
                      )}
                    </div>
                  </SettingsRow>
                  <SettingsRow label="服务端版本">
                    <span className="text-muted-foreground">
                      {serverVersion ?? '未连接'}
                    </span>
                  </SettingsRow>
                  {isElectron && (
                    <SettingsRow label={t("settings.about.checkForUpdates")}>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleCheckForUpdates}
                        disabled={isCheckingForUpdates}
                      >
                        {isCheckingForUpdates ? (
                          <>
                            <Spinner className="mr-1.5" />
                            {t("common.checking")}
                          </>
                        ) : (
                          t("settings.about.checkNow")
                        )}
                      </Button>
                    </SettingsRow>
                  )}
                  {isElectron && updateChecker.isReadyToInstall && updateChecker.updateInfo?.latestVersion && (
                    <SettingsRow label={t("settings.about.updateReady")}>
                      <Button
                        size="sm"
                        onClick={updateChecker.installUpdate}
                      >
                        {t("settings.about.restartToUpdate", { version: updateChecker.updateInfo.latestVersion })}
                      </Button>
                    </SettingsRow>
                  )}
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
