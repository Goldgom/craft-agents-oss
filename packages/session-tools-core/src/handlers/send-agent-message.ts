import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface SendAgentMessageArgs {
  sessionId?: string;
  targetMemberId?: string;
  message: string;
  attachments?: Array<{ path: string; name?: string }>;
}

export async function handleSendAgentMessage(
  ctx: SessionToolContext,
  args: SendAgentMessageArgs
): Promise<ToolResult> {
  if (args.targetMemberId !== undefined) {
    if (args.sessionId !== undefined || !args.targetMemberId.trim() || args.attachments?.length || !args.message?.trim()) return errorResponse('Supply only targetMemberId and a non-empty message; publish shared files separately.');
    if (!ctx.sendCollaborationMessage) return errorResponse('Multi-server collaboration messaging is unavailable.');
    try {
      const result = await ctx.sendCollaborationMessage(args.targetMemberId, args.message);
      if (result.delivery === 'queued-for-relay') return successResponse(`Message saved for relay to member ${args.targetMemberId}. Keep the Electron app running. Do not repeat this operation${result.operationId ? ` (${result.operationId})` : ''}; acceptance and completion are separate.`);
      return successResponse(`Message ${result.delivery} for member ${args.targetMemberId}; this is acceptance, not completion.`);
    } catch { return errorResponse('Collaboration message could not be accepted. Check group membership and relay status.'); }
  }
  if (!ctx.sendAgentMessage) {
    return errorResponse('send_agent_message is not available in this context.');
  }

  if (!args.sessionId?.trim()) {
    return errorResponse('sessionId is required.');
  }

  if (!args.message?.trim()) {
    return errorResponse('message is required.');
  }

  // Prevent self-send (would create a recursive loop)
  if (args.sessionId === ctx.sessionId) {
    return errorResponse('Cannot send a message to your own session. Use a different sessionId.');
  }

  try {
    // Build sender envelope so the target session knows who sent the message
    const senderName = ctx.getSessionInfo?.()?.name ?? ctx.sessionId;
    const wrappedMessage = [
      `[Message from session "${ctx.sessionId}" (${senderName})]`,
      `Use send_agent_message with sessionId "${ctx.sessionId}" to reply.`,
      '',
      '---',
      '',
      args.message,
    ].join('\n');

    const result = await ctx.sendAgentMessage(args.sessionId, wrappedMessage, args.attachments);

    // Report the real delivery status instead of an unconditional "sent". A busy
    // target queues the message behind its current turn; an idle target starts
    // now. This is what lets the sender avoid guessing (e.g. never invent "the
    // app restarted") — for actual task status, call list_background_tasks.
    if (result.delivery === 'queued') {
      return successResponse(
        `Message queued for session ${args.sessionId}. ` +
          (result.targetBusy ? 'It will handle your message after the current turn finishes. ' : 'It will handle your message when its scheduler starts the next turn. ') +
          `Do not assume it was read yet; ` +
          `wait for a reply or query status before concluding anything.`
      );
    }

    return successResponse(
      `Message delivered to session ${args.sessionId}; it will start processing independently now.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to send message: ${message}`);
  }
}
