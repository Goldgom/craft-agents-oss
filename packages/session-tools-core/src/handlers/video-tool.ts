import type { SessionToolContext } from '../context.ts';
import { errorResponse, successResponse } from '../response.ts';
import { VideoToolSchema } from '../video-tools.ts';
import type { ToolResult } from '../types.ts';

export async function handleVideoTool(ctx: SessionToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const parsed = VideoToolSchema.safeParse(input);
  if (!parsed.success) return errorResponse('Invalid video action or arguments. Use state to inspect Video Studio first.');
  if (!ctx.videoToolFn) return errorResponse('Video tools are unavailable on this session host.');
  if (['delete_memory', 'delete_project'].includes(parsed.data.action) && parsed.data.args?.confirm !== true) {
    return errorResponse('Deleting a video project or memory requires explicit user intent and args.confirm=true.');
  }
  try { return successResponse(JSON.stringify(await ctx.videoToolFn(parsed.data), null, 2)); }
  catch (error) { return errorResponse(`Video action failed: ${error instanceof Error ? error.message : String(error)}`); }
}
