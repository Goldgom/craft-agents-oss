import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, BarChart3, CalendarDays, CircleDollarSign, Coins, ExternalLink, Inbox, RefreshCw, ServerCog, Sparkles, WalletCards } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import tokenNestLogo from '@/assets/provider-icons/tokennest.png'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SettingsCard, SettingsSection } from '@/components/settings'
import { useAppShellContext } from '@/context/AppShellContext'
import { cn } from '@/lib/utils'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { TokenNestUsagePoint, TokenNestUsageSnapshot } from '@craft-agent/shared/protocol'
import type { Session } from '../../../shared/types'

export const meta: DetailsPageMeta = { navigator: 'settings', slug: 'usage' }
type ApiBalance = Awaited<ReturnType<typeof window.electronAPI.getLlmConnectionBalances>>[number]

const formatTokens = (value: number) => new Intl.NumberFormat(undefined, { notation: value >= 1_000_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
const formatMoney = (value: number, currency = 'USD') => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 4 }).format(value) }
  catch { return `${currency} ${value.toFixed(4)}` }
}
const balanceText = (balance?: Pick<ApiBalance, 'display' | 'remaining' | 'currency'>) => balance?.display ?? (balance?.remaining === undefined ? '—' : formatMoney(balance.remaining, balance.currency))
const isMissingUsageHandler = (message: string) => message.includes('No handler for: tokennest:getUsage') || message.includes('CHANNEL_NOT_FOUND')

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

  const tokenNestConnections = useMemo(() => llmConnections.filter(connection => connection.oauthProvider === 'tokennest' && connection.isAuthenticated), [llmConnections])
  const activeSlug = tokenNestConnections.some(connection => connection.slug === selectedSlug) ? selectedSlug : tokenNestConnections[0]?.slug ?? ''
  const activeUsage = usage[activeSlug]
  const activeError = usageErrors[activeSlug]

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
      const item = {
        input: session.tokenUsage?.inputTokens ?? 0,
        output: session.tokenUsage?.outputTokens ?? 0,
        total: session.tokenUsage?.totalTokens ?? ((session.tokenUsage?.inputTokens ?? 0) + (session.tokenUsage?.outputTokens ?? 0)),
        cost: session.tokenUsage?.costUsd ?? 0,
      }
      totals.input += item.input; totals.output += item.output; totals.total += item.total; totals.cost += item.cost
      if (item.total <= 0) continue
      addPoint(daily, new Date(session.lastMessageAt).toISOString().slice(0, 10), item)
      addPoint(byModel, session.model || t('settings.usage.unknownModel'), item)
    }
    return { totals, daily: [...daily.values()].sort((a, b) => a.key.localeCompare(b.key)).slice(-30), byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens) }
  }, [sessions, t])
  const localRecords = useMemo(() => [...sessions].filter(session => (session.tokenUsage?.totalTokens ?? 0) > 0).sort((a, b) => b.lastMessageAt - a.lastMessageAt).slice(0, 50), [sessions])

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
    await refreshLlmConnections(); await load(); toast.success(t('settings.usage.groupUpdated'))
  }
  const openTokenNest = (path: string) => { void window.electronAPI.openUrl(`https://openai.goldgom.top${path}`) }
  const shownTotals = activeUsage ? { input: activeUsage.inputTokens, output: activeUsage.outputTokens, total: activeUsage.totalTokens, cost: activeUsage.costUsd } : local.totals

  return <div className="flex h-full flex-col bg-muted/10">
    <PanelHeader title={t('settings.usage.title')} actions={<Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}><RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />{t('common.refresh')}</Button>} />
    <div className="min-h-0 flex-1"><ScrollArea className="h-full"><div className="mx-auto max-w-6xl space-y-8 px-5 py-7 lg:px-8">
      <section className="relative overflow-hidden rounded-2xl border border-accent/15 bg-gradient-to-br from-accent/[0.09] via-background to-background p-5 shadow-xs md:p-6">
        <div className="pointer-events-none absolute -right-16 -top-20 size-56 rounded-full bg-accent/10 blur-3xl" />
        <div className="relative flex flex-col gap-5">
          <div className="flex items-start gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-white shadow-xs ring-1 ring-black/5"><img src={tokenNestLogo} alt="TokenNest" className="size-9 object-contain" /></div>
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold tracking-tight">{t('settings.usage.tokenNestTitle')}</h2><Badge variant="secondary" className="gap-1 rounded-full px-2 font-normal"><span className="size-1.5 rounded-full bg-emerald-500" />OAuth</Badge></div><p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{t('settings.usage.tokenNestDescription')}</p></div>
          </div>
          {tokenNestConnections.length === 0 ? <div className="flex items-center gap-3 rounded-xl border border-dashed bg-background/70 px-4 py-5 text-sm text-muted-foreground"><ServerCog className="size-5 shrink-0" />{t('settings.usage.tokenNestSignInRequired')}</div> : <div className="grid gap-3 xl:grid-cols-2">{tokenNestConnections.map(connection => {
            const balance = balances.find(item => item.connectionSlug === connection.slug) ?? usage[connection.slug]?.balance
            const selected = activeSlug === connection.slug
            return <div key={connection.slug} role="button" tabIndex={0} onClick={() => setSelectedSlug(connection.slug)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setSelectedSlug(connection.slug) }} className={cn('group rounded-xl border bg-background/90 p-4 transition-colors', selected ? 'border-accent/35 shadow-xs ring-1 ring-accent/10' : 'border-border/70 hover:border-accent/25')}>
              <div className="flex items-start gap-3"><div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent"><WalletCards className="size-5" /></div><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><div className="truncate text-sm font-semibold">{connection.name}</div>{selected && <span className="size-2 shrink-0 rounded-full bg-accent ring-4 ring-accent/10" />}</div><div className="mt-1 text-xs text-muted-foreground">{t('settings.usage.balance')}</div><div className="mt-0.5 text-xl font-semibold tracking-tight tabular-nums">{balanceText(balance)}</div></div></div>
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3" onClick={event => event.stopPropagation()}>
                {(connection.channelGroups?.length ?? 0) > 0 && <label className="flex h-8 items-center gap-2 rounded-md border bg-muted/30 px-2 text-xs text-muted-foreground">{t('settings.ai.channelGroup')}<select className="max-w-36 bg-transparent text-sm font-medium text-foreground outline-none" value={connection.channelGroup ?? connection.channelGroups?.[0]?.id ?? ''} onChange={event => void changeGroup(connection.slug, event.target.value)}>{connection.channelGroups?.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>}
                <Button variant="ghost" size="sm" className="ml-auto h-8" disabled={refreshingSlug === connection.slug} onClick={() => void refreshConnection(connection.slug)}><RefreshCw className={cn('mr-1.5 size-3.5', refreshingSlug === connection.slug && 'animate-spin')} />{t('settings.usage.refreshModelsAndGroups')}</Button>
              </div>
            </div>
          })}</div>}
          {tokenNestConnections.length > 0 && <div className="flex flex-wrap gap-2"><PortalButton icon={BarChart3} onClick={() => openTokenNest('/usage-logs')}>{t('settings.usage.onlineRecords')}</PortalButton><PortalButton icon={WalletCards} onClick={() => openTokenNest('/wallet')}>{t('settings.usage.onlineBalance')}</PortalButton><PortalButton icon={CircleDollarSign} onClick={() => openTokenNest('/wallet')}>{t('settings.usage.invoiceInfo')}</PortalButton></div>}
        </div>
      </section>

      {activeError && <div className={cn('flex items-start gap-3 rounded-xl border px-4 py-3 text-sm', isMissingUsageHandler(activeError) ? 'border-amber-500/20 bg-amber-500/[0.07] text-amber-700 dark:text-amber-300' : 'border-destructive/20 bg-destructive/[0.06] text-destructive')}><ServerCog className="mt-0.5 size-4 shrink-0" /><div><div className="font-medium">{t('settings.usage.syncUnavailable')}</div><div className="mt-0.5 text-xs opacity-80">{isMissingUsageHandler(activeError) ? t('settings.usage.syncUnavailableDescription') : activeError}</div></div></div>}

      <UsageDashboard title={activeUsage ? t('settings.usage.providerTitle') : t('settings.usage.localTitle')} description={activeUsage ? `${t('settings.usage.providerDescription')}${activeUsage.truncated ? ` ${t('settings.usage.chartTruncated')}` : ''}` : t('settings.usage.localDescription')} totals={shownTotals} currency={activeUsage?.currency ?? 'USD'} daily={activeUsage?.daily ?? local.daily} byModel={activeUsage?.byModel ?? local.byModel} t={t} />

      <SettingsSection title={t('settings.usage.recordsTitle')} description={activeUsage ? t('settings.usage.providerRecordsDescription') : t('settings.usage.recordsDescription')}><SettingsCard divided={false} className="border border-border/60 shadow-xs">
        {activeUsage ? activeUsage.recentRecords.length === 0 ? <EmptyRecords text={t('settings.usage.noRecords')} /> : <div className="divide-y divide-border/50">{activeUsage.recentRecords.map(record => <UsageRecord key={`${record.timestamp}-${record.requestId}`} title={record.model || '—'} subtitle={`${record.group || '—'} · ${new Date(record.timestamp * 1000).toLocaleString()}`} tokens={record.totalTokens} cost={formatMoney(record.costUsd, activeUsage.currency)} />)}</div>
          : localRecords.length === 0 ? <EmptyRecords text={t('settings.usage.noRecords')} /> : <div className="divide-y divide-border/50">{localRecords.map(session => <UsageRecord key={session.id} title={session.name || session.preview || t('settings.usage.untitledSession')} subtitle={`${session.model || '—'} · ${new Date(session.lastMessageAt).toLocaleString()}`} tokens={session.tokenUsage?.totalTokens ?? 0} cost={formatMoney(session.tokenUsage?.costUsd ?? 0)} />)}</div>}
      </SettingsCard></SettingsSection>
    </div></ScrollArea></div>
  </div>
}

function PortalButton({ icon: Icon, children, onClick }: { icon: typeof BarChart3; children: React.ReactNode; onClick: () => void }) { return <Button variant="outline" size="sm" className="bg-background/75" onClick={onClick}><Icon className="mr-1.5 size-3.5 text-muted-foreground" />{children}<ExternalLink className="ml-1.5 size-3 text-muted-foreground" /></Button> }

function UsageDashboard({ title, description, totals, currency, daily, byModel, t }: { title: string; description: string; totals: { input: number; output: number; total: number; cost: number }; currency: string; daily: TokenNestUsagePoint[]; byModel: TokenNestUsagePoint[]; t: ReturnType<typeof useTranslation>['t'] }) {
  return <div className="space-y-8"><SettingsSection title={title} description={description}><div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Metric icon={Coins} label={t('settings.usage.totalTokens')} value={formatTokens(totals.total)} tone="primary" /><Metric icon={ArrowUpRight} label={t('settings.usage.inputTokens')} value={formatTokens(totals.input)} tone="blue" /><Metric icon={Sparkles} label={t('settings.usage.outputTokens')} value={formatTokens(totals.output)} tone="violet" /><Metric icon={CircleDollarSign} label={t('settings.usage.estimatedCost')} value={formatMoney(totals.cost, currency)} tone="emerald" /></div></SettingsSection><div className="grid gap-7 lg:grid-cols-[1.15fr_0.85fr]"><SettingsSection title={t('settings.usage.dailyTitle')} description={t('settings.usage.last30Days')}><SettingsCard divided={false} className="border border-border/60 shadow-xs"><DailyChart points={daily} empty={t('settings.usage.noRecords')} /></SettingsCard></SettingsSection><SettingsSection title={t('settings.usage.byModelTitle')} description={t('settings.usage.byModelDescription')}><SettingsCard divided={false} className="border border-border/60 shadow-xs"><UsageBars points={byModel.slice(0, 8)} empty={t('settings.usage.noRecords')} /></SettingsCard></SettingsSection></div></div>
}
function DailyChart({ points, empty }: { points: TokenNestUsagePoint[]; empty: string }) {
  if (!points.length) return <EmptyChart text={empty} />
  const safePoints = points.map(point => ({ ...point, totalTokens: Number.isFinite(point.totalTokens) ? Math.max(0, point.totalTokens) : 0 }))
  const max = Math.max(1, ...safePoints.map(point => point.totalTokens))
  const chartPoints = safePoints.map((point, index) => ({
    ...point,
    x: safePoints.length === 1 ? 50 : (index / (safePoints.length - 1)) * 100,
    y: 10 + (1 - point.totalTokens / max) * 78,
  }))
  const linePath = chartPoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
  const areaPath = `${linePath} L ${chartPoints.at(-1)?.x ?? 100} 90 L ${chartPoints[0]?.x ?? 0} 90 Z`

  return <div className="p-5">
    <div className="relative h-44 border-b border-border/60" role="img" aria-label={safePoints.map(point => `${point.label}: ${formatTokens(point.totalTokens)}`).join(', ')}>
      <div className="pointer-events-none absolute inset-x-0 top-[10%] border-t border-dashed border-border/40" />
      <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-border/30" />
      <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="daily-usage-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#daily-usage-area)" />
        <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      {chartPoints.map((point, index) => {
        const tooltipSide = index === 0 ? 'left-0' : index === chartPoints.length - 1 ? 'right-0' : 'left-1/2 -translate-x-1/2'
        const tooltipPosition = point.y < 32 ? 'top-full mt-2' : 'bottom-full mb-2'
        return <div key={point.key} className="group absolute z-10 size-5 -translate-x-1/2 -translate-y-1/2 outline-none" style={{ left: `${point.x}%`, top: `${point.y}%` }} tabIndex={0} aria-label={`${point.label}: ${formatTokens(point.totalTokens)}`}>
          <span className="absolute left-1/2 top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-accent shadow-xs transition-transform group-hover:scale-125 group-focus-visible:scale-125" />
          <span className={cn('pointer-events-none absolute hidden whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-modal-small group-hover:block group-focus-visible:block', tooltipSide, tooltipPosition)}>
            <span className="block">{point.label}</span><span className="block font-semibold tabular-nums">{formatTokens(point.totalTokens)}</span>
          </span>
        </div>
      })}
    </div>
    <div className="mt-2 flex justify-between text-[11px] text-muted-foreground"><span>{safePoints[0]?.label}</span>{safePoints.length > 2 && <span>{safePoints[Math.floor(safePoints.length / 2)]?.label}</span>}<span>{safePoints.at(-1)?.label}</span></div>
  </div>
}
function UsageBars({ points, empty }: { points: TokenNestUsagePoint[]; empty: string }) {
  const max = Math.max(1, ...points.map(point => point.totalTokens))
  if (!points.length) return <EmptyChart text={empty} />
  return <div className="space-y-4 p-5">{points.map((point, index) => <div key={point.key} className="space-y-1.5"><div className="flex items-center gap-3 text-xs"><span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold text-muted-foreground">{index + 1}</span><span className="min-w-0 flex-1 truncate font-medium" title={point.label}>{point.label}</span><span className="shrink-0 font-semibold tabular-nums">{formatTokens(point.totalTokens)}</span></div><div className="ml-8 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-accent/80" style={{ width: `${Math.max(2, point.totalTokens / max * 100)}%` }} /></div></div>)}</div>
}
function UsageRecord({ title, subtitle, tokens, cost }: { title: string; subtitle: string; tokens: number; cost: string }) { return <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3.5 text-sm transition-colors hover:bg-muted/30"><div className="flex size-9 items-center justify-center rounded-full bg-muted/70 text-muted-foreground"><BarChart3 className="size-4" /></div><div className="min-w-0"><div className="truncate font-medium">{title}</div><div className="truncate text-xs text-muted-foreground">{subtitle}</div></div><div className="text-right"><div className="font-medium tabular-nums">{formatTokens(tokens)}</div><div className="text-xs text-muted-foreground">{cost}</div></div></div> }
function EmptyChart({ text }: { text: string }) { return <div className="flex min-h-48 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground"><CalendarDays className="size-6 opacity-50" />{text}</div> }
function EmptyRecords({ text }: { text: string }) { return <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground"><Inbox className="size-6 opacity-50" />{text}</div> }

const metricTones = { primary: 'bg-accent/10 text-accent', blue: 'bg-blue-500/10 text-blue-600 dark:text-blue-400', violet: 'bg-violet-500/10 text-violet-600 dark:text-violet-400', emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' }
function Metric({ icon: Icon, label, value, tone }: { icon: typeof Coins; label: string; value: string; tone: keyof typeof metricTones }) { return <div className="rounded-xl border border-border/60 bg-background p-4 shadow-xs"><div className={cn('flex size-9 items-center justify-center rounded-lg', metricTones[tone])}><Icon className="size-4" /></div><div className="mt-4 text-xs text-muted-foreground">{label}</div><div className="mt-1 text-xl font-semibold tracking-tight tabular-nums">{value}</div></div> }
