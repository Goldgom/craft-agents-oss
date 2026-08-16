/**
 * Messaging session tools — list bindings, unbind channels, and send media
 * / template cards to bound channels.
 *
 * NOTE: Binding is done via pairing codes (chat-side or UI-side),
 * not via arbitrary channelId from the agent. This prevents the agent
 * from binding sessions to channels it shouldn't have access to.
 */

import { basename } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

// ---------------------------------------------------------------------------
// list_messaging_channels
// ---------------------------------------------------------------------------

export interface ListMessagingChannelsArgs {
  sessionId?: string;
}

export async function handleListMessagingChannels(
  ctx: SessionToolContext,
  args: ListMessagingChannelsArgs,
): Promise<ToolResult> {
  if (!ctx.getMessagingBindings) {
    return errorResponse('Messaging is not configured for this workspace.');
  }

  try {
    const sessionId = args.sessionId ?? ctx.sessionId;
    const bindings = ctx.getMessagingBindings(sessionId);

    if (bindings.length === 0) {
      return successResponse(`No messaging channels bound to session ${sessionId}.`);
    }

    const lines = bindings.map((b) => {
      const baseLabel = b.channelName || b.channelId;
      // Topic-bound bindings (Telegram supergroup forums) read as
      // "Group › Topic" so the model can disambiguate two topics in the
      // same supergroup. DMs and pre-topics bindings render unchanged.
      const channelLabel = b.threadId !== undefined
        ? `${baseLabel} › Topic #${b.threadId}`
        : baseLabel;
      return `- ${b.platform}: ${channelLabel} (${b.enabled ? 'active' : 'disabled'})`;
    });

    return successResponse(
      `Messaging bindings for session ${sessionId}:\n${lines.join('\n')}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to list messaging channels: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// unbind_messaging_channel
// ---------------------------------------------------------------------------

export interface UnbindMessagingChannelArgs {
  platform?: 'telegram' | 'whatsapp' | 'lark' | 'wecom';
}

export async function handleUnbindMessagingChannel(
  ctx: SessionToolContext,
  args: UnbindMessagingChannelArgs,
): Promise<ToolResult> {
  if (!ctx.unbindMessagingChannel) {
    return errorResponse('Messaging is not configured for this workspace.');
  }

  try {
    const removed = ctx.unbindMessagingChannel(ctx.sessionId, args.platform);
    if (removed > 0) {
      const platformLabel = args.platform ?? 'all platforms';
      return successResponse(`Unbound ${removed} messaging channel(s) for ${platformLabel}.`);
    }
    return successResponse('No messaging channels were bound to this session.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to unbind messaging channel: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// send_messaging_media
// ---------------------------------------------------------------------------

/** Platform media size ceilings (WeCom long-connection limits). */
const MEDIA_MAX_BYTES: Record<'voice' | 'image' | 'video' | 'file', number> = {
  voice: 2 * 1024 * 1024, // amr
  image: 10 * 1024 * 1024, // png / jpg / gif
  video: 10 * 1024 * 1024, // mp4
  file: 20 * 1024 * 1024,
};

export interface SendMessagingMediaArgs {
  sessionId?: string;
  kind: 'voice' | 'image' | 'video' | 'file';
  filePath: string;
  filename?: string;
  caption?: string;
}

export async function handleSendMessagingMedia(
  ctx: SessionToolContext,
  args: SendMessagingMediaArgs,
): Promise<ToolResult> {
  if (!ctx.sendMessagingMedia) {
    return errorResponse('Messaging is not configured for this workspace.');
  }

  const maxBytes = MEDIA_MAX_BYTES[args.kind];
  let data: Buffer;
  try {
    data = ctx.fs.readFileBuffer(args.filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to read media file: ${message}`);
  }

  if (data.length === 0) {
    return errorResponse('Media file is empty.');
  }
  if (data.length > maxBytes) {
    return errorResponse(
      `Media file is too large for kind "${args.kind}": ${data.length} bytes (max ${maxBytes}).`,
    );
  }

  const filename = args.filename?.trim() || basename(args.filePath);

  try {
    const result = await ctx.sendMessagingMedia({
      sessionId: args.sessionId ?? ctx.sessionId,
      kind: args.kind,
      data,
      filename,
      ...(args.caption ? { caption: args.caption } : {}),
    });
    const summary = [`Sent ${args.kind} "${filename}" to ${result.sent} channel(s).`];
    if (result.failed > 0) {
      summary.push(`${result.failed} channel(s) failed: ${result.errors.join('; ')}`);
    }
    return successResponse(summary.join('\n'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to send messaging media: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// send_messaging_template_card
// ---------------------------------------------------------------------------

export interface SendMessagingTemplateCardArgs {
  sessionId?: string;
  card: Record<string, unknown>;
}

export async function handleSendMessagingTemplateCard(
  ctx: SessionToolContext,
  args: SendMessagingTemplateCardArgs,
): Promise<ToolResult> {
  if (!ctx.sendMessagingTemplateCard) {
    return errorResponse('Messaging is not configured for this workspace.');
  }

  const cardType = args.card?.card_type;
  if (typeof cardType !== 'string' || cardType.length === 0) {
    return errorResponse('Template card must carry a non-empty `card_type` string (e.g. text_notice, button_interaction).');
  }

  try {
    const result = await ctx.sendMessagingTemplateCard({
      sessionId: args.sessionId ?? ctx.sessionId,
      card: args.card,
    });
    const summary = [`Sent ${cardType} card to ${result.sent} channel(s).`];
    if (result.failed > 0) {
      summary.push(`${result.failed} channel(s) failed: ${result.errors.join('; ')}`);
    }
    return successResponse(summary.join('\n'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to send messaging template card: ${message}`);
  }
}
