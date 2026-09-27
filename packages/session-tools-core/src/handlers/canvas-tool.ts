import type { SessionToolContext } from '../context.ts';
import { errorResponse, successResponse } from '../response.ts';
import type { ToolResult } from '../types.ts';

/** The desktop owns Studio's IndexedDB and pixel canvases, so execution crosses the client capability. */
export async function handleCanvasTool(ctx: SessionToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.canvasToolFn) return errorResponse('Canvas tools require a connected TokenBird desktop client.');
  try {
    return successResponse(JSON.stringify(await ctx.canvasToolFn(args), null, 2));
  } catch (error) {
    return errorResponse(`Canvas action failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
