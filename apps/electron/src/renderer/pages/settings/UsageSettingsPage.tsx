import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, RefreshCw, WalletCards } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SettingsCard, SettingsSection } from '@/components/settings'
import { useAppShellContext } from '@/context/AppShellContext'
import type { Session } from '../../../shared/types'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { TokenNestUsagePoint, TokenNestUsageSnapshot } from '@craft-agent/shared/protocol'

export const meta: DetailsPageMeta = { navigator: 'settings', slug: 'usage' }
type ApiBalance = Awaited<ReturnType<typeof window.electronAPI.getLlmConnectionBalances>>[number]

const formatTokens = (value: number) => new Intl.NumberFormat(undefined, { notation: value >= 1_000_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
const formatMoney = (value: number, currency = 'USD') => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 4 }).format(value) }
  catch { return `${currency} ${value.toFixed(4)}` }
}
const balanceText = (balance?: Pick<ApiBalance, 'display' | 'remaining' | 'currency'>) => balance?.display ?? (balance?.remaining === undefined ? '—' : formatMoney(balance.remaining, balance.currency))

function addPoint(map: Map<string, TokenNestUsagePoint>, key: string, usage: { input: number; output: number; total: number; cost: number }) {
  const point = map.get(key) ?? { key, label: key, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }
  point.requests += 1
  point.inputTokens += usage.input
  point.outputTokens += usage.output
  point.totalTokens += usage.total
  point.costUsd += usage.cost
  map.set(key, point)
}

export default function UsageSettingsPage() {
  const { t } = useTranslation()
  const { llmConnections, refreshLlmConnections } = useAppShellContext()
  const [sessions, setSessions] = useState<Session[]>([])
  const [balances, setBalances] = useState<ApiBalance[]>([])
  const [usage, setUsage] = useState<Record<string, TokenNestUsageSnapshot>>({})
  const [usageErrors, setUsageErrors] = useState<Record<string, string>>({})
  const [selectedSlug, setSelectedSlug] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshingSlug, setRefreshingSlug] = useState<string | null>(null)

  const tokenNestConnections = useMemo(() => llmConnections.filter(c => c.oauthProvider === 'tokennest' && c.isAuthenticated), [llmConnections])
  const activeSlug = tokenNestConnections.some(c => c.slug === selectedSlug) ? selectedSlug : tokenNestConnections[0]?.slug ?? ''
  const activeUsage = usage[activeSlug]

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [nextSessions, nextBalances] = await Promise.all([window.electronAPI.getSessions(), window.electronAPI.getLlmConnectionBalances()])
      setSessions(nextSessions.filter(session => !session.hidden))
      setBalances(nextBalances)
      const results = await Promise.all(tokenNestConnections.map(async connection => {
        try { return { slug: connection.slug, snapshot: await window.electronAPI.getTokenNestUsage({ connectionSlug: connection.slug, days: 30 }) } }
        catch (error) { return { slug: connection.slug, error: error instanceof Error ? error.message : String(error) } }
      }))
      const nextUsage: Record<string, TokenNestUsageSnapshot> = {}
      const nextErrors: Record<string, string> = {}
      for (const result of results) {
        if ('snapshot' in result && result.snapshot) nextUsage[result.slug] = result.snapshot
        else if ('error' in result && result.error) nextErrors[result.slug] = result.error
      }
      setUsage(nextUsage)
      setUsageErrors(nextErrors)
    } catch (error) {
      toast.error(t('settings.usage.loadFailed'), { description: error instanceof Error ? error.message : String(error) })
    } finally { setLoading(false) }
  }, [t, tokenNestConnections])
  useEffect(() => { void load() }, [load])

  const local = useMemo(() => {
    const totals = { input: 0, output: 0, total: 0, cost: 0 }
    const daily = new Map<string, TokenNestUsagePoint>()
    const byModel = new Map<string, TokenNestUsagePoint>()
    for (const session of sessions) {
      const item = { input: session.tokenUsage?.inputTokens ?? 0, output: session.tokenUsage?.outputTokens ?? 0, total: session.tokenUsage?.totalTokens ?? ((session.tokenUsage?.inputTokens ?? 0) + (session.tokenUsage?.outputTokens ?? 0)), cost: session.tokenUsage?.costUsd ?? 0 }
      totals.input += item.input; totals.output += item.output; totals.total += item.total; totals.cost += item.cost
      if (item.total <= 0) continue
      addPoint(daily, new Date(session.lastMessageAt).toISOString().slice(0, 10), item)
      addPoint(byModel, session.model || t('settings.usage.unknownModel'), item)
    }
    return { totals, daily: [...daily.values()].sort((a, b) => a.key.localeCompare(b.key)).slice(-30), byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens) }
  }, [sessions, t])
  const localRecords = useMemo(() => [...sessions].filter(s => (s.tokenUsage?.totalTokens ?? 0) > 0).sort((a, b) => b.lastMessageAt - a.lastMessageAt).slice(0, 50), [sessions])

  const refreshConnection = async (slug: string) => {
    setRefreshingSlug(slug)
    try {
      const result = await window.electronAPI.refreshLlmConnectionModels(slug)
      if (!result.success) throw new Error(result.error || t('settings.usage.refreshFailed'))
      await refreshLlmConnections(); await load(); toast.success(t('settings.usage.refreshSucceeded'))
    } catch (error) { toast.error(t('settings.usage.refreshFailed'), { description: error instanceof Error ? error.message : String(error) }) }
    finally { setRefreshingSlug(null) }
  }
  const changeGroup = async (slug: string, channelGroup: string) => {
    const connection = tokenNestConnections.find(item => item.slug === slug)
    const group = connection?.channelGroups?.find(item => item.id === channelGroup)
    if (!connection || !group) return
    const defaultModel = !group.models?.length || (connection.defaultModel && group.models.includes(connection.defaultModel)) ? connection.defaultModel : group.models[0]
    const result = await window.electronAPI.saveLlmConnection({ ...connection, channelGroup, defaultModel })
    if (!result.success) return void toast.error(t('settings.ai.channelGroupUpdateFailed'), { description: result.error })
    await refreshLlmConnections(); toast.success(t('settings.usage.groupUpdated'))
  }
  const openTokenNest = (path: string) => { void window.electronAPI.openUrl(`https://openai.goldgom.top${path}`) }
  const shownTotals = activeUsage ? { input: activeUsage.inputTokens, output: activeUsage.outputTokens, total: activeUsage.totalTokens, cost: activeUsage.costUsd } : local.totals

  return <div className="flex h-full flex-col">
    <PanelHeader title={t('settings.usage.title')} actions={<Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}><RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />{t('common.refresh')}</Button>} />
    <div className="min-h-0 flex-1"><ScrollArea className="h-full"><div className="mx-auto max-w-5xl space-y-7 px-5 py-7">
      <SettingsSection title={t('settings.usage.tokenNestTitle')} description={t('settings.usage.tokenNestDescription')}><SettingsCard>
        {tokenNestConnections.length === 0 ? <div className="px-4 py-5 text-sm text-muted-foreground">{t('settings.usage.tokenNestSignInRequired')}</div> : tokenNestConnections.map(connection => {
          const balance = balances.find(item => item.connectionSlug === connection.slug) ?? usage[connection.slug]?.balance
          return <div key={connection.slug} className="flex flex-wrap items-center gap-3 px-4 py-4">
            <WalletCards className="h-5 w-5 text-muted-foreground" />
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelectedSlug(connection.slug)}><div className="text-sm font-medium">{connection.name}</div><div className="text-xs text-muted-foreground">{t('settings.usage.balance')}: {balanceText(balance)}</div>{usageErrors[connection.slug] && <div className="mt-1 text-xs text-destructive">{usageErrors[connection.slug]}</div>}</button>
            {(connection.channelGroups?.length ?? 0) > 0 && <label className="flex items-center gap-2 text-xs text-muted-foreground">{t('settings.ai.channelGroup')}<select className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground" value={connection.channelGroup ?? connection.channelGroups?.[0]?.id ?? ''} onChange={event => void changeGroup(connection.slug, event.target.value)}>{connection.channelGroups?.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>}
            <Button variant="outline" size="sm" disabled={refreshingSlug === connection.slug} onClick={() => void refreshConnection(connection.slug)}><RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshingSlug === connection.slug ? 'animate-spin' : ''}`} />{t('settings.usage.refreshModelsAndGroups')}</Button>
            <Badge variant={activeSlug === connection.slug ? 'default' : 'secondary'}>OAuth</Badge>
          </div>
        })}
        {tokenNestConnections.length > 0 && <div className="flex flex-wrap gap-2 px-4 py-3"><Button variant="outline" size="sm" onClick={() => openTokenNest('/usage-logs')}>{t('settings.usage.onlineRecords')}<ExternalLink className="ml-1.5 h-3.5 w-3.5" /></Button><Button variant="outline" size="sm" onClick={() => openTokenNest('/wallet')}>{t('settings.usage.onlineBalance')}<ExternalLink className="ml-1.5 h-3.5 w-3.5" /></Button><Button variant="outline" size="sm" onClick={() => openTokenNest('/wallet')}>{t('settings.usage.invoiceInfo')}<ExternalLink className="ml-1.5 h-3.5 w-3.5" /></Button></div>}
      </SettingsCard></SettingsSection>

      <UsageDashboard title={activeUsage ? t('settings.usage.providerTitle') : t('settings.usage.localTitle')} description={activeUsage ? `${t('settings.usage.providerDescription')}${activeUsage.truncated ? ` ${t('settings.usage.chartTruncated')}` : ''}` : t('settings.usage.localDescription')} totals={shownTotals} currency={activeUsage?.currency ?? 'USD'} daily={activeUsage?.daily ?? local.daily} byModel={activeUsage?.byModel ?? local.byModel} t={t} />

      <SettingsSection title={t('settings.usage.recordsTitle')} description={activeUsage ? t('settings.usage.providerRecordsDescription') : t('settings.usage.recordsDescription')}><SettingsCard divided={false}>
        {activeUsage ? activeUsage.recentRecords.length === 0 ? <EmptyRecords text={t('settings.usage.noRecords')} /> : <div className="divide-y divide-border/50">{activeUsage.recentRecords.map(record => <UsageRecord key={`${record.timestamp}-${record.requestId}`} title={record.model || '—'} subtitle={`${record.group || '—'} · ${new Date(record.timestamp * 1000).toLocaleString()}`} tokens={record.totalTokens} cost={formatMoney(record.costUsd, activeUsage.currency)} />)}</div>
          : localRecords.length === 0 ? <EmptyRecords text={t('settings.usage.noRecords')} /> : <div className="divide-y divide-border/50">{localRecords.map(session => <UsageRecord key={session.id} title={session.name || session.preview || t('settings.usage.untitledSession')} subtitle={`${session.model || '—'} · ${new Date(session.lastMessageAt).toLocaleString()}`} tokens={session.tokenUsage?.totalTokens ?? 0} cost={formatMoney(session.tokenUsage?.costUsd ?? 0)} />)}</div>}
      </SettingsCard></SettingsSection>
    </div></ScrollArea></div>
  </div>
}

function UsageDashboard({ title, description, totals, currency, daily, byModel, t }: { title: string; description: string; totals: { input: number; output: number; total: number; cost: number }; currency: string; daily: TokenNestUsagePoint[]; byModel: TokenNestUsagePoint[]; t: ReturnType<typeof useTranslation>['t'] }) {
  return <><SettingsSection title={title} description={description}><SettingsCard divided={false}><div className="grid grid-cols-2 gap-4 p-4 md:grid-cols-4"><Metric label={t('settings.usage.totalTokens')} value={formatTokens(totals.total)} /><Metric label={t('settings.usage.inputTokens')} value={formatTokens(totals.input)} /><Metric label={t('settings.usage.outputTokens')} value={formatTokens(totals.output)} /><Metric label={t('settings.usage.estimatedCost')} value={formatMoney(totals.cost, currency)} /></div></SettingsCard></SettingsSection><div className="grid gap-7 lg:grid-cols-2"><SettingsSection title={t('settings.usage.dailyTitle')} description={t('settings.usage.last30Days')}><SettingsCard divided={false}><UsageBars points={daily} empty={t('settings.usage.noRecords')} /></SettingsCard></SettingsSection><SettingsSection title={t('settings.usage.byModelTitle')} description={t('settings.usage.byModelDescription')}><SettingsCard divided={false}><UsageBars points={byModel.slice(0, 10)} empty={t('settings.usage.noRecords')} /></SettingsCard></SettingsSection></div></>
}
function UsageBars({ points, empty }: { points: TokenNestUsagePoint[]; empty: string }) {
  const max = Math.max(1, ...points.map(point => point.totalTokens))
  if (!points.length) return <div className="p-6 text-center text-sm text-muted-foreground">{empty}</div>
  return <div className="space-y-3 p-4">{points.map(point => <div key={point.key} className="grid grid-cols-[minmax(5rem,0.7fr)_minmax(7rem,2fr)_auto] items-center gap-3 text-xs"><div className="truncate text-muted-foreground" title={point.label}>{point.label}</div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, point.totalTokens / max * 100)}%` }} /></div><div className="w-16 text-right font-medium tabular-nums">{formatTokens(point.totalTokens)}</div></div>)}</div>
}
function UsageRecord({ title, subtitle, tokens, cost }: { title: string; subtitle: string; tokens: number; cost: string }) { return <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 px-4 py-3 text-sm"><div className="min-w-0"><div className="truncate font-medium">{title}</div><div className="truncate text-xs text-muted-foreground">{subtitle}</div></div><div className="text-right"><div>{formatTokens(tokens)}</div><div className="text-xs text-muted-foreground">{cost}</div></div></div> }
function EmptyRecords({ text }: { text: string }) { return <div className="px-4 py-6 text-center text-sm text-muted-foreground">{text}</div> }
function Metric({ label, value }: { label: string; value: string }) { return <div><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-lg font-semibold">{value}</div></div> }
