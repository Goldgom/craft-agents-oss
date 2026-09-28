/**
 * Pi SDK settings for Craft-embedded sessions.
 *
 * `createAgentSession` defaults to `SettingsManager.create(cwd, agentDir)`, which
 * merges the *working directory's* `.pi/settings.json` (project scope, trusted by
 * default) on top of `agentDir/settings.json`, and persists every SDK-side
 * settings write (e.g. `setModel` → defaultProvider/defaultModel) into the
 * session's `.pi-agent/` folder. Neither is wanted here: Craft owns model,
 * thinking level and compaction for its sessions, a repo checked out as the
 * working directory must not be able to flip retry/compaction/tool defaults,
 * and nothing should be written next to the session transcript.
 *
 * The in-memory manager starts from the SDK defaults and pins the retry policy
 * explicitly. The main process surfaces the resulting `auto_retry_*` events —
 * see `packages/shared/src/agent/backend/pi/event-adapter.ts`.
 */
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { LLM_QUERY_TIMEOUT_MS } from '../../shared/src/agent/llm-tool.ts';

type PiSettings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

export type CraftPiSessionPurpose = 'main' | 'ephemeral';

/**
 * Finish inside the host RPC timeout so the subprocess has time to serialize a
 * targeted result and the host can clear its pending request before its own
 * deadline fires.
 */
export const CRAFT_PI_EPHEMERAL_QUERY_DEADLINE_MS = LLM_QUERY_TIMEOUT_MS - 5_000;

/**
 * Main-chat retry policy for transient provider/transport errors.
 *
 * Agent-level (`AgentSession._prepareRetry`, classifier `isRetryableAssistantError`
 * in pi-ai): re-runs a failed assistant turn with exponential backoff
 * `baseDelayMs * 2^(attempt-1)`. Five retries wait 2 + 4 + 8 + 16 + 32 s.
 *
 * Disable provider-level retries in main chats so the total retry count stays
 * bounded at five and a risk-control 429 reaches the agent classifier at once.
 */
export const CRAFT_PI_RETRY_SETTINGS = {
  enabled: true,
  maxRetries: 5,
  baseDelayMs: 2_000,
  provider: {
    maxRetries: 0,
    maxRetryDelayMs: 60_000,
  },
} as const;

/**
 * Smaller retry budget for utility sessions (`call_llm`, titles, summaries).
 *
 * These calls have an end-to-end 120-second RPC budget and a 115-second child
 * deadline. Agent backoff consumes at most 6 seconds, leaving headroom for
 * request and cleanup latency.
 */
export const CRAFT_PI_EPHEMERAL_RETRY_SETTINGS = {
  enabled: true,
  maxRetries: 2,
  baseDelayMs: 2_000,
  provider: {
    maxRetries: 0,
    maxRetryDelayMs: 10_000,
  },
} as const;

export const CRAFT_PI_EPHEMERAL_MAX_BACKOFF_MS =
  CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.provider.maxRetries *
    CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.provider.maxRetryDelayMs *
    (CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.maxRetries + 1) +
  CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.baseDelayMs *
    (2 ** CRAFT_PI_EPHEMERAL_RETRY_SETTINGS.maxRetries - 1);

/** Settings applied to one Pi session, isolated from project/global Pi files. */
export function buildCraftPiSettings(purpose: CraftPiSessionPurpose = 'main'): PiSettings {
  const retry = purpose === 'ephemeral'
    ? CRAFT_PI_EPHEMERAL_RETRY_SETTINGS
    : CRAFT_PI_RETRY_SETTINGS;

  return {
    retry: {
      enabled: retry.enabled,
      maxRetries: retry.maxRetries,
      baseDelayMs: retry.baseDelayMs,
      provider: { ...retry.provider },
    },
    // PiAgent re-asserts auto-compaction on every subprocess start
    // (requestSetAutoCompaction(true)); keep the SDK default explicit here so
    // the intent is visible next to the retry policy.
    compaction: { enabled: true },
  };
}

/**
 * Fresh in-memory settings manager for one Pi session. Cheap to create; not
 * shared between the main session and `queryLlm` ephemeral sessions so a
 * `setModel` on one can never leak a "default model" into the other.
 */
export function createCraftSettingsManager(
  purpose: CraftPiSessionPurpose = 'main',
): SettingsManager {
  return SettingsManager.inMemory(buildCraftPiSettings(purpose));
}
