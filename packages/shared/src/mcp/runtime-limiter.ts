/**
 * Process-wide MCP runtime limiter.
 *
 * A pool is created per session, but MCP subprocesses are owned by the same
 * server process. Keeping the limiter here makes the limit apply across all
 * sessions instead of accidentally applying once per pool.
 */

export interface McpRuntimeLimits {
  /** Maximum number of connected MCP runtimes. New work waits above this. */
  hardLimit: number
  /** Number of idle runtimes retained after calls finish. */
  softLimit: number
  /** Maximum measured RSS of local MCP runtimes. */
  memoryHardLimitBytes: number
}

export interface McpRuntimeLease {
  release(): void
}

interface RuntimeEntry {
  key: string
  lastUsedAt: number
  inFlight: number
  evict: () => Promise<void>
  getMemoryBytes?: () => Promise<number | undefined>
}

interface Waiter {
  key: string
  evict: () => Promise<void>
  resolve: (lease: McpRuntimeLease) => void
  reject: (error: unknown) => void
  getMemoryBytes?: () => Promise<number | undefined>
}

export const DEFAULT_MCP_MEMORY_HARD_LIMIT_BYTES = 3 * 1024 * 1024 * 1024
const DEFAULT_LIMITS: McpRuntimeLimits = { hardLimit: 8, softLimit: 4, memoryHardLimitBytes: DEFAULT_MCP_MEMORY_HARD_LIMIT_BYTES }

function normalizeLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function normalizeLimits(limits: Partial<McpRuntimeLimits>): McpRuntimeLimits {
  const hardLimit = Math.max(1, normalizeLimit(limits.hardLimit, DEFAULT_LIMITS.hardLimit))
  const softLimit = Math.min(hardLimit, normalizeLimit(limits.softLimit, DEFAULT_LIMITS.softLimit))
  const memoryHardLimitBytes = typeof limits.memoryHardLimitBytes === 'number' && Number.isSafeInteger(limits.memoryHardLimitBytes) && limits.memoryHardLimitBytes > 0
    ? limits.memoryHardLimitBytes
    : DEFAULT_LIMITS.memoryHardLimitBytes
  return { hardLimit, softLimit, memoryHardLimitBytes }
}

export class McpRuntimeLimiter {
  private limits: McpRuntimeLimits = { ...DEFAULT_LIMITS }
  private runtimes = new Map<string, RuntimeEntry>()
  private waiters: Waiter[] = []
  private draining: Promise<void> = Promise.resolve()

  getLimits(): McpRuntimeLimits { return { ...this.limits } }
  getActiveCount(): number { return this.runtimes.size }
  getQueuedCount(): number { return this.waiters.length }

  configure(limits: Partial<McpRuntimeLimits>): void {
    this.limits = normalizeLimits(limits)
    void this.enforceLimits()
  }

  /** Reserve one hard-limit slot. The returned lease owns the connected slot. */
  async acquire(
    key: string,
    evict: () => Promise<void>,
    getMemoryBytes?: () => Promise<number | undefined>,
  ): Promise<McpRuntimeLease> {
    const existing = this.runtimes.get(key)
    if (existing) {
      existing.inFlight++
      existing.lastUsedAt = Date.now()
      return this.createLease(existing)
    }

    return new Promise<McpRuntimeLease>((resolve, reject) => {
      this.waiters.push({ key, evict, resolve, reject, getMemoryBytes })
      this.scheduleDrain()
    })
  }

  /** Run a call while preventing soft-limit eviction of its runtime. */
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const runtime = this.runtimes.get(key)
    if (!runtime) throw new Error(`MCP runtime is not connected: ${key}`)
    runtime.inFlight++
    runtime.lastUsedAt = Date.now()
    try {
      return await operation()
    } finally {
      runtime.inFlight = Math.max(0, runtime.inFlight - 1)
      runtime.lastUsedAt = Date.now()
      this.scheduleDrain()
    }
  }

  unregister(key: string): void {
    this.runtimes.delete(key)
    this.scheduleDrain()
  }

  /** Sum RSS for runtimes whose host can measure it (typically stdio MCPs). */
  async getMemoryUsageBytes(): Promise<number> {
    const values = await Promise.all(Array.from(this.runtimes.values()).map(async runtime => {
      try { return await runtime.getMemoryBytes?.() } catch { return undefined }
    }))
    return values.reduce<number>((total, value) => total + (value ?? 0), 0)
  }

  /** Close every currently idle MCP runtime, regardless of the soft limit. */
  async clearIdleRuntimes(): Promise<number> {
    let evicted = 0
    const run = this.draining.then(async () => {
      evicted = await this.evictIdleUntil(0)
      await this.makeRoomForWaiters()
      this.resolveWaiters()
    })
    this.draining = run.catch(() => undefined)
    await run
    return evicted
  }

  /** Reject queued connection work that is no longer desired by its pool. */
  cancelQueued(key: string, error = new Error(`MCP runtime was cancelled: ${key}`)): void {
    const cancelled: Waiter[] = []
    this.waiters = this.waiters.filter(waiter => {
      if (waiter.key !== key) return true
      cancelled.push(waiter)
      return false
    })
    for (const waiter of cancelled) waiter.reject(error)
    if (cancelled.length > 0) this.scheduleDrain()
  }

  async enforceLimits(): Promise<void> {
    const run = this.draining.then(async () => {
      // Hard-limit reduction can only evict idle runtimes. Busy calls are
      // allowed to finish; queued calls remain blocked until a slot opens.
      await this.evictIdleUntil(this.limits.hardLimit)
      await this.evictIdleUntil(this.limits.softLimit)
      await this.evictForMemoryLimit()
      await this.makeRoomForWaiters()
      this.resolveWaiters()
    })
    this.draining = run.catch(() => undefined)
    await run
  }

  private createLease(runtime: RuntimeEntry): McpRuntimeLease {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        runtime.inFlight = Math.max(0, runtime.inFlight - 1)
        runtime.lastUsedAt = Date.now()
        this.scheduleDrain()
      },
    }
  }

  private scheduleDrain(): void {
    this.draining = this.draining.then(async () => {
      await this.evictIdleUntil(this.limits.softLimit)
      await this.evictForMemoryLimit()
      await this.makeRoomForWaiters()
      this.resolveWaiters()
    }).catch(() => undefined)
  }

  private resolveWaiters(): void {
    while (this.waiters.length > 0 && this.runtimes.size < this.limits.hardLimit) {
      const waiter = this.waiters.shift()!
      if (this.runtimes.has(waiter.key)) {
        waiter.resolve(this.createLease(this.runtimes.get(waiter.key)!))
        continue
      }
      // Keep the reservation busy until the caller releases it, so a soft
      // eviction cannot close a process during its connection handshake.
      const runtime: RuntimeEntry = { key: waiter.key, lastUsedAt: Date.now(), inFlight: 1, evict: waiter.evict, getMemoryBytes: waiter.getMemoryBytes }
      this.runtimes.set(waiter.key, runtime)
      waiter.resolve(this.createLease(runtime))
    }
  }

  /**
   * A queued source must be able to replace an idle source even when the soft
   * limit equals the hard limit. Otherwise a full pool of idle runtimes would
   * leave the FIFO queue waiting forever. Busy runtimes are never interrupted.
   */
  private async makeRoomForWaiters(): Promise<void> {
    while (this.waiters.length > 0 && this.runtimes.size >= this.limits.hardLimit) {
      const before = this.runtimes.size
      await this.evictIdleUntil(this.limits.hardLimit - 1)
      if (this.runtimes.size === before) return
      this.resolveWaiters()
    }
  }

  private async evictIdleUntil(target: number): Promise<number> {
    let evicted = 0
    while (this.runtimes.size > target) {
      const candidate = Array.from(this.runtimes.values())
        .filter(runtime => runtime.inFlight === 0)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
      if (!candidate) return evicted
      this.runtimes.delete(candidate.key)
      evicted++
      try {
        await candidate.evict()
      } catch {
        // A dead runtime has already freed its slot. The next call will
        // recreate it through the normal queued path.
      }
    }
    return evicted
  }

  private async evictForMemoryLimit(): Promise<void> {
    let measured = await this.getMeasuredMemory()
    while (measured.totalBytes >= this.limits.memoryHardLimitBytes) {
      const candidate = measured.entries
        .filter(entry => entry.runtime.inFlight === 0)
        .sort((a, b) => a.runtime.lastUsedAt - b.runtime.lastUsedAt)[0]
      if (!candidate) return
      this.runtimes.delete(candidate.runtime.key)
      try {
        await candidate.runtime.evict()
      } catch {
        // The slot is already free; the next call can recreate the runtime.
      }
      measured = await this.getMeasuredMemory()
    }
  }

  private async getMeasuredMemory(): Promise<{ totalBytes: number; entries: Array<{ runtime: RuntimeEntry; bytes: number }> }> {
    const entries = (await Promise.all(Array.from(this.runtimes.values()).map(async runtime => {
      try {
        const bytes = await runtime.getMemoryBytes?.()
        return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? { runtime, bytes } : undefined
      } catch {
        return undefined
      }
    }))).filter((entry): entry is { runtime: RuntimeEntry; bytes: number } => entry !== undefined)
    return { entries, totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0) }
  }
}

export const mcpRuntimeLimiter = new McpRuntimeLimiter()

export function resolveMcpRuntimeLimits(
  hardLimit = process.env.CRAFT_MCP_HARD_LIMIT,
  softLimit = process.env.CRAFT_MCP_SOFT_LIMIT,
  memoryHardLimitGb = process.env.CRAFT_MCP_MEMORY_HARD_LIMIT_GB,
): McpRuntimeLimits {
  const parse = (value: string | undefined, fallback: number) => {
    if (value === undefined || value.trim() === '') return fallback
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
  }
  const parsedMemoryGb = memoryHardLimitGb === undefined || memoryHardLimitGb.trim() === '' ? undefined : Number(memoryHardLimitGb)
  const memoryHardLimitBytes = parsedMemoryGb !== undefined && Number.isFinite(parsedMemoryGb) && parsedMemoryGb > 0
    ? Math.round(parsedMemoryGb * 1024 * 1024 * 1024)
    : DEFAULT_LIMITS.memoryHardLimitBytes
  return normalizeLimits({ hardLimit: parse(hardLimit, DEFAULT_LIMITS.hardLimit), softLimit: parse(softLimit, DEFAULT_LIMITS.softLimit), memoryHardLimitBytes })
}
