/**
 * Host-side shell execution for the `runshell` / `localbash` session tools.
 *
 * Runs a command through the platform shell (cmd.exe on Windows, /bin/sh on
 * POSIX) on THIS machine — i.e. the server host. For `localbash`, the server
 * first tries to delegate to a connected client that advertises
 * `client:runShell` so the command executes on the user's local machine
 * instead (see SessionManager.runLocalShellFn).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface ShellExecArgs {
  command: string;
  /** Working directory. Must exist when provided. */
  cwd?: string;
  /** Timeout in ms. Default 120_000, max 600_000. */
  timeoutMs?: number;
}

export interface ShellExecResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  /** null when the process was killed by the timeout. */
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 200_000;

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_OUTPUT_CHARS), truncated: true };
}

export async function executeShell(args: ShellExecArgs): Promise<ShellExecResult> {
  const command = args.command;
  if (!command || !command.trim()) {
    throw new Error('Shell command is required');
  }

  const cwd = args.cwd && args.cwd.trim() ? args.cwd.trim() : process.cwd();
  if (!existsSync(cwd)) {
    throw new Error(`Working directory not found: ${cwd}`);
  }

  const timeoutMs = Math.min(Math.max(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);

  return await new Promise<ShellExecResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;

    const child = spawn(command, {
      shell: true,
      cwd,
      windowsHide: true,
      env: process.env,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      const out = truncate(stdout);
      const err = truncate(stderr);
      resolve({
        command,
        cwd,
        stdout: out.text,
        stderr: err.text,
        exitCode: null,
        timedOut: true,
        truncated: out.truncated || err.truncated,
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (!stdoutTruncated) {
        stdout += chunk.toString('utf-8');
        if (stdout.length > MAX_OUTPUT_CHARS * 2) {
          stdoutTruncated = true;
          stdout = stdout.slice(0, MAX_OUTPUT_CHARS);
          child.stdout.pause();
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (!stderrTruncated) {
        stderr += chunk.toString('utf-8');
        if (stderr.length > MAX_OUTPUT_CHARS * 2) {
          stderrTruncated = true;
          stderr = stderr.slice(0, MAX_OUTPUT_CHARS);
          child.stderr.pause();
        }
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = truncate(stdout);
      const err = truncate(stderr);
      resolve({
        command,
        cwd,
        stdout: out.text,
        stderr: err.text,
        exitCode: code,
        timedOut: false,
        truncated: out.truncated || err.truncated || stdoutTruncated || stderrTruncated,
      });
    });
  });
}
