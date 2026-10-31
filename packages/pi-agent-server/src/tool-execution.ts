import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Session-local, bounded diagnostics remain available after the app exits. */
export function appendToolDiagnostic(sessionPath: string | undefined, record: string): void {
  if (!sessionPath) return;
  try {
    mkdirSync(sessionPath, { recursive: true });
    const file = join(sessionPath, 'tool-diagnostics.jsonl');
    if (existsSync(file) && statSync(file).size >= 2_000_000) renameSync(file, `${file}.previous`);
    appendFileSync(file, record + '\n');
  } catch {
    // Diagnostics must not change the outcome of an authorized tool call.
  }
}

/** Bound shell execution without rewriting commands or overriding explicit budgets. */
export function withBashTimeout(tool: ToolDefinition<any, any>): ToolDefinition<any, any> {
  const parameters = {
    ...tool.parameters,
    properties: {
      ...tool.parameters.properties,
      timeout: {
        ...tool.parameters.properties.timeout,
        description: 'Timeout in seconds (default 120). Set explicitly for longer builds/tests; use 15 for shell searches.',
      },
    },
  };
  return {
    ...tool,
    parameters,
    description: `${tool.description} Default timeout: 120 seconds. Set timeout explicitly for longer builds/tests. Use Grep/Find for source searches, or set timeout to 15 seconds for shell searches.`,
    execute(id, params, signal, onUpdate, ctx) {
      const input = params as Record<string, unknown>;
      return tool.execute(id, { ...input, timeout: input.timeout ?? 120 }, signal, onUpdate, ctx);
    },
  };
}

/** Logs contain identifiers and timing only, never command arguments or results. */
export async function runToolPhase<T>(
  log: (message: string) => void,
  toolCallId: string,
  toolName: string,
  phase: 'permission' | 'execution' | 'result-processing',
  run: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const record = (state: string) => log(JSON.stringify({ timestamp: new Date().toISOString(), toolCallId, toolName, phase, state, elapsedMs: Math.round(performance.now() - started) }));
  record('start');
  const heartbeat = setInterval(() => record('running'), 10_000);
  try {
    const result = await run();
    record('complete');
    return result;
  } catch (error) {
    record('failed');
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
