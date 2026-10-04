import { toast } from 'sonner'
import { i18n } from '@craft-agent/shared/i18n'
import { getProviderRechargeTarget, isInsufficientBalanceError, TOKENNEST_RECHARGE_URL } from '@craft-agent/shared/utils/billing'
import { resolveEffectiveConnectionSlug, type LlmConnectionWithStatus } from '@config/llm-connections'

export const TOKENNEST_BALANCE_REFRESH_EVENT = 'tokenbird:tokennest-balance-refresh'
const pending = new Map<string, Promise<void>>()
const externalWallets = new Set<string>()

export function getRechargeConnection(
  connections: LlmConnectionWithStatus[], sessionConnection?: string, workspaceConnection?: string,
): LlmConnectionWithStatus | undefined {
  const slug = resolveEffectiveConnectionSlug(sessionConnection, workspaceConnection, connections)
  return connections.find(connection => connection.slug === slug && getProviderRechargeTarget(connection))
}

export function getTokenNestRechargeConnection(
  connections: LlmConnectionWithStatus[], sessionConnection?: string, workspaceConnection?: string,
): LlmConnectionWithStatus | undefined {
  const slug = resolveEffectiveConnectionSlug(sessionConnection, workspaceConnection, connections)
  return connections.find(connection => connection.slug === slug
    && connection.authType === 'oauth' && connection.oauthProvider === 'tokennest' && connection.isAuthenticated)
}

/** Coalesce repeated errors until the wallet closes, then refresh displayed balances. */
export function openTokenNestRecharge(connectionSlug: string): Promise<void> {
  const existing = pending.get(connectionSlug)
  if (existing) return existing
  const task = (async () => {
    try {
      const session = await window.electronAPI.getTokenNestRechargeUrl(connectionSlug)
      if (session.requiresWebsiteLogin) toast.info(i18n.t('settings.ai.tokenNestRechargeLogin'))
      try {
        if (!window.electronAPI.openTokenNestRecharge) throw new Error('Native recharge window unavailable')
        await window.electronAPI.openTokenNestRecharge(session.url, connectionSlug)
        window.dispatchEvent(new Event(TOKENNEST_BALANCE_REFRESH_EVENT))
      } catch {
        // Use the regular wallet in the browser: a one-time ticket may already have been consumed.
        await openRechargeWebsite(TOKENNEST_RECHARGE_URL)
        toast.info(i18n.t('settings.recharge.browserFallback'))
      }
    } catch {
      toast.error(i18n.t('settings.ai.tokenNestRechargeFailed'), {
        description: i18n.t('settings.recharge.failedDescription'),
      })
    }
  })()
  pending.set(connectionSlug, task)
  void task.finally(() => { pending.delete(connectionSlug) })
  return task
}

/** External wallets cannot signal payment completion; refresh when the user returns to the app. */
async function openRechargeWebsite(url: string): Promise<void> {
  if (externalWallets.has(url)) return
  externalWallets.add(url)
  const refresh = () => {
    externalWallets.delete(url)
    window.dispatchEvent(new Event(TOKENNEST_BALANCE_REFRESH_EVENT))
  }
  window.addEventListener('focus', refresh, { once: true })
  try { await window.electronAPI.openUrl(url) }
  catch (error) {
    externalWallets.delete(url)
    window.removeEventListener('focus', refresh)
    throw error
  }
}

export async function openConnectionRecharge(connection: LlmConnectionWithStatus): Promise<void> {
  if (connection.authType === 'oauth' && connection.oauthProvider === 'tokennest') {
    if (!connection.isAuthenticated) {
      toast.info(i18n.t('settings.recharge.signInRequired'))
      return
    }
    return openTokenNestRecharge(connection.slug)
  }
  const target = getProviderRechargeTarget(connection)
  if (!target) {
    toast.info(i18n.t('settings.recharge.unavailable'))
    return
  }
  try { await openRechargeWebsite(target.url) }
  catch { toast.error(i18n.t('settings.recharge.failed'), { description: i18n.t('settings.recharge.failedDescription') }) }
}

export function rechargeOnInsufficientBalance(error: unknown, connection?: LlmConnectionWithStatus): boolean {
  if (!connection?.isAuthenticated || !getProviderRechargeTarget(connection) || !isInsufficientBalanceError(error)) return false
  void openConnectionRecharge(connection)
  return true
}
