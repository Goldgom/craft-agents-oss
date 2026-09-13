import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export type CollaborationFileArgs =
  { action: 'put' | 'get'; path?: string; name?: string; contentType?: string; fileId?: string };

export async function handleCollaborationFile(
  ctx: SessionToolContext,
  args: CollaborationFileArgs,
): Promise<ToolResult> {
  try {
    if (args.action === 'put') {
      if (!ctx.putCollaborationFile) {
        return errorResponse('This session is not connected to collaboration file storage.');
      }
      if (!args.path?.trim()) return errorResponse('path is required.');
      const result = await ctx.putCollaborationFile(args.path.trim(), args.name?.trim(), args.contentType?.trim());
      return successResponse(JSON.stringify(result, null, 2));
    }

    if (!ctx.getCollaborationFile) {
      return errorResponse('This session is not connected to collaboration file storage.');
    }
    if (!args.fileId?.trim()) return errorResponse('fileId is required.');
    const result = await ctx.getCollaborationFile(args.fileId.trim());
    return successResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Collaboration file operation failed.');
  }
}
