/**
 * Handlers for the `runshell` and `localbash` session tools.
 *
 * - `runshell`: executes the command on the server that hosts the session
 *   (remote mode → remote server filesystem).
 * - `localbash`: executes the command on the CLIENT machine via the
 *   `runLocalShellFn` bridge (registered by the server host when a client
 *   advertises `client:runShell`). Falls back to server execution with a
 *   warning when no client bridge is available.
 */

import type { SessionToolContext } from '../context.ts';
import { errorResponse, successResponse } from '../response.ts';
import type { ToolResult } from '../types.ts';
import { executeShell, type ShellExecArgs } from '../shell.ts';

function formatResult(executedOn: 'server' | 'client', result: Awaited<ReturnType<typeof executeShell>>): string {
  const parts = [
    `[executed on ${executedOn}] cwd=${result.cwd}`,
    result.exitCode === null
      ? 'timed out'
      : `exit code ${result.exitCode}`,
    result.truncated ? '(output truncated)' : '',
    result.stdout ? `\nSTDOUT:\n${result.stdout}` : '',
    result.stderr ? `\nSTDERR:\n${result.stderr}` : '',
  ];
  return parts.filter(Boolean).join('\n');
}

function resolveArgs(ctx: SessionToolContext, args: ShellExecArgs): ShellExecArgs {
  return {
    command: args.command,
    cwd: args.cwd ?? ctx.workingDirectory ?? ctx.workspacePath,
    timeoutMs: args.timeoutMs,
  };
}

/** Execute a shell command on the server that owns this session. */
export async function handleRunShell(ctx: SessionToolContext, args: ShellExecArgs): Promise<ToolResult> {
  try {
    const result = await executeShell(resolveArgs(ctx, args));
    if (result.exitCode !== 0 && result.exitCode !== null) {
      return errorResponse(formatResult('server', result));
    }
    return successResponse(formatResult('server', result));
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err));
  }
}

/** Execute a shell command on the CLIENT machine (falls back to server). */
export async function handleLocalBash(ctx: SessionToolContext, args: ShellExecArgs): Promise<ToolResult> {
  try {
    const bridge = ctx.runLocalShellFn;
    if (bridge) {
      try {
        const result = await bridge(resolveArgs(ctx, args));
        if (result.exitCode !== 0 && result.exitCode !== null) {
          return errorResponse(formatResult('client', result));
        }
        return successResponse(formatResult('client', result));
      } catch (err) {
        // Bridge failed (e.g. client disconnected mid-call) — do NOT silently
        // run on the server; surface the error so the agent knows local execution failed.
        return errorResponse(`localbash client bridge failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // No client bridge — same-machine fallback (embedded/local server).
    const result = await executeShell(resolveArgs(ctx, args));
    const note = 'localbash: no client shell bridge available — executed on the server host instead.';
    if (result.exitCode !== 0 && result.exitCode !== null) {
      return errorResponse(`${note}\n${formatResult('server', result)}`);
    }
    return successResponse(`${note}\n${formatResult('server', result)}`);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err));
  }
}
