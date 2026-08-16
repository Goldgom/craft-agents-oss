import { existsSync } from 'node:fs';

/**
 * Resolve the bash executable for the Pi SDK's built-in bash tool (Windows only).
 *
 * Honors the globally configured Git Bash path so the bash tool uses the same
 * shell as the Claude backend. The configured path is persisted in
 * `config.json` (`gitBashPath`) and reaches this subprocess either via the
 * `init` message (`gitBashPath`) or the `CLAUDE_CODE_GIT_BASH_PATH` env var
 * set by the main process. Without it, the Pi SDK only searches hardcoded
 * `Program Files` locations and PATH — which misses per-user Git installs
 * (e.g. `%LOCALAPPDATA%\Programs\Git`) and fails with "No bash shell found".
 *
 * Returns `undefined` when no usable path is configured, letting the SDK fall
 * back to its own shell discovery.
 */
export function resolveBashShellPath(
  configuredPath: string | undefined,
  envPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') return undefined;
  const candidates = [configuredPath?.trim(), envPath?.trim()].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  return candidates.find((p) => existsSync(p));
}
