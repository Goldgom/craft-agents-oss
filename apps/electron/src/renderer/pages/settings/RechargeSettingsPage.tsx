import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, RefreshCw, WalletCards } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { getProviderRechargeTarget } from '@craft-agent/shared/utils/billing'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ConnectionIcon } from '@/components/icons/ConnectionIcon'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import { openConnectionRecharge, TOKENNEST_BALANCE_REFRESH_EVENT } from '@/lib/tokennest-recharge'
import type { DetailsPageMeta } from '@/lib/navigation-registry'

export const meta: DetailsPageMeta = { navigator: 'settings', slug: 'recharge' }
type ApiBalance = Awaited<ReturnType<typeof window.electronAPI.getLlmConnectionBalances>>[number]

function balanceText(balance: ApiBalance): string {
  if (balance.display) return balance.display
  if (balance.remaining === undefined) return '—'
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: balance.currency ?? 'USD', maximumFractionDigits: 4 }).format(balance.remaining) }
  catch { return `${balance.currency ?? 'USD'} ${balance.remaining}` }
}

export default function RechargeSettingsPage() {
  const { t } = useTranslation()
  const { llmConnections } = useAppShellContext()
  const [balances, setBalances] = useState<ApiBalance[]>([])
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [opening, setOpening] = useState<Set<string>>(new Set())
  const refreshBalances = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    try {
      setBalances(await window.electronAPI.getLlmConnectionBalances({ forceRefresh }))
      setLoadFailed(false)
    } catch { setLoadFailed(true) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    void refreshBalances()
    const refresh = () => { void refreshBalances(true) }
    window.addEventListener(TOKENNEST_BALANCE_REFRESH_EVENT, refresh)
    return () => window.removeEventListener(TOKENNEST_BALANCE_REFRESH_EVENT, refresh)
  }, [refreshBalances, llmConnections])

  return <div className="flex h-full flex-col">
    <PanelHeader title={t('settings.recharge.title')} actions={
      <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refreshBalances(true)}>
        <RefreshCw className={`mr-1.5 size-3.5 ${loading ? 'animate-spin' : ''}`} />
        {t('settings.recharge.refreshBalance')}
      </Button>
    } />
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-4xl space-y-5 px-6 py-8">
        <section className="flex items-start gap-4 rounded-2xl border border-primary/20 bg-primary/5 p-5">
          <WalletCards className="mt-0.5 size-7 shrink-0 text-primary" />
          <div>
            <h1 className="text-lg font-semibold">{t('settings.recharge.title')}</h1>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('settings.recharge.description')}</p>
          </div>
        </section>
        {loadFailed && <p role="status" className="text-sm text-muted-foreground">{t('settings.recharge.balanceUnavailable')}</p>}
        {llmConnections.length === 0 ? <div className="rounded-xl border border-dashed p-8 text-center">
          <p className="mb-4 text-sm text-muted-foreground">{t('settings.recharge.empty')}</p>
          <Button onClick={() => navigate(routes.view.settings('ai'))}>{t('settings.ai.title')}</Button>
        </div> : <div className="grid gap-4 md:grid-cols-2">
          {llmConnections.map(connection => {
            const target = getProviderRechargeTarget(connection)
            const balance = balances.find(item => item.connectionSlug === connection.slug)
            const requiresSignIn = connection.oauthProvider === 'tokennest' && connection.authType === 'oauth' && !connection.isAuthenticated
            return <section key={connection.slug} className="flex flex-col gap-4 rounded-xl border bg-background p-5">
              <div className="flex items-center gap-3">
                <ConnectionIcon connection={connection} size={24} />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-semibold">{connection.name}</h2>
                  {target && <p className="truncate text-xs text-muted-foreground">{new URL(target.websiteUrl).hostname}</p>}
                </div>
              </div>
              {balance && <div className="text-sm text-muted-foreground">{t('settings.ai.apiBalance')}: <span className="font-semibold text-foreground">{balanceText(balance)}</span></div>}
              <p className="flex-1 text-xs leading-5 text-muted-foreground">{t(!target ? 'settings.recharge.unavailable' : requiresSignIn ? 'settings.recharge.signInRequired' : target.inferred ? 'settings.recharge.inferredDescription' : connection.oauthProvider === 'tokennest' && connection.authType === 'oauth' ? 'settings.recharge.tokenNestDescription' : 'settings.recharge.providerDescription')}</p>
              <div className="flex flex-wrap items-center gap-2">
                {requiresSignIn ? <Button size="sm" onClick={() => navigate(routes.view.settings('ai'))}>{t('settings.ai.reAuthenticate')}</Button> : <Button size="sm" disabled={!target || opening.has(connection.slug)} onClick={() => {
                  setOpening(current => new Set(current).add(connection.slug))
                  void openConnectionRecharge(connection).finally(() => setOpening(current => {
                    const next = new Set(current); next.delete(connection.slug); return next
                  }))
                }}><WalletCards className="mr-1.5 size-3.5" />{t('settings.ai.tokenNestRecharge')}</Button>}
                {target && <Button size="sm" variant="outline" onClick={() => { void window.electronAPI.openUrl(target.websiteUrl) }}>
                  <ExternalLink className="mr-1.5 size-3.5" />{t('settings.recharge.website')}
                </Button>}
              </div>
            </section>
          })}
        </div>}
      </div>
    </ScrollArea>
  </div>
}
