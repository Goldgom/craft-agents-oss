import type { SessionToolContext } from '../context.ts'
import { errorResponse, successResponse } from '../response.ts'

export async function handleSuperAgentTask(ctx: SessionToolContext, args: Record<string, unknown>) {
  if (!ctx.superAgentTask) return errorResponse('This session is not an active Super Agent node.')
  try { return successResponse(JSON.stringify(await ctx.superAgentTask(args), null, 2)) }
  catch (error) { return errorResponse(error instanceof Error ? error.message : String(error)) }
}
