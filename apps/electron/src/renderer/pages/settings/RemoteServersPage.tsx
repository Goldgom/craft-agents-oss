/**
 * RemoteServersPage — 远程服务器管理
 *
 * Manages the client's registry of remote Craft Agent servers:
 *   - add/edit/delete server profiles (URL + token + name)
 *   - test connectivity
 *   - switch the application directly to a configured remote server
 */

import * as React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Cloud, Download, FolderOpen, Pencil, Plus, RefreshCw, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { Button } from '@/components/ui/button'
import { Spinner } from '@craft-agent/ui'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { routes } from '@/lib/navigate'
import {
  SettingsSection,
  SettingsCard,
  SettingsInput,
  SettingsSecretInput,
  SettingsSelect,
  SettingsToggle,
} from '@/components/settings'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { RemoteServerProfileInfo } from '../../../shared/types'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'remoteServers',
}

export default function RemoteServersPage() {
  const { t } = useTranslation()

  const [profiles, setProfiles] = useState<RemoteServerProfileInfo[]>([])
  const [loading, setLoading] = useState(true)

  // Editor dialog
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<RemoteServerProfileInfo | null>(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [sftpEnabled, setSftpEnabled] = useState(false)
  const [sftpHost, setSftpHost] = useState('')
  const [sftpPort, setSftpPort] = useState('22')
  const [sftpUsername, setSftpUsername] = useState('')
  const [sftpAuthMethod, setSftpAuthMethod] = useState<'password' | 'privateKey'>('password')
  const [sftpPassword, setSftpPassword] = useState('')
  const [sftpPrivateKeyPath, setSftpPrivateKeyPath] = useState('')
  const [sftpPassphrase, setSftpPassphrase] = useState('')
  const [sftpRemoteRoot, setSftpRemoteRoot] = useState('')
  const [saving, setSaving] = useState(false)

  const [testingId, setTestingId] = useState<string | null>(null)
  const [testingSftpId, setTestingSftpId] = useState<string | null>(null)
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [transferProfile, setTransferProfile] = useState<RemoteServerProfileInfo | null>(null)
  const [transferDirection, setTransferDirection] = useState<'upload' | 'download'>('upload')
  const [transferLocalPath, setTransferLocalPath] = useState('')
  const [transferRemotePath, setTransferRemotePath] = useState('')
  const [transferring, setTransferring] = useState(false)

  const loadProfiles = React.useCallback(async () => {
    try {
      const list = await window.electronAPI.getRemoteServers()
      setProfiles(list)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.remoteServers.errors.load'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadProfiles()
  }, [loadProfiles])

  const openEditor = (profile: RemoteServerProfileInfo | null) => {
    setEditing(profile)
    setName(profile?.name ?? '')
    setUrl(profile?.url ?? '')
    setToken('')
    setSftpEnabled(profile?.sftp?.enabled ?? false)
    setSftpHost(profile?.sftp?.host ?? '')
    setSftpPort(String(profile?.sftp?.port ?? 22))
    setSftpUsername(profile?.sftp?.username ?? '')
    setSftpAuthMethod(profile?.sftp?.authMethod ?? 'password')
    setSftpPassword('')
    setSftpPrivateKeyPath(profile?.sftp?.privateKeyPath ?? '')
    setSftpPassphrase('')
    setSftpRemoteRoot(profile?.sftp?.remoteRoot ?? '')
    setEditorOpen(true)
  }

  const handleSave = async () => {
    if (!name.trim() || !url.trim()) return
    setSaving(true)
    try {
      const saved = await window.electronAPI.saveRemoteServer({
        id: editing?.id,
        name: name.trim(),
        url: url.trim(),
        token: token.trim() || undefined,
        sftp: {
          enabled: sftpEnabled,
          host: sftpHost.trim() || undefined,
          port: Number(sftpPort),
          username: sftpUsername.trim() || undefined,
          authMethod: sftpAuthMethod,
          password: sftpPassword.trim() || undefined,
          privateKeyPath: sftpPrivateKeyPath.trim() || undefined,
          passphrase: sftpPassphrase.trim() || undefined,
          remoteRoot: sftpRemoteRoot.trim() || undefined,
        },
      })
      setProfiles(prev => [...prev.filter(p => p.id !== saved.id), saved])
      toast.success(t('settings.remoteServers.toasts.saved'))
      setEditorOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.remoteServers.errors.save'))
    } finally {
      setSaving(false)
    }
  }

  const handleTestSftp = async (profile: RemoteServerProfileInfo) => {
    setTestingSftpId(profile.id)
    try {
      const result = await window.electronAPI.testRemoteServerSftp(profile.id)
      if (result.ok) toast.success(t('settings.remoteServers.sftpTestOk', { root: result.root ?? '~' }))
      else toast.error(result.error ?? t('settings.remoteServers.sftpTestFailed'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.remoteServers.sftpTestFailed'))
    } finally {
      setTestingSftpId(null)
    }
  }

  const openTransfer = async (profile: RemoteServerProfileInfo, direction: 'upload' | 'download') => {
    setTransferProfile(profile)
    setTransferDirection(direction)
    setTransferRemotePath('')
    setTransferLocalPath('')
    if (direction === 'upload') {
      const path = await window.electronAPI.pickSftpUploadFile()
      if (!path) {
        setTransferProfile(null)
        return
      }
      setTransferLocalPath(path)
      setTransferRemotePath(path.split(/[\\/]/).pop() ?? '')
    }
  }

  const chooseTransferLocalPath = async () => {
    if (transferDirection === 'upload') {
      const path = await window.electronAPI.pickSftpUploadFile()
      if (path) setTransferLocalPath(path)
      return
    }
    const name = transferRemotePath.split('/').pop() || undefined
    const path = await window.electronAPI.pickSftpDownloadDestination(name)
    if (path) setTransferLocalPath(path)
  }

  const handleTransfer = async () => {
    if (!transferProfile || !transferLocalPath || !transferRemotePath.trim()) return
    setTransferring(true)
    try {
      const result = await window.electronAPI.transferRemoteServerFile(transferProfile.id, {
        direction: transferDirection,
        localPath: transferLocalPath,
        remotePath: transferRemotePath.trim(),
      })
      toast.success(t('settings.remoteServers.transferSuccess', { bytes: result.bytes }))
      setTransferProfile(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.remoteServers.transferFailed'))
    } finally {
      setTransferring(false)
    }
  }

  const handleDelete = async (profile: RemoteServerProfileInfo) => {
    try {
      await window.electronAPI.deleteRemoteServer(profile.id)
      setProfiles(prev => prev.filter(p => p.id !== profile.id))
      toast.success(t('settings.remoteServers.toasts.deleted'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.remoteServers.errors.delete'))
    }
  }

  const handleTest = async (profile: RemoteServerProfileInfo) => {
    setTestingId(profile.id)
    try {
      const res = await window.electronAPI.testRemoteServer({ id: profile.id })
      if (res.ok) {
        toast.success(
          t('settings.remoteServers.toasts.testOk', {
            version: res.serverVersion ?? '—',
          }),
        )
      } else {
        toast.error(res.error ?? t('settings.remoteServers.errors.test'))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.remoteServers.errors.test'))
    } finally {
      setTestingId(null)
    }
  }

  const handleSwitch = async (profile: RemoteServerProfileInfo) => {
    if (switchingId) return
    setSwitchingId(profile.id)
    try {
      await window.electronAPI.switchServer(profile.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('serverSwitcher.switchFailed'))
    } finally {
      setSwitchingId(null)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={t('settings.remoteServers.title')}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="default" size="sm" onClick={() => openEditor(null)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              {t('settings.remoteServers.add')}
            </Button>
            <HeaderMenu route={routes.view.settings('remoteServers')} helpFeature="messaging" />
          </div>
        }
      />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto space-y-8">
            <SettingsSection
              title={t('settings.remoteServers.sectionTitle')}
              description={t('settings.remoteServers.sectionDesc')}
            >
              <SettingsCard divided>
                {loading ? (
                  <div className="flex items-center justify-center py-10"><Spinner /></div>
                ) : profiles.length === 0 ? (
                  <div className="px-4 py-10 text-center space-y-2">
                    <Cloud className="h-8 w-8 mx-auto text-foreground/30" />
                    <p className="text-sm text-foreground/70">{t('settings.remoteServers.empty')}</p>
                    <p className="text-xs text-foreground/50">{t('settings.remoteServers.emptyHint')}</p>
                  </div>
                ) : (
                  profiles.map(profile => (
                      <div key={profile.id} className="px-4 py-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{profile.name}</p>
                            <p className="text-xs text-foreground/50 truncate">{profile.url}</p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button variant="ghost" size="icon" title={t('settings.remoteServers.edit')} onClick={() => openEditor(profile)}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" title={t('settings.remoteServers.test')} disabled={testingId === profile.id} onClick={() => void handleTest(profile)}>
                              {testingId === profile.id ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
                            </Button>
                            {profile.sftp?.enabled && (
                              <>
                                <Button variant="ghost" size="icon" title={t('settings.remoteServers.sftpTest')} disabled={testingSftpId === profile.id} onClick={() => void handleTestSftp(profile)}>
                                  {testingSftpId === profile.id ? <Spinner className="h-3.5 w-3.5" /> : <Cloud className="h-3.5 w-3.5" />}
                                </Button>
                                <Button variant="ghost" size="icon" title={t('settings.remoteServers.sftpUpload')} onClick={() => void openTransfer(profile, 'upload')}>
                                  <Upload className="h-3.5 w-3.5" />
                                </Button>
                                <Button variant="ghost" size="icon" title={t('settings.remoteServers.sftpDownload')} onClick={() => void openTransfer(profile, 'download')}>
                                  <Download className="h-3.5 w-3.5" />
                                </Button>
                              </>
                            )}
                            <Button variant="ghost" size="icon" title={t('settings.remoteServers.delete')} onClick={() => void handleDelete(profile)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            disabled={switchingId === profile.id}
                            onClick={() => void handleSwitch(profile)}
                          >
                            {switchingId === profile.id ? <Spinner className="h-3.5 w-3.5 mr-1.5" /> : <Cloud className="h-3.5 w-3.5 mr-1.5" />}
                            {t('serverSwitcher.ariaLabel')}
                          </Button>
                        </div>
                      </div>
                  ))
                )}
              </SettingsCard>
            </SettingsSection>
          </div>
        </ScrollArea>
      </div>

      {/* Editor dialog */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? t('settings.remoteServers.editorTitleEdit') : t('settings.remoteServers.editorTitleNew')}
            </DialogTitle>
            <DialogDescription>{t('settings.remoteServers.editorDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <SettingsInput
              label={t('settings.remoteServers.nameLabel')}
              value={name}
              onChange={setName}
              placeholder={t('settings.remoteServers.namePlaceholder')}
              inCard
            />
            <SettingsInput
              label={t('settings.remoteServers.urlLabel')}
              value={url}
              onChange={setUrl}
              placeholder={t('settings.remoteServers.urlPlaceholder')}
              inCard
            />
            <SettingsSecretInput
              label={t('settings.remoteServers.tokenLabel')}
              value={token}
              onChange={setToken}
              placeholder={t('settings.remoteServers.tokenPlaceholder')}
              inCard
            />
            <SettingsToggle
              label={t('settings.remoteServers.sftpEnabled')}
              description={t('settings.remoteServers.sftpEnabledDesc')}
              checked={sftpEnabled}
              onCheckedChange={setSftpEnabled}
              inCard={false}
            />
            {sftpEnabled && (
              <div className="space-y-4 border-t border-border/50 pt-4">
                <div className="grid grid-cols-[1fr_120px] gap-3">
                  <SettingsInput label={t('settings.remoteServers.sftpHost')} value={sftpHost} onChange={setSftpHost} placeholder="server.example.com" />
                  <SettingsInput label={t('settings.remoteServers.sftpPort')} value={sftpPort} onChange={setSftpPort} placeholder="22" />
                </div>
                <SettingsInput label={t('settings.remoteServers.sftpUsername')} value={sftpUsername} onChange={setSftpUsername} />
                <SettingsSelect
                  label={t('settings.remoteServers.sftpAuthMethod')}
                  value={sftpAuthMethod}
                  onValueChange={(value) => setSftpAuthMethod(value as 'password' | 'privateKey')}
                  options={[
                    { value: 'password', label: t('settings.remoteServers.sftpAuthPassword') },
                    { value: 'privateKey', label: t('settings.remoteServers.sftpAuthPrivateKey') },
                  ]}
                />
                {sftpAuthMethod === 'password' ? (
                  <SettingsSecretInput label={t('settings.remoteServers.sftpPassword')} value={sftpPassword} onChange={setSftpPassword} placeholder={editing?.sftp?.hasPassword ? t('settings.remoteServers.secretKeepPlaceholder') : undefined} />
                ) : (
                  <>
                    <SettingsInput label={t('settings.remoteServers.sftpPrivateKey')} value={sftpPrivateKeyPath} onChange={setSftpPrivateKeyPath} placeholder="~/.ssh/id_ed25519" />
                    <SettingsSecretInput label={t('settings.remoteServers.sftpPassphrase')} value={sftpPassphrase} onChange={setSftpPassphrase} placeholder={editing?.sftp?.hasPassphrase ? t('settings.remoteServers.secretKeepPlaceholder') : undefined} />
                  </>
                )}
                <SettingsInput label={t('settings.remoteServers.sftpRemoteRoot')} description={t('settings.remoteServers.sftpRemoteRootDesc')} value={sftpRemoteRoot} onChange={setSftpRemoteRoot} placeholder="~" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditorOpen(false)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving || !name.trim() || !url.trim()}>
              {saving ? <Spinner className="h-4 w-4" /> : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={transferProfile !== null} onOpenChange={(open) => { if (!open && !transferring) setTransferProfile(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{transferDirection === 'upload' ? t('settings.remoteServers.sftpUpload') : t('settings.remoteServers.sftpDownload')}</DialogTitle>
            <DialogDescription>{transferProfile?.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <SettingsInput
              label={t('settings.remoteServers.localPath')}
              value={transferLocalPath}
              onChange={setTransferLocalPath}
              disabled
              action={
                <Button variant="outline" size="icon" title={t('settings.remoteServers.chooseLocalPath')} onClick={() => void chooseTransferLocalPath()}>
                  <FolderOpen className="h-4 w-4" />
                </Button>
              }
            />
            <SettingsInput
              label={t('settings.remoteServers.remotePath')}
              value={transferRemotePath}
              onChange={setTransferRemotePath}
              placeholder="backups/file.zip"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTransferProfile(null)} disabled={transferring}>{t('common.cancel')}</Button>
            <Button onClick={() => void handleTransfer()} disabled={transferring || !transferLocalPath || !transferRemotePath.trim()}>
              {transferring ? <Spinner className="h-4 w-4" /> : transferDirection === 'upload' ? <Upload className="h-4 w-4" /> : <Download className="h-4 w-4" />}
              <span className="ml-2">{transferDirection === 'upload' ? t('settings.remoteServers.sftpUpload') : t('settings.remoteServers.sftpDownload')}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
