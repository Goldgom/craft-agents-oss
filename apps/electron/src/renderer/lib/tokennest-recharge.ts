import { toast } from 'sonner'
import { i18n } from '@craft-agent/shared/i18n'
import { isInsufficientBalanceError } from '@craft-agent/shared/utils/billing'
import { resolveEffectiveConnectionSlug, type LlmConnectionWithStatus } from '@config/llm-connections'

export const TOKENNEST_BALANCE_REFRESH_EVENT = 'tokenbird:tokennest-balance-refresh'
let pending: Promise<void> | null = null

export function getTokenNestRechargeConnection(
  connections: LlmConnectionWithStatus[], sessionConnection?: string, workspaceConnection?: string,
): LlmConnectionWithStatus | undefined {
  const slug = resolveEffectiveConnectionSlug(sessionConnection, workspaceConnection, connections)
  return connections.find(connection => connection.slug === slug
    && connection.authType === 'oauth' && connection.oauthProvider === 'tokennest' && connection.isAuthenticated)
}

/** Coalesce repeated errors until the wallet closes, then refresh displayed balances. */
export function openTokenNestRecharge(connectionSlug: string): Promise<void> {
  if (pending) return pending
  pending = (async () => {
    try {
      const session = await window.electronAPI.getTokenNestRechargeUrl(connectionSlug)
      if (session.requiresWebsiteLogin) toast.info(i18n.t('settings.ai.tokenNestRechargeLogin'))
      await window.electronAPI.openTokenNestRecharge(session.url)
      window.dispatchEvent(new Event(TOKENNEST_BALANCE_REFRESH_EVENT))
    } catch (error) {
      toast.error(i18n.t('settings.ai.tokenNestRechargeFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  })()
  void pending.finally(() => { pending = null })
  return pending
}

export function rechargeOnInsufficientBalance(error: unknown, connection?: LlmConnectionWithStatus): boolean {
  if (connection?.authType !== 'oauth' || connection.oauthProvider !== 'tokennest'
    || !connection.isAuthenticated || !isInsufficientBalanceError(error)) return false
  void openTokenNestRecharge(connection.slug)
  return true
}
