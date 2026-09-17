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

export const meta: DetailsPageMeta = { navigator: 'settings', slug: 'usage' }

type ApiBalance = Awaited<ReturnType<typeof window.electronAPI.getLlmConnectionBalances>>[number]

const formatTokens = (value: number) => new Intl.NumberFormat().format(value)
const formatMoney = (value: number, currency = 'USD') => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 4 }).format(value)
  } catch {
    return `${currency} ${value.toFixed(4)}`
  }
}

function balanceText(balance: ApiBalance | undefined): string {
  if (!balance) return '—'
  if (balance.display) return balance.display
  if (balance.remaining === undefined) return '—'
  return formatMoney(balance.remaining, balance.currency)
}

export default function UsageSettingsPage() {
  const { t } = useTranslation()
  const { llmConnections } = useAppShellContext()
  const [sessions, setSessions] = useState<Session[]>([])
  const [balances, setBalances] = useState<ApiBalance[]>([])
  const [loading, setLoading] = useState(true)

  const tokenNestConnections = useMemo(
    () => llmConnections.filter(connection => connection.oauthProvider === 'tokennest' && connection.isAuthenticated),
    [llmConnections],
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [nextSessions, showBalances] = await Promise.all([
        window.electronAPI.getSessions(),
        window.electronAPI.getShowApiBalances(),
      ])
      setSessions(nextSessions.filter(session => !session.hidden))
      setBalances(showBalances ? await window.electronAPI.getLlmConnectionBalances() : [])
    } catch (error) {
      toast.error(t('settings.usage.loadFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { void load() }, [load])

  const totals = useMemo(() => sessions.reduce((sum, session) => {
    const usage = session.tokenUsage
    sum.input += usage?.inputTokens ?? 0
    sum.output += usage?.outputTokens ?? 0
    sum.total += usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0))
    sum.cost += usage?.costUsd ?? 0
    return sum
  }, { input: 0, output: 0, total: 0, cost: 0 }), [sessions])

  const records = useMemo(() => [...sessions]
    .filter(session => (session.tokenUsage?.totalTokens ?? 0) > 0)
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    .slice(0, 50), [sessions])

  const openTokenNest = (path: string) => {
    void window.electronAPI.openUrl(`https://openai.goldgom.top${path}`)
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title={t('settings.usage.title')}
        actions={<Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />{t('common.refresh')}</Button>}
      />
      <div className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-4xl space-y-7 px-5 py-7">
            <SettingsSection title={t('settings.usage.localTitle')} description={t('settings.usage.localDescription')}>
              <SettingsCard divided={false}>
                <div className="grid grid-cols-2 gap-4 p-4 md:grid-cols-4">
                  <Metric label={t('settings.usage.totalTokens')} value={formatTokens(totals.total)} />
                  <Metric label={t('settings.usage.inputTokens')} value={formatTokens(totals.input)} />
                  <Metric label={t('settings.usage.outputTokens')} value={formatTokens(totals.output)} />
                  <Metric label={t('settings.usage.estimatedCost')} value={formatMoney(totals.cost)} />
                </div>
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title={t('settings.usage.tokenNestTitle')} description={t('settings.usage.tokenNestDescription')}>
              <SettingsCard>
                {tokenNestConnections.length === 0 ? (
                  <div className="px-4 py-5 text-sm text-muted-foreground">{t('settings.usage.tokenNestSignInRequired')}</div>
                ) : tokenNestConnections.map(connection => {
                  const balance = balances.find(item => item.connectionSlug === connection.slug)
                  return (
                    <div key={connection.slug} className="flex flex-wrap items-center gap-3 px-4 py-4">
                      <WalletCards className="h-5 w-5 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{connection.name}</div>
                        <div className="text-xs text-muted-foreground">{t('settings.usage.balance')}: {balanceText(balance)}</div>
                      </div>
                      <Badge variant="secondary">OAuth</Badge>
                    </div>
                  )
                })}
                {tokenNestConnections.length > 0 && (
                  <div className="flex flex-wrap gap-2 px-4 py-3">
                    <Button variant="outline" size="sm" onClick={() => openTokenNest('/usage-logs')}>{t('settings.usage.onlineRecords')}<ExternalLink className="ml-1.5 h-3.5 w-3.5" /></Button>
                    <Button variant="outline" size="sm" onClick={() => openTokenNest('/wallet')}>{t('settings.usage.onlineBalance')}<ExternalLink className="ml-1.5 h-3.5 w-3.5" /></Button>
                    <Button variant="outline" size="sm" onClick={() => openTokenNest('/wallet')}>{t('settings.usage.invoiceInfo')}<ExternalLink className="ml-1.5 h-3.5 w-3.5" /></Button>
                  </div>
                )}
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title={t('settings.usage.recordsTitle')} description={t('settings.usage.recordsDescription')}>
              <SettingsCard divided={false}>
                {records.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">{t('settings.usage.noRecords')}</div>
                ) : (
                  <div className="divide-y divide-border/50">
                    {records.map(session => (
                      <div key={session.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 px-4 py-3 text-sm">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{session.name || session.preview || t('settings.usage.untitledSession')}</div>
                          <div className="truncate text-xs text-muted-foreground">{session.model || '—'} · {new Date(session.lastMessageAt).toLocaleString()}</div>
                        </div>
                        <div className="text-right">
                          <div>{formatTokens(session.tokenUsage?.totalTokens ?? 0)}</div>
                          <div className="text-xs text-muted-foreground">{formatMoney(session.tokenUsage?.costUsd ?? 0)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </SettingsCard>
            </SettingsSection>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-lg font-semibold">{value}</div></div>
}
