import { TOKENNEST_RECHARGE_URL, getProviderRechargeTarget } from '@craft-agent/shared/utils/billing'
import type { LlmConnection } from '@config/llm-connections'

export interface PeakValleySchedule {
  timezone: string
  start: string
  end: string
  multiplier: number
}

export function supportsTokenNestPricing(connection: LlmConnection | null | undefined, modelId: string): boolean {
  return !!connection && /^deepseek[-/]/i.test(modelId.replace(/^pi\//, ''))
    && getProviderRechargeTarget(connection)?.url === TOKENNEST_RECHARGE_URL
}

/** Use only opted-in models in the gateway's current public pricing catalog. */
export function parsePeakValleyPricing(payload: unknown): Record<string, PeakValleySchedule> {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid pricing catalog')
  const catalog = payload as { success?: unknown; data?: unknown }
  if (catalog.success !== true || !Array.isArray(catalog.data)) throw new Error('Pricing catalog unavailable')
  const schedules: Record<string, PeakValleySchedule> = {}
  for (const row of catalog.data) {
    if (!row || typeof row !== 'object' || typeof row.model_name !== 'string') continue
    const schedule = row.peak_valley_pricing
    if (!schedule || typeof schedule !== 'object') continue
    const { timezone, start, end, multiplier } = schedule
    const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/
    if (typeof timezone !== 'string' || !timezone || timezone === 'Local'
      || typeof start !== 'string' || typeof end !== 'string'
      || !clock.test(start) || !clock.test(end) || start === end
      || typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1) continue
    try { new Intl.DateTimeFormat('en-GB', { timeZone: timezone }) } catch { continue }
    schedules[row.model_name] = { timezone, start, end, multiplier }
  }
  return schedules
}

const formatters = new Map<string, Intl.DateTimeFormat>()

export function getPeakValleyPeriod(schedule: PeakValleySchedule, at: number): 'peak' | 'off-peak' {
  let formatter = formatters.get(schedule.timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: schedule.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
    formatters.set(schedule.timezone, formatter)
  }
  const clock = formatter.format(at)
  const offPeak = schedule.start < schedule.end
    ? clock >= schedule.start && clock < schedule.end
    : clock >= schedule.start || clock < schedule.end
  return offPeak ? 'off-peak' : 'peak'
}

const listeners = new Set<() => void>()
let snapshot = { schedules: {} as Record<string, PeakValleySchedule>, at: Date.now() }
let fetchedAt = 0
let pending: Promise<void> | undefined
let timer: ReturnType<typeof setTimeout> | undefined

export function getPricingSnapshot() { return snapshot }

async function refreshPricing(): Promise<void> {
  if (pending) return pending
  if (Date.now() - fetchedAt < 5 * 60_000) return
  pending = (async () => {
    try {
      const catalog = await window.electronAPI.getTokenNestPricing()
      snapshot = { schedules: parsePeakValleyPricing(catalog), at: Date.now() }
    } catch {
      // Hide the badge when live metadata is unavailable instead of claiming a price period.
      snapshot = { schedules: {}, at: Date.now() }
    } finally {
      fetchedAt = Date.now()
      pending = undefined
      for (const listener of listeners) listener()
    }
  })()
  return pending
}

function updatePricingClock() {
  snapshot = { ...snapshot, at: Date.now() }
  for (const listener of listeners) listener()
  void refreshPricing()
}

function schedulePricingClock() {
  timer = setTimeout(() => {
    updatePricingClock()
    schedulePricingClock()
  }, 60_000 - Date.now() % 60_000)
}

/** One request, clock, and focus listener shared by desktop/mobile model badges. */
export function subscribePricing(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    updatePricingClock()
    schedulePricingClock()
    window.addEventListener('focus', updatePricingClock)
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      clearTimeout(timer)
      window.removeEventListener('focus', updatePricingClock)
    }
  }
}
