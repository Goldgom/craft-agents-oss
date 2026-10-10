import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CLIENT_FILE_MAX_BYTES, CLIENT_FILE_MAX_COUNT, type ClientFileSelection, type SavedClientFiles } from '@craft-agent/core/types';

/** Validate the entire response before writing. No client-supplied paths are used. */
export async function saveClientFiles(directory: string, selection: ClientFileSelection): Promise<SavedClientFiles> {
  if (!selection || typeof selection.canceled !== 'boolean' || !Array.isArray(selection.files)
    || selection.files.length > CLIENT_FILE_MAX_COUNT || (selection.canceled && selection.files.length)) {
    throw new Error('Invalid client file response');
  }
  let total = 0;
  const files = selection.files.map(file => {
    if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 255
      || typeof file.base64 !== 'string' || file.base64.length > Math.ceil(CLIENT_FILE_MAX_BYTES / 3) * 4
      || (file.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64))
      || (file.mimeType !== undefined && (typeof file.mimeType !== 'string' || file.mimeType.length > 255))) {
      throw new Error('Invalid client file data');
    }
    const data = Buffer.from(file.base64, 'base64');
    if (data.toString('base64') !== file.base64) throw new Error('Invalid base64 encoding');
    total += data.length;
    if (total > CLIENT_FILE_MAX_BYTES) throw new Error('Selected files exceed 8 MiB total');
    const safeName = file.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || 'file';
    return { file, data, path: join(directory, `${randomUUID()}-${safeName}`) };
  });
  if (files.length) await mkdir(directory, { recursive: true });
  for (const file of files) await writeFile(file.path, file.data, { flag: 'wx', mode: 0o600 });
  return { canceled: selection.canceled, files: files.map(({ file, data, path }) => ({ name: file.name, path, size: data.length, mimeType: file.mimeType })) };
}
