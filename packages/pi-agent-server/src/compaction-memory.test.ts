import { expect, it } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadTool, type SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent';
import { archiveCompactionHistory } from './compaction-memory.ts';

function event(signal = new AbortController().signal): SessionBeforeCompactEvent {
  return { signal, preparation: {
    previousSummary: 'Earlier task can be found in the prior archive.',
    messagesToSummarize: [
      { role: 'user', content: 'Completed unrelated task: invoice INV-789, exact amount 123.45.', timestamp: 0 },
      { role: 'toolResult', toolCallId: 'call', toolName: 'read', timestamp: 1,
        content: [{ type: 'text', text: 'Evidence '.repeat(1000) + 'EXACT-TAIL-987' }, { type: 'image', data: 'BINARY-SECRET', mimeType: 'image/png' }] },
    ],
    turnPrefixMessages: [{ role: 'user', content: 'Current pending task TB-123', timestamp: 2 }],
    fileOps: { read: new Set(['old/invoice.csv']), edited: new Set(['active.ts']), written: new Set() },
  } } as unknown as SessionBeforeCompactEvent;
}

it('archives exact historical text and file operations; a fresh native read tool can recover it later', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'compaction-memory-'));
  try {
    const source = event();
    const original = JSON.stringify(source);
    const pointer = await archiveCompactionHistory(directory, source);
    expect(JSON.stringify(source)).toBe(original);
    const files = await readdir(join(directory, 'memory', 'compactions'));
    expect(files).toHaveLength(1);
    const path = join(directory, 'memory', 'compactions', files[0]!);
    expect(pointer).toContain(JSON.stringify(path));
    // Re-created tool, without any in-process memory/cache from archival.
    const result = await createReadTool(directory).execute('recover', { path });
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    expect(text).toContain('INV-789');
    expect(text).toContain('123.45');
    expect(text).toContain('EXACT-TAIL-987');
    expect(text).toContain('old/invoice.csv');
    expect(text).toContain('Current pending task TB-123');
    expect(text).not.toContain('BINARY-SECRET');
    expect(await archiveCompactionHistory(directory, event())).toBe(pointer);
    expect(await readdir(join(directory, 'memory', 'compactions'))).toEqual(files);
    const second = event();
    second.preparation.previousSummary = 'Second compaction; first archive is still available.';
    await archiveCompactionHistory(directory, second);
    expect(await readdir(join(directory, 'memory', 'compactions'))).toHaveLength(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('does not produce an archive pointer on a write failure or an abort', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'compaction-memory-fail-'));
  try {
    await writeFile(join(directory, 'memory'), 'not a directory');
    await expect(archiveCompactionHistory(directory, event())).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(archiveCompactionHistory(directory, event(controller.signal))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
