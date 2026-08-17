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
import { Cloud, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
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
  const [saving, setSaving] = useState(false)

  const [testingId, setTestingId] = useState<string | null>(null)
  const [switchingId, setSwitchingId] = useState<string | null>(null)

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
    </div>
  )
}
