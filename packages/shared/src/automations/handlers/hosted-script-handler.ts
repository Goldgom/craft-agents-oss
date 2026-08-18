import vm from 'node:vm';
import type { EventBus, SchedulerTickPayload } from '../event-bus.ts';
import type { AutomationHandler, AutomationsConfigProvider } from './types.ts';
import type { AutomationMatcher } from '../types.ts';

/**
 * Runs user/AI-authored automation scripts in an isolated VM context.
 * Scripts have no `require`, process, filesystem or network access. They must
 * assign a boolean or JSON object to `module.exports` (or return it from an
 * async function expression).
 */
export class HostedScriptHandler implements AutomationHandler {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private bus: EventBus | null = null;

  constructor(
    private readonly workspaceId: string,
    private readonly provider: AutomationsConfigProvider,
    private readonly onError?: (event: 'HostedScriptTick', error: Error) => void,
  ) {}

  subscribe(bus: EventBus): void {
    this.bus = bus;
    bus.on('SchedulerTick', this.onSchedulerTick);
    this.refreshTimers();
  }

  private readonly onSchedulerTick = async (_payload: SchedulerTickPayload): Promise<void> => {
    // Timers are independent from minute cron ticks. This listener only makes
    // config reloads observable without adding another scheduler service.
    this.refreshTimers();
  };

  private refreshTimers(): void {
    const matchers = this.provider.getMatchersForEvent('HostedScriptTick')
      .filter((m) => m.enabled !== false && !!m.script && Number.isFinite(m.intervalMs));
    const active = new Set<string>();
    for (const matcher of matchers) {
      const id = matcher.id ?? `${matcher.script}:${matcher.intervalMs}`;
      active.add(id);
      if (this.timers.has(id)) continue;
      const interval = Math.max(1000, Math.floor(matcher.intervalMs ?? 60_000));
      this.timers.set(id, setInterval(() => void this.run(matcher), interval));
      void this.run(matcher);
    }
    for (const [id, timer] of this.timers) {
      if (!active.has(id)) {
        clearInterval(timer);
        this.timers.delete(id);
      }
    }
  }

  private async run(matcher: AutomationMatcher): Promise<void> {
    if (!this.bus || !matcher.script) return;
    try {
      const metadata = matcher.scriptMetadata ?? {};
      const context = vm.createContext({
        input: { workspaceId: this.workspaceId, timestamp: Date.now(), metadata },
        metadata,
        module: { exports: false as unknown },
        exports: false as unknown,
      });
      const timeout = Math.max(10, Math.min(30_000, matcher.scriptTimeoutMs ?? 2_000));
      const source = `(async () => {\n${matcher.script}\n})()`;
      const result = await new vm.Script(source).runInContext(context, { timeout });
      const value = result ?? (context.module as { exports?: unknown }).exports;
      if (!value) return;
      const scriptInfo = typeof value === 'object' && value !== null
        ? JSON.parse(JSON.stringify(value)) as Record<string, unknown>
        : { result: value };
      await this.bus.emit('HostedScriptTick', {
        workspaceId: this.workspaceId,
        timestamp: Date.now(),
        automationId: matcher.id,
        scriptInfo,
      });
    } catch (error) {
      this.onError?.('HostedScriptTick', error instanceof Error ? error : new Error(String(error)));
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    if (this.bus) this.bus.off('SchedulerTick', this.onSchedulerTick);
    this.bus = null;
  }
}
