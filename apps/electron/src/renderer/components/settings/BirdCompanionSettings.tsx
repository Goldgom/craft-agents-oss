import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsSection, SettingsCard, SettingsToggle } from './index'
import { DEFAULT_BIRD_COMPANION_PREFERENCES, type BirdCompanionPreferences } from '../../../shared/bird-companion'
import { toast } from 'sonner'

export function BirdCompanionSettings() {
  const { t } = useTranslation()
  const [preferences, setPreferences] = useState<BirdCompanionPreferences>(DEFAULT_BIRD_COMPANION_PREFERENCES)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const supported = !!window.electronAPI.getBirdCompanionPreferences
  useEffect(() => {
    if (!supported) return
    let cancelled = false
    window.electronAPI.getBirdCompanionPreferences!()
      .then(value => { if (!cancelled) setPreferences(value) })
      .catch(() => { if (!cancelled) setLoadError(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [supported])
  if (!supported) return null
  const save = async (updates: Partial<BirdCompanionPreferences>) => {
    setSaving(true)
    try { setPreferences(await window.electronAPI.setBirdCompanionPreferences!(updates)) }
    catch { toast.error(t('birdCompanion.settings.saveError')) }
    finally { setSaving(false) }
  }
  return (
    <SettingsSection title={t('birdCompanion.settings.title')} description={t('birdCompanion.settings.description')}>
      <SettingsCard>
        <SettingsToggle label={t('birdCompanion.settings.alwaysVisible')} description={t('birdCompanion.settings.alwaysVisibleDescription')}
          checked={preferences.alwaysVisible} disabled={loading || saving || loadError}
          onCheckedChange={value => { void save({ alwaysVisible: value }) }} />
        <SettingsToggle label={t('birdCompanion.settings.autoShow')} description={t('birdCompanion.settings.autoShowDescription')}
          checked={preferences.autoShowComputerUse} disabled={loading || saving || loadError}
          onCheckedChange={value => { void save({ autoShowComputerUse: value }) }} />
      </SettingsCard>
      {loadError && <p role="alert" className="text-sm text-destructive">{t('birdCompanion.settings.loadError')}</p>}
    </SettingsSection>
  )
}
