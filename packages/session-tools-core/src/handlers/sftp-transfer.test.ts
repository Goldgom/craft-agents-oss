import { describe, expect, it } from 'bun:test';
import type { SessionToolContext } from '../context.ts';
import { handleSftpTransfer } from './sftp-transfer.ts';

describe('handleSftpTransfer', () => {
  it('uses the client bridge and reports the resolved paths', async () => {
    const ctx = {
      transferSftpFileFn: async () => ({
        success: true as const,
        direction: 'upload' as const,
        localPath: 'C:\\data\\backup.zip',
        remotePath: '/srv/craft/backup.zip',
        bytes: 128,
      }),
    } as unknown as SessionToolContext;

    const result = await handleSftpTransfer(ctx, {
      direction: 'upload',
      localPath: 'C:\\data\\backup.zip',
      remotePath: 'backup.zip',
    });

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('128 bytes');
    expect(result.content[0]?.text).toContain('/srv/craft/backup.zip');
  });

  it('fails clearly when no desktop SFTP bridge is connected', async () => {
    const result = await handleSftpTransfer({} as unknown as SessionToolContext, {
      direction: 'download',
      localPath: 'C:\\data\\backup.zip',
      remotePath: 'backup.zip',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('SFTP transfer is not available');
  });
});
