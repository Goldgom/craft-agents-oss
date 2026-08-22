import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { SettingsCard, SettingsSection } from '@/components/settings'
import type { PerformanceSnapshot } from '@craft-agent/shared/protocol'
import type { DetailsPageMeta } from '@/lib/navigation-registry'

export const meta: DetailsPageMeta = { navigator: 'settings', slug: 'performance' }
const formatBytes = (value?: number) => value == null ? 'N/A' : `${(value / 1024 / 1024).toFixed(1)} MB`

export default function PerformanceSettingsPage() {
  const { t } = useTranslation()
  const [limit, setLimit] = useState('2')
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => { setLoading(true); try { const [settings, data] = await Promise.all([window.electronAPI.getPerformanceSettings(), window.electronAPI.getPerformanceSnapshot()]); setLimit(String(settings.maxWarmRuntimes)); setSnapshot(data) } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to load performance data') } finally { setLoading(false) } }, [])
  useEffect(() => { void load() }, [load])
  const save = async () => { const value = Number(limit); if (!Number.isSafeInteger(value) || value < 0) { toast.error(t('settings.performance.invalid')); return }; await window.electronAPI.setPerformanceSettings({ maxWarmRuntimes: value }); toast.success(t('settings.performance.saved')); await load() }
  return <div className="flex h-full flex-col"><PanelHeader title={t('settings.performance.title')} actions={<Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />{t('common.refresh')}</Button>} /><div className="min-h-0 flex-1"><ScrollArea className="h-full"><div className="mx-auto max-w-4xl space-y-7 px-5 py-7"><SettingsSection title={t('settings.performance.settingsTitle')} description={t('settings.performance.maxWarmRuntimesDesc')}><SettingsCard><div className="flex items-center gap-3 px-4 py-4"><Input className="w-28" type="number" min={0} value={limit} onChange={e => setLimit(e.target.value)} /><Button onClick={() => void save()}>{t('settings.performance.save')}</Button>{snapshot && <span className="text-sm text-muted-foreground">{t('settings.performance.warmCount', { count: snapshot.warmRuntimeCount })}</span>}</div></SettingsCard></SettingsSection><SettingsSection title={t('settings.performance.analysisTitle')}><SettingsCard><div className="grid grid-cols-2 gap-3 p-4 text-sm md:grid-cols-5">{[['rss', snapshot?.total.rssBytes], ['heapUsed', snapshot?.total.heapUsedBytes], ['heapTotal', snapshot?.total.heapTotalBytes], ['external', snapshot?.total.externalBytes], ['arrayBuffers', snapshot?.total.arrayBuffersBytes]].map(([key, value]) => <div key={key}><div className="text-muted-foreground">{t(`settings.performance.${key}`)}</div><div className="font-medium">{formatBytes(value as number | undefined)}</div></div>)}</div><div className="border-t border-border/50"><div className="grid grid-cols-[auto_1fr_auto_auto] gap-3 px-4 py-2 text-xs text-muted-foreground"><span>{t('settings.performance.kindLabel')}</span><span>{t('settings.performance.nameLabel')}</span><span>{t('settings.performance.statusLabel')}</span><span>{t('settings.performance.memoryLabel')}</span></div>{snapshot?.processes.map(item => <div key={item.id} className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 border-t border-border/40 px-4 py-2 text-sm"><Badge variant="secondary">{item.kind}</Badge><div className="min-w-0 truncate">{item.name}<div className="text-xs text-muted-foreground">{item.sourceSlug ?? item.sessionId ?? ''}</div></div><span className="text-xs text-muted-foreground">{item.status ?? 'N/A'}</span><span className="text-xs">{formatBytes(item.rssBytes)}</span></div>)}</div></SettingsCard></SettingsSection></div></ScrollArea></div></div>
}
