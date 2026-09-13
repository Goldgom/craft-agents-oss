import { describe, expect, it } from 'bun:test';
import type { SessionToolContext } from '../context.ts';
import { handleCollaborationFile } from './collaboration-file.ts';

describe('handleCollaborationFile', () => {
  it('publishes a local file through the session-bound callback', async () => {
    const calls: unknown[][] = [];
    const ctx = {
      putCollaborationFile: async (...args: unknown[]) => {
        calls.push(args);
        return { file: { id: 'file-1', name: 'notes.txt' } };
      },
    } as unknown as SessionToolContext;
    const result = await handleCollaborationFile(ctx, {
      action: 'put',
      path: 'C:\\workspace\\notes.txt',
      name: 'notes.txt',
      contentType: 'text/plain',
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([['C:\\workspace\\notes.txt', 'notes.txt', 'text/plain']]);
  });

  it('materializes a shared file through the session-bound callback', async () => {
    const ctx = {
      getCollaborationFile: async (fileId: string) => ({ fileId, path: '/workspace/shared/notes.txt' }),
    } as unknown as SessionToolContext;
    const result = await handleCollaborationFile(ctx, { action: 'get', fileId: 'file-1' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain('/workspace/shared/notes.txt');
  });

  it('does not pretend file storage exists when the session is not in a collaboration', async () => {
    const result = await handleCollaborationFile({} as SessionToolContext, { action: 'get', fileId: 'file-1' });
    expect(result.isError).toBe(true);
  });
});
