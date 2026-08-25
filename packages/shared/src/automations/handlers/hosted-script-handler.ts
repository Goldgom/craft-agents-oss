import vm from 'node:vm';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { EventBus, SchedulerTickPayload } from '../event-bus.ts';
import type { AutomationHandler, AutomationsConfigProvider } from './types.ts';
import type { AutomationMatcher, HostedScriptPermissions } from '../types.ts';

/**
 * Runs user/AI-authored automation scripts in an isolated VM context.
 * Scripts have no `require`, process, filesystem or network access. They must
 * assign a boolean or JSON object to `module.exports` (or return it from an
 * async function expression). Optional capabilities are exposed only through
 * `api` and are granted per matcher by `scriptPermissions`.
 */
export class HostedScriptHandler implements AutomationHandler {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  /** Prevent a slow check from overlapping with its next interval tick. */
  private readonly running = new Set<string>();
  private bus: EventBus | null = null;

  constructor(
    private readonly workspaceId: string,
    private readonly provider: AutomationsConfigProvider,
    private readonly onError?: (event: 'HostedScriptTick', error: Error) => void,
    private readonly workspaceRootPath?: string,
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

  /** Reconcile timers immediately after automations.json is reloaded. */
  refresh(): void {
    this.refreshTimers();
  }

  private refreshTimers(): void {
    const matchers = this.provider.getMatchersForEvent('HostedScriptTick')
      .filter((m) => m.enabled !== false && !!m.script && Number.isFinite(m.intervalMs));
    const active = new Set<string>();
    for (const matcher of matchers) {
      const id = matcher.id ?? `${matcher.script}:${matcher.intervalMs}`;
      active.add(id);
      if (this.timers.has(id)) continue;
      const interval = Math.max(1000, Math.floor(matcher.intervalMs ?? 60_000));
      this.timers.set(id, setInterval(() => void this.run(matcher, id), interval));
      void this.run(matcher, id);
    }
    for (const [id, timer] of this.timers) {
      if (!active.has(id)) {
        clearInterval(timer);
        this.timers.delete(id);
        this.running.delete(id);
      }
    }
  }

  private async run(matcher: AutomationMatcher, id: string): Promise<void> {
    if (!this.bus || !matcher.script) return;
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      const metadata = matcher.scriptMetadata ?? {};
      const permissions = matcher.scriptPermissions ?? {};
      const api = this.createApi(permissions);
      const context = vm.createContext({
        input: { workspaceId: this.workspaceId, timestamp: Date.now(), metadata },
        metadata,
        module: { exports: false as unknown },
        exports: false as unknown,
        api,
      });
      const timeout = Math.max(10, Math.min(30_000, matcher.scriptTimeoutMs ?? 2_000));
      const source = `(async () => {\n${matcher.script}\n})()`;
      const execution = new vm.Script(source).runInContext(context, { timeout });
      // `vm`'s timeout only covers synchronous execution. Race async checks as
      // well so a broken monitor cannot keep a background automation pending.
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(`Hosted script timed out after ${timeout} ms`)), timeout);
        });
        const result = await Promise.race([Promise.resolve(execution), timeoutPromise]);
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
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    } catch (error) {
      this.onError?.('HostedScriptTick', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.running.delete(id);
    }
  }

  private createApi(permissions: HostedScriptPermissions): {
    env: (name: string) => string | undefined;
    readFile: (path: string) => Promise<string>;
    fetch: (url: string, init?: RequestInit) => Promise<Response>;
  } {
    const envAllowlist = new Set(permissions.env ?? []);
    const filesystemAllowlist = (permissions.filesystem ?? []).map((entry) => resolve(this.workspaceRootPath ?? '', entry));
    const networkAllowlist = (permissions.network ?? []).map((entry) => {
      try { return new URL(entry).origin; } catch { return null; }
    }).filter((entry): entry is string => !!entry);
    return {
      env: (name) => envAllowlist.has(name) ? process.env[name] : undefined,
      readFile: async (path) => {
        if (!this.workspaceRootPath || isAbsolute(path)) throw new Error('Filesystem access requires a relative workspace path');
        const target = resolve(this.workspaceRootPath, path);
        const relativeTarget = relative(this.workspaceRootPath, target);
        if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) throw new Error('Filesystem path escapes the workspace');
        const resolvedTarget = await realpath(target);
        const allowed = filesystemAllowlist.some((entry) => {
          const fromEntry = relative(entry, resolvedTarget);
          return fromEntry === '' || (!fromEntry.startsWith('..') && !isAbsolute(fromEntry));
        });
        if (!allowed) throw new Error(`Filesystem path is not allowed: ${path}`);
        const content = await readFile(resolvedTarget, 'utf8');
        if (content.length > 1_000_000) throw new Error('Filesystem read exceeds the 1 MB limit');
        return content;
      },
      fetch: async (url, init) => {
        let origin: string;
        try { origin = new URL(url).origin; } catch { throw new Error('Invalid network URL'); }
        if (!networkAllowlist.includes(origin)) throw new Error(`Network origin is not allowed: ${origin}`);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') throw new Error('Sandbox network access is read-only (GET/HEAD)');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try { return await fetch(url, { ...init, signal: controller.signal }); }
        finally { clearTimeout(timeout); }
      },
    };
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.running.clear();
    if (this.bus) this.bus.off('SchedulerTick', this.onSchedulerTick);
    this.bus = null;
  }
}
