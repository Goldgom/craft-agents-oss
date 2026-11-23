/**
 * SchedulerService - Emits SchedulerTick events every minute
 *
 * Aligned to minute boundaries for consistent timing.
 * Automations can subscribe using cron expressions in automations.json.
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const MINUTE = 60_000;
const MAX_CATCH_UP_MINUTES = 24 * 60;

export interface SchedulerTickPayload {
  /** ISO 8601 UTC timestamp */
  timestamp: string;
  /** HH:MM in local time */
  localTime: string;
  /** Hour (0-23) */
  hour: number;
  /** Minute (0-59) */
  minute: number;
  /** Day of week (0-6, Sunday = 0) */
  dayOfWeek: number;
  /** Day name abbreviation (Sun, Mon, Tue, etc.) */
  dayName: string;
}

export class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private active = false;
  private flight?: Promise<void>;
  private cursor?: number;

  constructor(
    private readonly onTick: (payload: SchedulerTickPayload) => Promise<void>,
    private readonly checkpointPath: string,
    private readonly now: () => number = Date.now,
    private readonly onCheckpoint?: (timestamp: number) => Promise<void>,
  ) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.arm();
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (!this.active) return;
    this.timer = setTimeout(() => {
      this.arm();
      if (this.flight) return;
      this.flight = this.runDueMinutes()
        .catch(error => console.error('[SchedulerService] Tick failed:', error))
        .finally(() => { this.flight = undefined; });
    }, MINUTE - this.now() % MINUTE);
  }

  private async runDueMinutes(): Promise<void> {
    const current = Math.floor(this.now() / MINUTE) * MINUTE;
    if (this.cursor === undefined) {
      const saved = await readFile(this.checkpointPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      const timestamp = Number(saved);
      if (saved && (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp % MINUTE !== 0)) {
        throw new Error('Invalid automation scheduler checkpoint');
      }
      const baseline = saved ? timestamp : Math.max(0, current - MINUTE);
      if (!saved) await this.persistCursor(baseline);
      this.cursor = baseline;
    }
    const earliest = current - (MAX_CATCH_UP_MINUTES - 1) * MINUTE;
    const first = Math.max(this.cursor + MINUTE, earliest);
    if (first > this.cursor + MINUTE) console.warn('[SchedulerService] Catch-up is limited to the last 24 hours');
    for (let minute = first; this.active && minute <= current; minute += MINUTE) {
      const time = new Date(minute);
      await this.onTick({
        timestamp: time.toISOString(),
        localTime: time.toTimeString().slice(0, 5),
        hour: time.getHours(),
        minute: time.getMinutes(),
        dayOfWeek: time.getDay(),
        dayName: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][time.getDay()]!,
      });
      if (!this.active) return;
      await this.persistCursor(minute);
      this.cursor = minute;
      await this.onCheckpoint?.(minute).catch(error => console.warn('[SchedulerService] Could not retire occurrence receipts:', error));
    }
  }

  private async persistCursor(timestamp: number): Promise<void> {
    const temp = `${this.checkpointPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, String(timestamp), { flag: 'wx', mode: 0o600, flush: true });
      await rename(temp, this.checkpointPath);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
}
