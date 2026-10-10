import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Spinner } from '@craft-agent/ui'
import type { PermissionMode } from '../../../shared/types'
import { SettingsCard, SettingsMenuSelectRow, SettingsSection, SettingsToggle } from '@/components/settings'

const MODES = ['safe', 'ask', 'allow-all'] as const

export function WorkspacePermissionSettings({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<PermissionMode>('ask')
  const [cyclableModes, setCyclableModes] = useState<PermissionMode[]>([...MODES])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.electronAPI.getWorkspaceSettings(workspaceId).then(settings => {
      if (cancelled) return
      if (!settings) throw new Error(t('settings.workspace.noWorkspaceSelected'))
      setMode(settings.permissionMode ?? 'ask')
      if (settings.cyclablePermissionModes && settings.cyclablePermissionModes.length >= 2) {
        setCyclableModes(settings.cyclablePermissionModes)
      }
      setLoading(false)
    }).catch(error => {
      if (!cancelled) setError(error instanceof Error ? error.message : String(error))
    })
    return () => { cancelled = true }
  }, [workspaceId, t])

  const save = async (key: 'permissionMode' | 'cyclablePermissionModes', value: PermissionMode | PermissionMode[]) => {
    if (loading || saving) return
    setSaving(true)
    try {
      await window.electronAPI.updateWorkspaceSetting(workspaceId, key, value)
      if (key === 'permissionMode') setMode(value as PermissionMode)
      else setCyclableModes(value as PermissionMode[])
      setError(null)
    } catch (error) {
      toast.error(t('settings.workspace.failedToSave', { setting: key }), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSaving(false)
    }
  }

  const labels = {
    safe: { label: t('mode.explore'), description: t('mode.exploreFullDesc') },
    ask: { label: t('mode.askToEdit'), description: t('mode.askFullDesc') },
    'allow-all': { label: t('mode.execute'), description: t('mode.executeFullDesc') },
  }

  return (
    <SettingsSection title={t('settings.workspace.permissionsSection')}>
      {loading ? (
        error ? <p className="text-sm text-destructive" role="alert">{error}</p> : <Spinner />
      ) : (
        <>
          <SettingsCard>
            <SettingsMenuSelectRow
              label={t('settings.workspace.defaultMode')}
              description={t('settings.workspace.defaultModeDesc')}
              value={mode}
              disabled={saving}
              onValueChange={value => void save('permissionMode', value as PermissionMode)}
              options={[
                { value: 'safe', label: t('mode.explore'), description: t('mode.exploreDesc') },
                { value: 'ask', label: t('mode.ask'), description: t('mode.askDesc') },
                { value: 'allow-all', label: t('mode.execute'), description: t('mode.executeDesc') },
              ]}
            />
          </SettingsCard>
          <SettingsSection title={t('settings.workspace.modeCycling')} description={t('settings.workspace.modeCyclingDesc')}>
            <SettingsCard>
              {MODES.map(item => (
                <SettingsToggle
                  key={item}
                  label={labels[item].label}
                  description={labels[item].description}
                  checked={cyclableModes.includes(item)}
                  disabled={saving}
                  onCheckedChange={checked => {
                    const next = checked ? [...cyclableModes, item] : cyclableModes.filter(mode => mode !== item)
                    if (next.length < 2) { setError(t('settings.workspace.atLeast2Modes')); return }
                    void save('cyclablePermissionModes', next)
                  }}
                />
              ))}
            </SettingsCard>
            {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
          </SettingsSection>
        </>
      )}
    </SettingsSection>
  )
}
