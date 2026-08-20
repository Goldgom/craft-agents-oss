import * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Boxes, PlugZap, RefreshCw, Search, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Spinner } from '@craft-agent/ui'
import type { WorkspaceToolCatalogItem, WorkspaceToolCatalogResult } from '@craft-agent/shared/protocol'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { SettingsCard, SettingsSection } from '@/components/settings'
import { useAppShellContext } from '@/context/AppShellContext'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import { cn } from '@/lib/utils'
import { CatalogPagination } from './CatalogPagination'

export const meta: DetailsPageMeta = { navigator: 'settings', slug: 'tools' }

const PAGE_SIZE = 10

function ToolRows({ tools }: { tools: WorkspaceToolCatalogItem[] }) {
  const { t } = useTranslation()
  return (
    <>
      {tools.map(tool => (
        <div key={tool.id} className="flex items-start gap-3 px-4 py-3">
          <div className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border',
            tool.origin === 'builtin' ? 'border-blue-500/20 bg-blue-500/8 text-blue-500' : 'border-violet-500/20 bg-violet-500/8 text-violet-500',
          )}>
            {tool.category === 'mcp' || tool.category === 'api'
              ? <PlugZap className="h-4 w-4" />
              : <Wrench className="h-4 w-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-sm font-medium break-all">{tool.name}</span>
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
                {t(`settings.tools.categories.${tool.category}`)}
              </Badge>
              {tool.status !== 'available' && (
                <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
                  {t(`settings.tools.status.${tool.status}`)}
                </Badge>
              )}
            </div>
            {tool.description && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-foreground/60">{tool.description}</p>}
            {tool.sourceName && (
              <p className="mt-1 text-[11px] text-foreground/45">
                {t('settings.tools.sourceLabel', { source: tool.sourceName })}
              </p>
            )}
          </div>
        </div>
      ))}
    </>
  )
}

export default function ToolsSettingsPage() {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()
  const [result, setResult] = useState<WorkspaceToolCatalogResult>({ tools: [], warnings: [] })
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [builtinPage, setBuiltinPage] = useState(1)
  const [addedPage, setAddedPage] = useState(1)

  const load = useCallback(async () => {
    if (!activeWorkspaceId) {
      setResult({ tools: [], warnings: [] })
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setResult(await window.electronAPI.listWorkspaceTools(activeWorkspaceId))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.tools.loadError'))
    } finally {
      setLoading(false)
    }
  }, [activeWorkspaceId, t])

  useEffect(() => { void load() }, [load])
  useEffect(() => { setBuiltinPage(1); setAddedPage(1) }, [search, result.tools])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return result.tools
    return result.tools.filter(tool => [tool.name, tool.description, tool.category, tool.sourceName, tool.sourceSlug]
      .some(value => value?.toLowerCase().includes(query)))
  }, [result.tools, search])
  const builtins = filtered.filter(tool => tool.origin === 'builtin')
  const added = filtered.filter(tool => tool.origin === 'added')
  const builtinSlice = builtins.slice((builtinPage - 1) * PAGE_SIZE, builtinPage * PAGE_SIZE)
  const addedSlice = added.slice((addedPage - 1) * PAGE_SIZE, addedPage * PAGE_SIZE)

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title={t('settings.tools.title')}
        actions={(
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
            {t('common.refresh')}
          </Button>
        )}
      />
      <div className="min-h-0 flex-1 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-4xl space-y-7 px-5 py-7">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={event => setSearch(event.target.value)} className="pl-9" placeholder={t('settings.tools.searchPlaceholder')} />
            </div>

            {result.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
                <div className="flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {t('settings.tools.partialWarning', { count: result.warnings.length })}
                </div>
                <p className="mt-1 pl-5.5 text-[11px] text-foreground/55 line-clamp-2">
                  {result.warnings.map(item => `${item.sourceName}: ${item.message}`).join(' · ')}
                </p>
              </div>
            )}

            {loading ? (
              <div className="flex justify-center py-20"><Spinner /></div>
            ) : (
              <>
                <SettingsSection title={t('settings.tools.builtinTitle')} description={t('settings.tools.builtinDescription', { count: builtins.length })}>
                  <SettingsCard divided>
                    {builtinSlice.length ? <ToolRows tools={builtinSlice} /> : <div className="px-4 py-10 text-center text-sm text-muted-foreground">{t('settings.tools.empty')}</div>}
                    <CatalogPagination page={builtinPage} pageSize={PAGE_SIZE} total={builtins.length} onPageChange={setBuiltinPage} />
                  </SettingsCard>
                </SettingsSection>

                <SettingsSection title={t('settings.tools.addedTitle')} description={t('settings.tools.addedDescription', { count: added.length })}>
                  <SettingsCard divided>
                    {addedSlice.length ? <ToolRows tools={addedSlice} /> : (
                      <div className="flex flex-col items-center px-4 py-10 text-center">
                        <Boxes className="mb-2 h-6 w-6 text-muted-foreground/50" />
                        <p className="text-sm text-muted-foreground">{search ? t('settings.tools.empty') : t('settings.tools.noAdded')}</p>
                      </div>
                    )}
                    <CatalogPagination page={addedPage} pageSize={PAGE_SIZE} total={added.length} onPageChange={setAddedPage} />
                  </SettingsCard>
                </SettingsSection>
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
