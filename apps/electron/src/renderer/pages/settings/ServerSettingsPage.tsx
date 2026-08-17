/**
 * ServerSettingsPage
 *
 * Configure the Electron app to act as a remote server,
 * accessible from other machines on the network.
 */

import { useState, useEffect, useCallback } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Eye, EyeOff, AlertTriangle, RotateCw, HardDrive, Cloud, Check, Ban } from 'lucide-react'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Spinner } from '@craft-agent/ui'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { ServerConfig, ServerStatus } from '@craft-agent/shared/config/server-config'
import type { RemoteServerProfileInfo } from '../../../shared/types'

import {
  SettingsSection,
  SettingsCard,
  SettingsCardFooter,
  SettingsRow,
  SettingsToggle,
  SettingsInputRow,
} from '@/components/settings'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'server',
}

interface ServerFormState {
  enabled: boolean
  port: string
  tlsCertPath: string
  tlsKeyPath: string
  token: string
}

function configToForm(config: ServerConfig): ServerFormState {
  return {
    enabled: config.enabled,
    port: String(config.port),
    tlsCertPath: config.tlsCertPath ?? '',
    tlsKeyPath: config.tlsKeyPath ?? '',
    token: config.token ?? '',
  }
}

function formToConfig(form: ServerFormState): ServerConfig {
  return {
    enabled: form.enabled,
    port: parseInt(form.port, 10) || 9100,
    tlsCertPath: form.tlsCertPath.trim() || undefined,
    tlsKeyPath: form.tlsKeyPath.trim() || undefined,
    token: form.token || undefined,
  }
}

export default function ServerSettingsPage() {
  const { t } = useTranslation()

  const [form, setForm] = useState<ServerFormState>({
    enabled: false,
    port: '9100',
    tlsCertPath: '',
    tlsKeyPath: '',
    token: '',
  })
  const [savedForm, setSavedForm] = useState<ServerFormState>(form)
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [tokenVisible, setTokenVisible] = useState(false)
  const [error, setError] = useState<string>()

  // ── Startup server location (启动服务器位置) ────────────────────────────
  const [startupLocation, setStartupLocationState] = useState<string>('local')
  const [startupProfiles, setStartupProfiles] = useState<RemoteServerProfileInfo[]>([])
  const [savingLocation, setSavingLocation] = useState(false)

  const isDirty = JSON.stringify(form) !== JSON.stringify(savedForm)

  const loadSettings = useCallback(async () => {
    try {
      const [config, serverStatus, location, profiles] = await Promise.all([
        window.electronAPI.getServerConfig(),
        window.electronAPI.getServerStatus(),
        window.electronAPI.getStartupLocation().catch(() => 'local'),
        window.electronAPI.getRemoteServers().catch(() => [] as RemoteServerProfileInfo[]),
      ])
      const formState = configToForm(config)
      setForm(formState)
      setSavedForm(formState)
      setStatus(serverStatus)
      setStartupLocationState(location)
      setStartupProfiles(profiles)
    } catch (err) {
      console.error('Failed to load server settings:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  const handleSave = async () => {
    setError(undefined)
    const port = parseInt(form.port, 10)
    if (isNaN(port) || port < 1024 || port > 65535) {
      setError(t('settings.server.portValidation'))
      return
    }
    if (form.tlsCertPath && !form.tlsKeyPath) {
      setError(t('settings.server.privateKeyRequired'))
      return
    }
    if (form.tlsKeyPath && !form.tlsCertPath) {
      setError(t('settings.server.certificateRequired'))
      return
    }

    setIsSaving(true)
    try {
      await window.electronAPI.setServerConfig(formToConfig(form))
      setSavedForm(form)
      const newStatus = await window.electronAPI.getServerStatus()
      setStatus(newStatus)
      toast.success(t('settings.server.saved'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      toast.error(t('settings.server.failedToSave', { message: msg }))
    } finally {
      setIsSaving(false)
    }
  }

  const handleReset = () => {
    setForm(savedForm)
    setError(undefined)
  }

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    toast.success(t('settings.server.copiedToClipboard', { label }))
  }

  const handleBrowseCert = async () => {
    const paths = await window.electronAPI.openFileDialog()
    if (paths.length > 0) {
      setForm(f => ({ ...f, tlsCertPath: paths[0]! }))
    }
  }

  const handleBrowseKey = async () => {
    const paths = await window.electronAPI.openFileDialog()
    if (paths.length > 0) {
      setForm(f => ({ ...f, tlsKeyPath: paths[0]! }))
    }
  }

  const handleSetStartupLocation = async (value: string) => {
    if (savingLocation || value === startupLocation) return
    setSavingLocation(true)
    try {
      await window.electronAPI.setStartupLocation(value)
      setStartupLocationState(value)
      toast.success(t('settings.server.startupSaved'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.server.startupFailed'))
    } finally {
      setSavingLocation(false)
    }
  }

  const StartupLocationOption = ({ value, icon, title, subtitle }: {
    value: string
    icon: ReactNode
    title: string
    subtitle: string
  }) => (
    <button
      type="button"
      disabled={savingLocation}
      onClick={() => void handleSetStartupLocation(value)}
      className="w-full flex items-center gap-3 rounded-lg border border-border/50 px-3 py-2.5 text-left transition-colors hover:bg-foreground/5 disabled:opacity-60"
    >
      <span className="shrink-0 h-8 w-8 rounded-md bg-foreground/5 flex items-center justify-center text-foreground/70">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="block text-xs text-foreground/50 truncate">{subtitle}</span>
      </span>
      {startupLocation === value && <Check className="h-4 w-4 shrink-0 text-foreground/70" />}
    </button>
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    )
  }

  const hasTls = !!(form.tlsCertPath && form.tlsKeyPath)
  const needsRestart = status?.needsRestart ?? false
  const showServerDetails = form.enabled || savedForm.enabled

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title={t("settings.server.title")} />
      <ScrollArea className="flex-1">
        <div className="px-5 py-7 max-w-3xl mx-auto space-y-5">

          {/* Startup server location — 启动服务器位置 */}
          <SettingsSection
            title={t("settings.server.startupLocation")}
            description={t("settings.server.startupLocationDesc")}
          >
            <SettingsCard divided>
              <div className="px-4 py-3 space-y-2">
                <StartupLocationOption
                  value="none"
                  icon={<Ban className="h-4 w-4" />}
                  title={t("settings.server.startupNone")}
                  subtitle={t("settings.server.startupNoneDesc")}
                />
                <StartupLocationOption
                  value="local"
                  icon={<HardDrive className="h-4 w-4" />}
                  title={t("settings.server.startupLocal")}
                  subtitle={t("settings.server.startupLocalDesc")}
                />
                {startupProfiles.map((profile) => (
                  <StartupLocationOption
                    key={profile.id}
                    value={profile.id}
                    icon={<Cloud className="h-4 w-4" />}
                    title={profile.name}
                    subtitle={profile.url}
                  />
                ))}
                <p className="text-[11px] text-foreground/40 pt-1">
                  {t("settings.server.startupHint")}
                </p>
              </div>
            </SettingsCard>
          </SettingsSection>

          {/* Enable toggle + restart banner */}
          <SettingsSection title={t("settings.server.remoteAccess")}>
            <SettingsCard>
              <SettingsToggle
                label={t("settings.server.enableServerMode")}
                description={t("settings.server.allowRemoteConnections")}
                checked={form.enabled}
                onCheckedChange={(enabled) => setForm(f => ({ ...f, enabled }))}
              />
            </SettingsCard>

            {needsRestart && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-warning/10 border border-warning/20 text-xs text-warning">
                <RotateCw className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1">{t("settings.server.restartRequired")}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-[11px] px-2"
                  onClick={() => window.electronAPI.relaunchApp()}
                >
                  {t("settings.server.restartNow")}
                </Button>
              </div>
            )}
          </SettingsSection>

          {/* Connection + TLS — only visible when server mode is relevant */}
          {showServerDetails && (
            <SettingsSection title={t("settings.server.connectionSection")}>
              <SettingsCard>
                <SettingsInputRow
                  label={t("settings.server.port")}
                  value={form.port}
                  onChange={(port) => setForm(f => ({ ...f, port }))}
                  placeholder="9100"
                />

                {status && form.enabled && (
                  <>
                    <SettingsRow label={t("common.url")}>
                      <div className="flex items-center gap-1.5">
                        <code className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded">
                          {status.url}
                        </code>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => handleCopy(status.url, 'URL')}>
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </SettingsRow>

                    <SettingsRow label={t("settings.server.token")}>
                      <div className="flex items-center gap-1.5">
                        <code className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded max-w-[180px] truncate">
                          {tokenVisible ? status.token : '••••••••••••••••'}
                        </code>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setTokenVisible(v => !v)}>
                          {tokenVisible ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => handleCopy(status.token, 'Token')}>
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </SettingsRow>
                  </>
                )}

                <SettingsRow label={t("settings.server.certificate")}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                      {form.tlsCertPath || 'Not configured'}
                    </span>
                    <Button variant="outline" size="sm" className="h-6 text-[11px] px-2 shrink-0" onClick={handleBrowseCert}>
                      Browse
                    </Button>
                  </div>
                </SettingsRow>

                <SettingsRow label={t("settings.server.privateKey")}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                      {form.tlsKeyPath || 'Not configured'}
                    </span>
                    <Button variant="outline" size="sm" className="h-6 text-[11px] px-2 shrink-0" onClick={handleBrowseKey}>
                      Browse
                    </Button>
                  </div>
                </SettingsRow>
              </SettingsCard>

              {form.enabled && !hasTls && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-warning/10 border border-warning/20 text-xs text-warning">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>
                    {status?.insecureWarning
                      ? t("settings.server.insecureWarning")
                      : t("settings.server.noTlsWarning")}
                  </span>
                </div>
              )}
            </SettingsSection>
          )}

          {/* Save/Reset */}
          {error && (
            <p className="text-xs text-destructive px-1">{error}</p>
          )}
          {(isDirty || error) && (
            <SettingsCardFooter>
              <Button variant="outline" size="sm" onClick={handleReset} disabled={isSaving}>
                Reset
              </Button>
              <Button size="sm" onClick={handleSave} disabled={isSaving}>
                {isSaving ? <Spinner className="mr-1.5" /> : null}
                Save
              </Button>
            </SettingsCardFooter>
          )}

        </div>
      </ScrollArea>
    </div>
  )
}
