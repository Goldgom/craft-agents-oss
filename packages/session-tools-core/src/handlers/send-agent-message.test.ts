import { describe, it, expect } from 'bun:test';
import { handleSendAgentMessage } from './send-agent-message.ts';
import type { SessionToolContext, SendAgentMessageResult } from '../context.ts';

function createCtx(
  result: SendAgentMessageResult,
  opts?: { name?: string },
): { ctx: SessionToolContext; calls: Array<{ sessionId: string; message: string }> } {
  const calls: Array<{ sessionId: string; message: string }> = [];
  const ctx = {
    sessionId: 'sender-1',
    getSessionInfo: () => (opts?.name ? ({ name: opts.name } as never) : null),
    sendAgentMessage: async (sessionId: string, message: string) => {
      calls.push({ sessionId, message });
      return result;
    },
  } as unknown as SessionToolContext;
  return { ctx, calls };
}

describe('handleSendAgentMessage delivery ack', () => {
  it('reports a delivered ack when the target was idle', async () => {
    const { ctx } = createCtx({ delivery: 'delivered', targetBusy: false });
    const res = await handleSendAgentMessage(ctx, { sessionId: 'target-9', message: 'hi' });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res)).toContain('delivered');
  });

  it('reports a queued (busy) ack when the target was mid-turn', async () => {
    const { ctx } = createCtx({ delivery: 'queued', targetBusy: true });
    const res = await handleSendAgentMessage(ctx, { sessionId: 'target-9', message: 'status?' });
    expect(res.isError).toBeFalsy();
    const text = JSON.stringify(res);
    expect(text).toContain('queued');
    // Must warn the sender not to assume the message was read yet.
    expect(text.toLowerCase()).toContain('do not assume it was read');
  });

  it('wraps the message with a sender envelope', async () => {
    const { ctx, calls } = createCtx({ delivery: 'delivered', targetBusy: false }, { name: 'Monitor' });
    await handleSendAgentMessage(ctx, { sessionId: 'target-9', message: 'ping' });
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain('sender-1');
    expect(calls[0].message).toContain('ping');
  });

  it('rejects a self-send', async () => {
    const { ctx } = createCtx({ delivery: 'delivered', targetBusy: false });
    const res = await handleSendAgentMessage(ctx, { sessionId: 'sender-1', message: 'loop' });
    expect(res.isError).toBe(true);
  });
});

it('routes relay messages by member ID without a misleading bare-session reply envelope', async () => {
  const calls: unknown[][] = [];
  const ctx = { sessionId: 'primary', sendCollaborationMessage: async (...args: unknown[]) => { calls.push(args); return { delivery: 'queued-for-relay', targetBusy: false, operationId: 'stable-operation' }; } } as unknown as SessionToolContext;
  const result = await handleSendAgentMessage(ctx, { targetMemberId: 'primary', message: 'A remote session can have the same bare ID' });
  expect(result.isError).toBeFalsy();
  expect(calls).toEqual([['primary', 'A remote session can have the same bare ID']]);
  expect(JSON.stringify(result)).toContain('Do not repeat');
  expect(JSON.stringify(result)).toContain('stable-operation');
});

it('rejects ambiguous relay targets and direct attachments before invoking the callback', async () => {
  let calls = 0;
  const ctx = { sendCollaborationMessage: async () => { calls++; return { delivery: 'queued-for-relay', targetBusy: false }; } } as unknown as SessionToolContext;
  expect((await handleSendAgentMessage(ctx, { sessionId: 'x', targetMemberId: 'primary', message: 'no' })).isError).toBe(true);
  expect((await handleSendAgentMessage(ctx, { targetMemberId: 'primary', message: 'no', attachments: [{ path: '/private' }] })).isError).toBe(true);
  expect(calls).toBe(0);
});
