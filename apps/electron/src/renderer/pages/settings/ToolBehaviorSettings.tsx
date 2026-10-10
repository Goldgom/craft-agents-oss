import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { SettingsCard, SettingsSection, SettingsToggle } from '@/components/settings'

type ToolBehavior = 'browser' | 'sourceGuide' | 'descriptions'
type ToolBehaviorValues = Record<ToolBehavior, boolean>

export function ToolBehaviorSettings() {
  const { t } = useTranslation()
  const [values, setValues] = useState<ToolBehaviorValues | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.electronAPI.getBrowserToolEnabled(),
      window.electronAPI.getRequireSourceGuide(),
      window.electronAPI.getRichToolDescriptions(),
    ]).then(([browser, sourceGuide, descriptions]) => {
      if (!cancelled) setValues({ browser, sourceGuide, descriptions })
    }).catch(error => {
      if (!cancelled) toast.error(error instanceof Error ? error.message : t('settings.tools.loadError'))
    })
    return () => { cancelled = true }
  }, [t])

  const save = async (key: ToolBehavior, enabled: boolean) => {
    if (!values || saving) return
    setSaving(true)
    try {
      if (key === 'browser') await window.electronAPI.setBrowserToolEnabled(enabled)
      if (key === 'sourceGuide') await window.electronAPI.setRequireSourceGuide(enabled)
      if (key === 'descriptions') await window.electronAPI.setRichToolDescriptions(enabled)
      setValues(current => current ? { ...current, [key]: enabled } : current)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.tools.loadError'))
    } finally {
      setSaving(false)
    }
  }

  const rows = [
    { key: 'browser', label: 'settings.tools.builtInBrowser', description: 'settings.tools.builtInBrowserDesc' },
    { key: 'sourceGuide', label: 'settings.tools.requireSourceGuide', description: 'settings.tools.requireSourceGuideDesc' },
    { key: 'descriptions', label: 'settings.appearance.richToolDescriptions', description: 'settings.appearance.richToolDescriptionsDesc' },
  ] as const

  return (
    <SettingsSection title={t('settings.tools.behaviorTitle')}>
      <SettingsCard>
        {rows.map(row => (
          <SettingsToggle
            key={row.key}
            label={t(row.label)}
            description={t(row.description)}
            checked={values?.[row.key] ?? false}
            disabled={!values || saving}
            onCheckedChange={enabled => void save(row.key, enabled)}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  )
}
