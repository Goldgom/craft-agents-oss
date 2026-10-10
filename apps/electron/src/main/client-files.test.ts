import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSelectedClientFiles } from './client-files';
import { CLIENT_FILE_MAX_BYTES } from '@craft-agent/core/types';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
test('selected binary content is returned without local paths; stale workspace prevents disclosure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-files-')); roots.push(root);
  const path = join(root, 'selected.bin'); await writeFile(path, Buffer.from([0, 255, 10]));
  const result = await readSelectedClientFiles([path], () => {});
  expect(result.files[0]!.base64).toBe('AP8K');
  expect(JSON.stringify(result)).not.toContain(root);
  let checks = 0;
  await expect(readSelectedClientFiles([path], () => { if (++checks === 2) throw new Error('workspace changed'); })).rejects.toThrow('workspace changed');
});
test('rejects directories and files beyond total budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-files-')); roots.push(root);
  await expect(readSelectedClientFiles([root], () => {})).rejects.toThrow();
  const path = join(root, 'large'); await writeFile(path, Buffer.alloc(CLIENT_FILE_MAX_BYTES + 1));
  await expect(readSelectedClientFiles([path], () => {})).rejects.toThrow('8 MiB');
});
