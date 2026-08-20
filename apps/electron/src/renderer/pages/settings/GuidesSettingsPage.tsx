import * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, FileText, RefreshCw, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Markdown, Spinner } from '@craft-agent/ui'
import type { FeatureGuideCatalogItem } from '@craft-agent/shared/protocol'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SettingsCard, SettingsSection } from '@/components/settings'
import { useAppShellContext } from '@/context/AppShellContext'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import { cn } from '@/lib/utils'
import { CatalogPagination } from './CatalogPagination'

export const meta: DetailsPageMeta = { navigator: 'settings', slug: 'guides' }

const PAGE_SIZE = 8

export default function GuidesSettingsPage() {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()
  const [guides, setGuides] = useState<FeatureGuideCatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedTag, setSelectedTag] = useState('all')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<FeatureGuideCatalogItem | null>(null)

  const load = useCallback(async () => {
    if (!activeWorkspaceId) {
      setGuides([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setGuides(await window.electronAPI.listFeatureGuides(activeWorkspaceId))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.guides.loadError'))
    } finally {
      setLoading(false)
    }
  }, [activeWorkspaceId, t])

  useEffect(() => { void load() }, [load])
  useEffect(() => { setPage(1) }, [search, selectedTag, guides])

  const tags = useMemo(() => Array.from(new Set(guides.flatMap(guide => guide.tags))).sort(), [guides])
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return guides.filter(guide => {
      if (selectedTag !== 'all' && !guide.tags.includes(selectedTag)) return false
      if (!query) return true
      return [guide.title, guide.filename, guide.summary, guide.sourceName, guide.content, ...guide.tags]
        .some(value => value?.toLowerCase().includes(query))
    })
  }, [guides, search, selectedTag])
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title={t('settings.guides.title')}
        actions={(
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
            {t('common.refresh')}
          </Button>
        )}
      />
      <div className="min-h-0 flex-1 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-4xl space-y-6 px-5 py-7">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={event => setSearch(event.target.value)} className="pl-9" placeholder={t('settings.guides.searchPlaceholder')} />
            </div>

            <div className="flex flex-wrap gap-1.5">
              <Button variant={selectedTag === 'all' ? 'default' : 'outline'} size="sm" className="h-7 rounded-full text-xs" onClick={() => setSelectedTag('all')}>
                {t('settings.guides.allTags')}
              </Button>
              {tags.map(tag => (
                <Button key={tag} variant={selectedTag === tag ? 'default' : 'outline'} size="sm" className="h-7 rounded-full text-xs" onClick={() => setSelectedTag(tag)}>
                  {tag}
                </Button>
              ))}
            </div>

            <SettingsSection title={t('settings.guides.sectionTitle')} description={t('settings.guides.sectionDescription', { count: filtered.length })}>
              <SettingsCard divided>
                {loading ? (
                  <div className="flex justify-center py-20"><Spinner /></div>
                ) : visible.length === 0 ? (
                  <div className="flex flex-col items-center px-4 py-12 text-center">
                    <BookOpen className="mb-2 h-7 w-7 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground">{t('settings.guides.empty')}</p>
                  </div>
                ) : visible.map(guide => (
                  <button key={guide.id} type="button" className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-foreground/[0.025]" onClick={() => setSelected(guide)}>
                    <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-foreground/10 bg-foreground/[0.025]">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{guide.title}</span>
                        <Badge variant={guide.scope === 'system' ? 'secondary' : 'outline'} className="px-1.5 py-0 text-[10px] font-normal">
                          {t(`settings.guides.scope.${guide.scope}`)}
                        </Badge>
                      </div>
                      {guide.summary && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-foreground/60">{guide.summary}</p>}
                      <div className="mt-2 flex flex-wrap gap-1">
                        {guide.tags.slice(0, 5).map(tag => <span key={tag} className="rounded bg-foreground/5 px-1.5 py-0.5 text-[10px] text-foreground/50">{tag}</span>)}
                      </div>
                    </div>
                  </button>
                ))}
                <CatalogPagination page={page} pageSize={PAGE_SIZE} total={filtered.length} onPageChange={setPage} />
              </SettingsCard>
            </SettingsSection>
          </div>
        </ScrollArea>
      </div>

      <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open) setSelected(null) }}>
        <DialogContent className="flex h-[82vh] max-w-4xl flex-col gap-3 p-0">
          {selected && (
            <>
              <DialogHeader className="shrink-0 border-b border-border/60 px-6 pb-4 pt-6 pr-12">
                <DialogTitle>{selected.title}</DialogTitle>
                <DialogDescription className="break-all">{selected.path}</DialogDescription>
                <div className="flex flex-wrap gap-1 pt-1">
                  {selected.tags.map(tag => <Badge key={tag} variant="secondary" className="font-normal">{tag}</Badge>)}
                </div>
              </DialogHeader>
              <ScrollArea className="min-h-0 flex-1 px-6 pb-6">
                <div className="py-4"><Markdown>{selected.content}</Markdown></div>
              </ScrollArea>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
