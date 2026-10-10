import { TOKENNEST_RECHARGE_URL, getProviderRechargeTarget } from '@craft-agent/shared/utils/billing'
import type { LlmConnection } from '@config/llm-connections'
import { getPeakValleyPeriod, parsePeakValleySchedule, type PeakValleySchedule } from '@craft-agent/shared/utils/peak-valley'

export { getPeakValleyPeriod, type PeakValleySchedule }
export type PricingSource = 'tokennest' | 'deepseek'

export function getModelPricingSource(connection: LlmConnection | null | undefined, modelId: string): PricingSource | undefined {
  if (!connection || !/^deepseek[-/]/i.test(modelId.replace(/^pi\//, ''))) return undefined
  const target = getProviderRechargeTarget(connection)
  if (target?.url === TOKENNEST_RECHARGE_URL) return 'tokennest'
  if (target?.url === 'https://platform.deepseek.com/top_up') return 'deepseek'
  return undefined
}

/** Use only opted-in models in the gateway's current public pricing catalog. */
export function parsePeakValleyPricing(payload: unknown): Record<string, PeakValleySchedule> {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid pricing catalog')
  const catalog = payload as { success?: unknown; data?: unknown }
  if (catalog.success !== true || !Array.isArray(catalog.data)) throw new Error('Pricing catalog unavailable')
  const schedules: Record<string, PeakValleySchedule> = {}
  for (const row of catalog.data) {
    if (!row || typeof row !== 'object' || typeof row.model_name !== 'string') continue
    const schedule = parsePeakValleySchedule(row.peak_valley_pricing)
    if (schedule) schedules[row.model_name] = schedule
  }
  return schedules
}

interface PricingStore {
  listeners: Set<() => void>
  snapshot: { schedules: Record<string, PeakValleySchedule>; at: number }
  fetchedAt: number
  pending?: Promise<void>
}
const stores: Record<PricingSource, PricingStore> = {
  tokennest: { listeners: new Set(), snapshot: { schedules: {}, at: Date.now() }, fetchedAt: 0 },
  deepseek: { listeners: new Set(), snapshot: { schedules: {}, at: Date.now() }, fetchedAt: 0 },
}
let timer: ReturnType<typeof setTimeout> | undefined

export function getPricingSnapshot() { return stores.tokennest.snapshot }
export function getDeepSeekPricingSnapshot() { return stores.deepseek.snapshot }

async function refreshPricing(source: PricingSource): Promise<void> {
  const store = stores[source]
  if (store.pending) return store.pending
  if (Date.now() - store.fetchedAt < 5 * 60_000) return
  store.pending = (async () => {
    try {
      const catalog = await window.electronAPI.getModelPeakValleyPricing(source)
      store.snapshot = { schedules: parsePeakValleyPricing(catalog), at: Date.now() }
    } catch {
      // Hide the badge when live metadata is unavailable instead of claiming a price period.
      store.snapshot = { schedules: {}, at: Date.now() }
    } finally {
      store.fetchedAt = Date.now()
      store.pending = undefined
      for (const listener of store.listeners) listener()
    }
  })()
  return store.pending
}

function updatePricingClock() {
  for (const source of ['tokennest', 'deepseek'] as const) {
    const store = stores[source]
    if (!store.listeners.size) continue
    store.snapshot = { ...store.snapshot, at: Date.now() }
    for (const listener of store.listeners) listener()
    void refreshPricing(source)
  }
}

function schedulePricingClock() {
  timer = setTimeout(() => {
    updatePricingClock()
    schedulePricingClock()
  }, 60_000 - Date.now() % 60_000)
}

/** One request, clock, and focus listener shared by desktop/mobile model badges. */
export function subscribePricing(listener: () => void, source: PricingSource = 'tokennest'): () => void {
  const previouslyActive = stores.tokennest.listeners.size + stores.deepseek.listeners.size
  stores[source].listeners.add(listener)
  if (stores[source].listeners.size === 1) updatePricingClock()
  if (!previouslyActive) {
    schedulePricingClock()
    window.addEventListener('focus', updatePricingClock)
  }
  return () => {
    stores[source].listeners.delete(listener)
    if (!stores.tokennest.listeners.size && !stores.deepseek.listeners.size) {
      clearTimeout(timer)
      window.removeEventListener('focus', updatePricingClock)
    }
  }
}

export function subscribeDeepSeekPricing(listener: () => void): () => void {
  return subscribePricing(listener, 'deepseek')
}
