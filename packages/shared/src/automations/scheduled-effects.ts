import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, unlink, writeFile, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { appendAutomationHistoryEntry } from './history-store.ts';

function occurrenceDirectory(root: string, timestamp: number): string {
  return join(root, '.automation-in-flight', String(timestamp));
}

/** Claim a side effect before dispatch, so a process crash cannot silently replay it. */
export async function claimScheduledEffect(root: string, timestamp: number, matcherId: string, action: string): Promise<(() => Promise<void>) | undefined> {
  const directory = occurrenceDirectory(root, timestamp);
  await mkdir(directory, { recursive: true });
  const path = join(directory, createHash('sha256').update(JSON.stringify([matcherId, action])).digest('hex'));
  const handle = await open(path, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') return undefined;
    throw error;
  });
  if (!handle) {
    if (await readFile(path, 'utf8') !== 'recorded') {
      await appendAutomationHistoryEntry(root, {
        id: matcherId, ts: timestamp, ok: false, error: 'A previous scheduled attempt was interrupted. Its external outcome is unknown.',
      });
    }
    return undefined;
  }
  try { await handle.sync(); } finally { await handle.close(); }
  return () => writeFile(path, 'recorded', { flush: true });
}

/** The clock only retires receipts after the minute cursor is durable. */
export async function retireScheduledEffects(root: string, timestamp: number): Promise<void> {
  const directory = occurrenceDirectory(root, timestamp);
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (files.length === 0) return;
  await Promise.all(files.map(file => unlink(join(directory, file))));
  await rmdir(directory);
}
