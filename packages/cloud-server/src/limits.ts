export interface CloudLimits {
  apiRequestsPerMinute: number
  maxHosts: number
  maxClients: number
  maxClientsPerDevice: number
  relayBytesPerSecondPerDevice: number
}

export const DEFAULT_LIMITS: CloudLimits = {
  apiRequestsPerMinute: 600,
  maxHosts: 10_000,
  maxClients: 10_000,
  maxClientsPerDevice: 64,
  relayBytesPerSecondPerDevice: 32 * 1024 * 1024,
}

export function validateLimits(value: unknown): value is CloudLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.length === Object.keys(DEFAULT_LIMITS).length && entries.every(([key, limit]) =>
    Object.hasOwn(DEFAULT_LIMITS, key) && Number.isSafeInteger(limit) && limit > 0 &&
    limit <= (key === 'relayBytesPerSecondPerDevice' ? 1024 * 1024 * 1024 : 1_000_000))
}

/** Fixed windows keep memory bounded; rejected requests do not extend a window. */
export class WindowLimiter {
  private buckets = new Map<string, { used: number; expiresAt: number }>()
  consume(key: string, amount: number, limit: number, windowMs: number): boolean {
    const now = Date.now()
    let bucket = this.buckets.get(key)
    if (!bucket || bucket.expiresAt <= now) {
      if (!bucket && this.buckets.size >= 100_000) { this.prune(); if (this.buckets.size >= 100_000) return false }
      bucket = { used: 0, expiresAt: now + windowMs }
      this.buckets.set(key, bucket)
    }
    if (bucket.used + amount > limit) return false
    bucket.used += amount
    return true
  }
  prune(): void {
    const now = Date.now()
    for (const [key, bucket] of this.buckets) if (bucket.expiresAt <= now) this.buckets.delete(key)
  }
}
