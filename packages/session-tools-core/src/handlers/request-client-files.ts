import type { ClientFileRequest } from '@craft-agent/core/types';
import type { SessionToolContext } from '../context.ts';
import { errorResponse, successResponse } from '../response.ts';

export async function handleRequestClientFiles(ctx: SessionToolContext, args: ClientFileRequest) {
  if (!ctx.requestClientFilesFn) return errorResponse('The current connection does not support requesting files. Ask the user to attach them.');
  try {
    return successResponse(JSON.stringify(await ctx.requestClientFilesFn(args)));
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : String(error));
  }
}
