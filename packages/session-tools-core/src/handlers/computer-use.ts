import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';
import { ComputerUseSchema, type ComputerUseArgs } from '../computer-use.ts';

function scriptPath(): string | undefined {
  const root = process.env.CRAFT_SCRIPTS;
  const path = root && join(root, 'desktop-control.ps1');
  return path && existsSync(path) ? path : undefined;
}

function powershell(): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function execute(script: string, requestPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-RequestPath', requestPath], {
      windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(error.killed ? 'Desktop action timed out after 30 seconds; inspect the current desktop before retrying.' : stderr.trim() || error.message));
      else resolve(stdout.trim());
    });
  });
}

// The desktop is global: serialise captures and input across sessions.
let desktopQueue: Promise<unknown> = Promise.resolve();

async function perform(args: ComputerUseArgs): Promise<ToolResult> {
  const script = scriptPath();
  if (process.platform !== 'win32' || !script || !existsSync(powershell())) {
    const message = 'Computer use requires the Windows desktop app with its bundled desktop-control component. It operates on the Windows host running this session, not a remote client.';
    return args.action === 'status'
      ? successResponse(JSON.stringify({ available: false, platform: process.platform, reason: message }))
      : errorResponse(message);
  }
  const directory = await mkdtemp(join(tmpdir(), 'tokenbird-computer-'));
  try {
    const requestPath = join(directory, 'request.json');
    const imagePath = join(directory, 'screenshot.png');
    await writeFile(requestPath, JSON.stringify({ ...args, outputPath: imagePath }), 'utf8');
    const output = JSON.parse(await execute(script, requestPath));
    const result = successResponse(JSON.stringify({ ...output, executedOn: 'windows-host' }));
    if (args.action === 'screenshot') {
      const bytes = await readFile(imagePath);
      if (bytes.length > 12 * 1024 * 1024) return errorResponse('Screenshot exceeds 12 MB. Retry with a smaller maxWidth.');
      result.images = [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }];
    }
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function handleComputerUse(_ctx: SessionToolContext, input: ComputerUseArgs): Promise<ToolResult> {
  const parsed = ComputerUseSchema.safeParse(input);
  if (!parsed.success) return errorResponse(`Invalid computer_use arguments: ${parsed.error.message}`);
  const operation = desktopQueue.then(() => perform(parsed.data));
  desktopQueue = operation.catch(() => {});
  try { return await operation; }
  catch (error) { return errorResponse(`Computer use failed: ${error instanceof Error ? error.message : String(error)}`); }
}
