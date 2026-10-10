import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { saveClientFiles } from './client-files';
import { CLIENT_FILE_MAX_BYTES } from '@craft-agent/core/types';

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function directory() { const root = await mkdtemp(join(tmpdir(), 'client-files-')); roots.push(root); return join(root, 'selected'); }

describe('client files', () => {
  test('saves binary files within the session directory without trusting client paths or overwriting', async () => {
    const dir = await directory();
    const bytes = Buffer.from([0, 255, 128, 1]);
    const selection = { canceled: false, files: [{ name: '../../secret.bin', base64: bytes.toString('base64') }] };
    const first = await saveClientFiles(dir, selection);
    const second = await saveClientFiles(dir, selection);
    expect(dirname(first.files[0]!.path)).toBe(dir);
    expect(first.files[0]!.path).not.toBe(second.files[0]!.path);
    expect(await readFile(first.files[0]!.path)).toEqual(bytes);
    expect(first.files[0]!.size).toBe(4);
    expect(JSON.stringify(first)).not.toContain('base64');
  });
  test('cancellation creates no files', async () => {
    const dir = await directory();
    expect(await saveClientFiles(dir, { canceled: true, files: [] })).toEqual({ canceled: true, files: [] });
    expect(await readdir(dirname(dir))).toEqual([]);
  });
  test('rejects malformed or excessive data before writing any file', async () => {
    const dir = await directory();
    const file = { name: 'valid.txt', base64: 'aGk=' };
    await expect(saveClientFiles(dir, { canceled: false, files: [file, { ...file, base64: '!!!!' }] })).rejects.toThrow();
    await expect(saveClientFiles(dir, { canceled: true, files: [file] })).rejects.toThrow();
    await expect(saveClientFiles(dir, { canceled: false, files: Array(6).fill(file) })).rejects.toThrow();
    const big = Buffer.alloc(CLIENT_FILE_MAX_BYTES).toString('base64');
    await expect(saveClientFiles(dir, { canceled: false, files: [{ name: 'big', base64: big }, file] })).rejects.toThrow('8 MiB');
    expect(await readdir(dirname(dir))).toEqual([]);
  });
});
