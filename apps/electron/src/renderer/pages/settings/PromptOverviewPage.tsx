import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SettingsCard, SettingsSection, SettingsTextarea, SettingsToggle } from '@/components/settings'
import { useAppShellContext } from '@/context/AppShellContext'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { SystemPromptSource } from '@craft-agent/shared/protocol'

export const meta: DetailsPageMeta = { navigator: 'settings', slug: 'promptOverview' }

const SOURCE_KEYS: Record<SystemPromptSource['source'], string> = {
  builtin: 'builtin',
  user: 'user',
  workspace: 'workspace',
  project: 'project',
  context: 'context',
  debug: 'debug',
}

export default function PromptOverviewPage() {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()
  const [sources, setSources] = useState<SystemPromptSource[]>([])
  const [loading, setLoading] = useState(true)
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({})
  const [editableInstructions, setEditableInstructions] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!activeWorkspaceId) { setSources([]); setLoading(false); return }
    setLoading(true)
    try {
      const [nextSources, settings] = await Promise.all([
        window.electronAPI.getSystemPromptSources(activeWorkspaceId),
        window.electronAPI.getSystemPromptSettings(),
      ])
      setSources(nextSources)
      setCapabilities(settings.capabilities)
      setEditableInstructions(settings.editableInstructions ?? '')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.promptOverview.loadError'))
    } finally {
      setLoading(false)
    }
  }, [activeWorkspaceId, t])

  useEffect(() => { void load() }, [load])

  const activeCount = useMemo(() => sources.filter(source => source.enabled).length, [sources])
  const saveSettings = async (nextCapabilities = capabilities, nextInstructions = editableInstructions) => {
    setSaving(true)
    try {
      await window.electronAPI.setSystemPromptSettings({ capabilities: nextCapabilities, editableInstructions: nextInstructions })
      await load()
      toast.success(t('settings.promptOverview.saved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.promptOverview.saveError'))
    } finally { setSaving(false) }
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title={t('settings.promptOverview.title')}
        actions={(
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {t('common.refresh')}
          </Button>
        )}
      />
      <div className="min-h-0 flex-1 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-4xl space-y-7 px-5 py-7">
            <SettingsSection title={t('settings.promptOverview.capabilitiesTitle')} description={t('settings.promptOverview.capabilitiesDescription')}>
              <SettingsCard divided>
                {(['browserTools', 'webSearch', 'structuredData', 'documentTools', 'themeDesign'] as const).map(capability => (
                  <SettingsToggle
                    key={capability}
                    label={t(`settings.promptOverview.capability.${capability}`)}
                    description={t(`settings.promptOverview.capability.${capability}Desc`)}
                    checked={capabilities[capability] !== false}
                    disabled={loading || saving}
                    onCheckedChange={checked => {
                      const next = { ...capabilities, [capability]: checked }
                      setCapabilities(next)
                      void saveSettings(next, editableInstructions)
                    }}
                  />
                ))}
              </SettingsCard>
            </SettingsSection>
            <SettingsSection title={t('settings.promptOverview.editableTitle')} description={t('settings.promptOverview.editableDescription')}>
              <SettingsCard>
                <SettingsTextarea value={editableInstructions} onChange={setEditableInstructions} maxLength={20000} rows={7} placeholder={t('settings.promptOverview.editablePlaceholder')} inCard />
                <div className="flex justify-end border-t border-border/50 px-4 py-3"><Button disabled={loading || saving} onClick={() => void saveSettings()}>{t('settings.promptOverview.save')}</Button></div>
              </SettingsCard>
            </SettingsSection>
            <SettingsSection
              title={t('settings.promptOverview.sectionTitle')}
              description={t('settings.promptOverview.sectionDescription', { count: activeCount })}
            >
              <SettingsCard divided>
                {loading ? (
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
                ) : sources.length === 0 ? (
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">{t('settings.promptOverview.empty')}</div>
                ) : sources.map(source => (
                  <article key={source.id} className="space-y-2 px-4 py-4">
                    <div className="flex items-center gap-2">
                      <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{source.title}</h3>
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {t(`settings.promptOverview.source.${SOURCE_KEYS[source.source]}`)}
                      </Badge>
                      <Badge variant={source.enabled ? 'secondary' : 'outline'} className="shrink-0 text-[10px]">
                        {source.enabled ? t('settings.promptOverview.enabled') : t('settings.promptOverview.disabled')}
                      </Badge>
                    </div>
                    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-xs leading-relaxed text-foreground/75">{source.content}</pre>
                  </article>
                ))}
              </SettingsCard>
            </SettingsSection>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
