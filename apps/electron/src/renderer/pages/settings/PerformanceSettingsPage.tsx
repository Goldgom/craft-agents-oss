import { useCallback, useEffect, useState } from 'react'
import { Activity, RefreshCw, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { SettingsCard, SettingsSection } from '@/components/settings'
import type { MemoryLeakCheckResult, PerformanceProcessInfo, PerformanceSnapshot } from '@craft-agent/shared/protocol'
import type { DetailsPageMeta } from '@/lib/navigation-registry'

export const meta: DetailsPageMeta = { navigator: 'settings', slug: 'performance' }

const formatBytes = (value?: number) => value == null
  ? '—'
  : `${(value / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`

const memoryLabel = (item: PerformanceProcessInfo, t: (key: string) => string) => item.rssBytes != null
  ? formatBytes(item.rssBytes)
  : item.memoryStatus === 'included' ? t('settings.performance.includedInServer')
    : item.memoryStatus === 'remote' ? t('settings.performance.remoteUnavailable')
      : t('settings.performance.unavailable')

export default function PerformanceSettingsPage() {
  const { t } = useTranslation()
  const [limit, setLimit] = useState('2')
  const [mcpHardLimit, setMcpHardLimit] = useState('8')
  const [mcpSoftLimit, setMcpSoftLimit] = useState('4')
  const [mcpMemoryHardLimitGb, setMcpMemoryHardLimitGb] = useState('3')
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot | null>(null)
  const [leakCheck, setLeakCheck] = useState<MemoryLeakCheckResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [checkingLeak, setCheckingLeak] = useState(false)
  const [cleaningMcp, setCleaningMcp] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [settings, data] = await Promise.all([
        window.electronAPI.getPerformanceSettings(),
        window.electronAPI.getPerformanceSnapshot(),
      ])
      setLimit(String(settings.maxWarmRuntimes))
      setMcpHardLimit(String(settings.mcpHardLimit))
      setMcpSoftLimit(String(settings.mcpSoftLimit))
      setMcpMemoryHardLimitGb(String(settings.mcpMemoryHardLimitGb))
      setSnapshot(data)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load performance data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    const value = Number(limit)
    const hard = Number(mcpHardLimit)
    const soft = Number(mcpSoftLimit)
    const memory = Number(mcpMemoryHardLimitGb)
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(hard) || hard < 1 ||
      !Number.isSafeInteger(soft) || soft < 0 || soft > hard || !Number.isFinite(memory) || memory <= 0) {
      toast.error(t('settings.performance.invalid'))
      return
    }
    await window.electronAPI.setPerformanceSettings({
      maxWarmRuntimes: value,
      mcpHardLimit: hard,
      mcpSoftLimit: soft,
      mcpMemoryHardLimitGb: memory,
    })
    toast.success(t('settings.performance.saved'))
    await load()
  }

  const clearIdleMcp = async () => {
    setCleaningMcp(true)
    try {
      const result = await window.electronAPI.clearIdleMcpRuntimes()
      toast.success(t('settings.performance.clearIdleDone', { count: result.cleared }))
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settings.performance.clearIdleFailed'))
    } finally {
      setCleaningMcp(false)
    }
  }

  const runLeakCheck = async () => {
    setCheckingLeak(true)
    try {
      setLeakCheck(await window.electronAPI.runMemoryLeakCheck())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settings.performance.leak.failed'))
    } finally {
      setCheckingLeak(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title={t('settings.performance.title')}
        actions={<Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />{t('common.refresh')}</Button>}
      />
      <div className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-4xl space-y-7 px-5 py-7">
            <SettingsSection title={t('settings.performance.settingsTitle')} description={t('settings.performance.maxWarmRuntimesDesc')}>
              <SettingsCard>
                <div className="grid gap-3 px-4 py-4 sm:grid-cols-[repeat(4,minmax(0,1fr))_auto_auto] sm:items-end">
                  <label className="text-sm"><span className="mb-1 block text-muted-foreground">{t('settings.performance.warmLimit')}</span><Input type="number" min={0} value={limit} onChange={e => setLimit(e.target.value)} /></label>
                  <label className="text-sm"><span className="mb-1 block text-muted-foreground">{t('settings.performance.mcpHardLimit')}</span><Input type="number" min={1} value={mcpHardLimit} onChange={e => setMcpHardLimit(e.target.value)} /></label>
                  <label className="text-sm"><span className="mb-1 block text-muted-foreground">{t('settings.performance.mcpSoftLimit')}</span><Input type="number" min={0} value={mcpSoftLimit} onChange={e => setMcpSoftLimit(e.target.value)} /></label>
                  <label className="text-sm"><span className="mb-1 block text-muted-foreground">{t('settings.performance.mcpMemoryHardLimit')}</span><Input type="number" min={0.1} step="0.1" value={mcpMemoryHardLimitGb} onChange={e => setMcpMemoryHardLimitGb(e.target.value)} /></label>
                  <Button onClick={() => void save()}>{t('settings.performance.save')}</Button>
                  {snapshot && <span className="text-sm text-muted-foreground">{t('settings.performance.warmCount', { count: snapshot.warmRuntimeCount })}</span>}
                </div>
                <div className="flex items-center justify-between border-t border-border/50 px-4 py-3">
                  <span className="text-sm text-muted-foreground">{snapshot ? `${t('settings.performance.mcpMemoryUsage')}: ${formatBytes(snapshot.mcpRuntime.memoryUsedBytes)} / ${formatBytes(snapshot.mcpRuntime.memoryHardLimitBytes)}` : ''}</span>
                  <Button variant="outline" size="sm" disabled={cleaningMcp} onClick={() => void clearIdleMcp()}><Trash2 className="mr-1.5 h-3.5 w-3.5" />{cleaningMcp ? t('settings.performance.clearIdleRunning') : t('settings.performance.clearIdle')}</Button>
                </div>
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title={t('settings.performance.analysisTitle')}>
              <SettingsCard>
                <div className="grid grid-cols-2 gap-3 p-4 text-sm md:grid-cols-6">
                  {([['rss', snapshot?.total.rssBytes], ['serverRss', snapshot?.total.serverRssBytes], ['heapUsed', snapshot?.total.heapUsedBytes], ['heapTotal', snapshot?.total.heapTotalBytes], ['external', snapshot?.total.externalBytes], ['arrayBuffers', snapshot?.total.arrayBuffersBytes]] as const).map(([key, value]) => <div key={key}><div className="text-muted-foreground">{t(`settings.performance.${key}`)}</div><div className="font-medium">{formatBytes(value)}</div></div>)}
                </div>
                {snapshot && <div className="grid grid-cols-2 gap-3 border-t border-border/50 p-4 text-sm md:grid-cols-6">
                  <div><div className="text-muted-foreground">{t('settings.performance.processes')}</div><div className="font-medium">{snapshot.total.processCount}</div></div>
                  <div><div className="text-muted-foreground">{t('settings.performance.agents')}</div><div className="font-medium">{snapshot.total.agentCount}</div></div>
                  <div><div className="text-muted-foreground">{t('settings.performance.mcpServices')}</div><div className="font-medium">{snapshot.total.mcpCount}</div></div>
                  <div><div className="text-muted-foreground">{t('settings.performance.mcpActive')}</div><div className="font-medium">{snapshot.mcpRuntime.activeCount}/{snapshot.mcpRuntime.hardLimit}</div></div>
                  <div><div className="text-muted-foreground">{t('settings.performance.mcpQueued')}</div><div className="font-medium">{snapshot.mcpRuntime.queuedCount}</div></div>
                  <div><div className="text-muted-foreground">{t('settings.performance.mcpMemoryUsage')}</div><div className="font-medium">{formatBytes(snapshot.mcpRuntime.memoryUsedBytes)} / {formatBytes(snapshot.mcpRuntime.memoryHardLimitBytes)}</div></div>
                </div>}
                <div className="border-t border-border/50">
                  <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-3 px-4 py-2 text-xs text-muted-foreground"><span>{t('settings.performance.kindLabel')}</span><span>{t('settings.performance.nameLabel')}</span><span>{t('settings.performance.statusLabel')}</span><span>PID</span><span>{t('settings.performance.memoryLabel')}</span></div>
                  {snapshot?.processes.map(item => <div key={item.id} className="grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-3 border-t border-border/40 px-4 py-2 text-sm"><Badge variant="secondary">{item.kind}</Badge><div className="min-w-0 truncate">{item.name}<div className="text-xs text-muted-foreground">{item.sourceSlug ?? item.sessionId ?? item.details ?? ''}</div></div><span className="text-xs text-muted-foreground">{item.status ?? t('settings.performance.unavailable')}</span><span className="text-xs">{item.pid ?? '—'}</span><span className="text-xs">{memoryLabel(item, t)}</span></div>)}
                </div>
                {snapshot && snapshot.total.unmeasuredProcessCount > 0 && <div className="border-t border-border/50 px-4 py-3 text-xs text-muted-foreground">{t('settings.performance.unmeasured', { count: snapshot.total.unmeasuredProcessCount })}</div>}
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title={t('settings.performance.leak.title')} description={t('settings.performance.leak.description')}>
              <SettingsCard>
                <div className="space-y-4 p-4">
                  <Button variant="outline" disabled={checkingLeak} onClick={() => void runLeakCheck()}><Activity className="mr-1.5 h-3.5 w-3.5" />{checkingLeak ? t('settings.performance.leak.running') : t('settings.performance.leak.run')}</Button>
                  {leakCheck && <div className="space-y-2 text-sm"><div className="flex items-center gap-2"><Badge variant={leakCheck.status === 'possible_leak' ? 'destructive' : 'secondary'}>{t(`settings.performance.leak.${leakCheck.status}`)}</Badge><span className="text-muted-foreground">{t('settings.performance.leak.samples', { count: leakCheck.sampleCount })}{!leakCheck.gcAvailable ? ` · ${t('settings.performance.leak.noGc')}` : ''}</span></div><div className="grid grid-cols-2 gap-3 md:grid-cols-4"><div><div className="text-muted-foreground">{t('settings.performance.leak.rssGrowth')}</div><div>{formatBytes(leakCheck.rssGrowthBytes)}</div></div><div><div className="text-muted-foreground">{t('settings.performance.leak.heapGrowth')}</div><div>{formatBytes(leakCheck.heapGrowthBytes)}</div></div><div><div className="text-muted-foreground">{t('settings.performance.leak.rssRate')}</div><div>{formatBytes(leakCheck.rssGrowthBytesPerMinute)}/min</div></div><div><div className="text-muted-foreground">{t('settings.performance.leak.heapRate')}</div><div>{formatBytes(leakCheck.heapGrowthBytesPerMinute)}/min</div></div></div></div>}
                </div>
              </SettingsCard>
            </SettingsSection>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
