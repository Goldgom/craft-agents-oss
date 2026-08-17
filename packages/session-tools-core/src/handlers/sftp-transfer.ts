import type { SessionToolContext, SftpTransferArgs } from '../context.ts';
import { errorResponse, successResponse } from '../response.ts';
import type { ToolResult } from '../types.ts';

export async function handleSftpTransfer(
  ctx: SessionToolContext,
  args: SftpTransferArgs,
): Promise<ToolResult> {
  const transfer = ctx.transferSftpFileFn;
  if (!transfer) {
    return errorResponse('SFTP transfer is not available. Configure SFTP for the active remote server and keep the desktop client connected.');
  }

  try {
    const result = await transfer(args);
    return successResponse(
      `${result.direction === 'upload' ? 'Uploaded' : 'Downloaded'} ${result.bytes} bytes\n` +
      `local: ${result.localPath}\nremote: ${result.remotePath}`,
    );
  } catch (error) {
    return errorResponse(`SFTP transfer failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
