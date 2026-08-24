import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Terminal, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { ToolIconMapping } from '../../shared/types'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { SettingsCard, SettingsSection } from '@/components/settings'
import { useAppShellContext } from '@/context/AppShellContext'
import { cn } from '@/lib/utils'

export default function CliToolsPage({ filter }: { filter?: 'builtin' | 'custom' }) {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()
  const [tools, setTools] = useState<ToolIconMapping[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setTools(await window.electronAPI.getToolIconMappings())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.tools.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t, activeWorkspaceId])

  useEffect(() => { void load() }, [load])

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return tools.filter(tool => {
      const origin = tool.origin ?? 'custom'
      if (filter && origin !== filter) return false
      if (!normalized) return true
      return [tool.displayName, tool.id, ...tool.commands].some(value => value.toLowerCase().includes(normalized))
    })
  }, [filter, query, tools])

  const title = filter === 'builtin' ? t('settings.tools.builtinTitle') : filter === 'custom' ? 'Custom CLI' : t('settings.tools.title')

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={title} actions={<Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}><RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />{t('common.refresh')}</Button>} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-4xl space-y-6 px-5 py-7">
          <div>
            <h2 className="text-lg font-semibold">{t('settings.tools.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('settings.tools.description')}</p>
          </div>
          <Input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('settings.tools.searchPlaceholder')} />
          {loading ? <div className="py-16 text-center text-sm text-muted-foreground">{t('common.loading')}</div> : (
            <SettingsSection title={filter === 'builtin' ? t('settings.tools.builtinTitle') : filter === 'custom' ? 'Custom CLI' : t('settings.tools.title')} description={`${visible.length} tools`}>
              <SettingsCard divided>
                {visible.length === 0 ? <div className="px-4 py-12 text-center text-sm text-muted-foreground">{t('settings.tools.empty')}</div> : visible.map(tool => (
                  <div key={tool.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/30">
                      {tool.iconDataUrl ? <img src={tool.iconDataUrl} alt="" className="h-5 w-5 object-contain" /> : <Terminal className="h-4 w-4 text-muted-foreground" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{tool.displayName}</span><Badge variant="secondary">{tool.origin === 'builtin' ? t('settings.tools.builtinTitle') : 'Custom'}</Badge></div>
                      <p className="mt-1 text-xs text-muted-foreground">Commands: <code>{tool.commands.join(', ')}</code></p>
                      {tool.description && <p className="mt-1 text-xs text-foreground/60">{tool.description}</p>}
                      <p className="mt-1 text-[11px] text-muted-foreground/70">Identifier: {tool.id}</p>
                    </div>
                  </div>
                ))}
              </SettingsCard>
            </SettingsSection>
          )}
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Wrench className="h-3.5 w-3.5" />Custom mappings can be managed in tool-icons.json.</div>
        </div>
      </ScrollArea>
    </div>
  )
}
