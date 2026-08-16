import { spawn } from 'node:child_process';

/**
 * Kill a process and all of its descendants.
 *
 * Windows: uses `taskkill /T /F`, which walks the process tree at kill time.
 *   `child.kill('SIGTERM')` on Windows is `TerminateProcess` — it neither runs
 *   signal handlers in the child nor kills grandchildren, which is exactly how
 *   agent subprocesses leak orphaned bash.exe/python.exe/bun.exe children.
 * POSIX: SIGKILL the process group when the child is a group leader, falling
 *   back to killing just the pid.
 *
 * @param pid PID of the root process to kill (ignored if not positive).
 * @param onDone Optional callback invoked when the kill completes or fails.
 */
export function killProcessTree(pid: number, onDone?: (error?: Error) => void): void {
  if (!pid || pid <= 0 || !Number.isInteger(pid)) {
    onDone?.(new Error(`Invalid pid: ${pid}`));
    return;
  }

  if (process.platform === 'win32') {
    try {
      const taskkill = spawn(
        'taskkill',
        ['/pid', String(pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true },
      );
      taskkill.once('error', (error) => onDone?.(error));
      taskkill.once('exit', () => onDone?.());
    } catch (error) {
      onDone?.(error as Error);
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
    onDone?.();
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
      onDone?.();
    } catch (error) {
      onDone?.(error as Error);
    }
  }
}

/**
 * Promise wrapper for {@link killProcessTree}. Resolves once the kill
 * command has completed (or fails on POSIX when the pid can't be signaled).
 */
export function killProcessTreeAsync(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    killProcessTree(pid, (error) => (error ? reject(error) : resolve()));
  });
}
