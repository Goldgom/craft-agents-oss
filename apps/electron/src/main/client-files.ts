import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { CLIENT_FILE_MAX_BYTES, CLIENT_FILE_MAX_COUNT, type ClientFileSelection } from '@craft-agent/core/types';

/** Read only paths explicitly returned by the native picker, with bounded allocations. */
export async function readSelectedClientFiles(paths: string[], assertCurrent: () => void): Promise<ClientFileSelection> {
  if (paths.length > CLIENT_FILE_MAX_COUNT) throw new Error('Choose at most 5 files');
  let remaining = CLIENT_FILE_MAX_BYTES;
  const files: ClientFileSelection['files'] = [];
  for (const path of paths) {
    assertCurrent();
    const handle = await open(path, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > remaining) throw new Error('Choose regular files totaling at most 8 MiB');
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > info.size) throw new Error('File changed while reading; select it again');
      assertCurrent();
      remaining -= length;
      files.push({ name: basename(path), base64: buffer.subarray(0, length).toString('base64') });
    } finally { await handle.close(); }
  }
  assertCurrent();
  return { canceled: false, files };
}
