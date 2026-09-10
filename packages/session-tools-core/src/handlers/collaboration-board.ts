import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export type CollaborationBoardArgs =
  | { action: 'get' }
  | { action: 'set'; itemId: string; value: unknown };

/**
 * Read or update the durable board owned by the invoking session's
 * collaboration. Identity and revision handling stay behind the context
 * callback so an agent cannot impersonate another member.
 */
export async function handleCollaborationBoard(
  ctx: SessionToolContext,
  args: CollaborationBoardArgs,
): Promise<ToolResult> {
  try {
    if (args.action === 'get') {
      if (!ctx.getCollaboration) {
        return errorResponse('This session is not connected to collaboration storage.');
      }
      const snapshot = await ctx.getCollaboration();
      return successResponse(JSON.stringify(snapshot, null, 2));
    }

    if (!ctx.updateCollaborationBoard) {
      return errorResponse('This session is not connected to collaboration storage.');
    }
    if (!args.itemId?.trim()) {
      return errorResponse('itemId is required.');
    }
    const snapshot = await ctx.updateCollaborationBoard(args.itemId.trim(), args.value);
    return successResponse(JSON.stringify(snapshot, null, 2));
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Collaboration board operation failed.');
  }
}
