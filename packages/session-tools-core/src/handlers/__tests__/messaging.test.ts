/**
 * Messaging session tool handler tests (list / unbind / send media / send card).
 */

import { describe, expect, it } from 'bun:test';
import type { SessionToolContext } from '../../context.ts';
import type { ToolResult } from '../../types.ts';
import {
  handleListMessagingChannels,
  handleUnbindMessagingChannel,
  handleSendMessagingMedia,
  handleSendMessagingTemplateCard,
} from '../messaging.ts';

function makeFakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  return {
    exists: (p: string) => files.has(p),
    readFile: (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    readFileBuffer: (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return Buffer.from(v, 'utf-8');
    },
    writeFile: (p: string, content: string) => files.set(p, content),
    isDirectory: () => false,
    readdir: () => [],
    stat: (p: string) => ({ size: files.get(p)?.length ?? 0, isDirectory: () => false }),
  };
}

function makeFakeContext(overrides: Partial<SessionToolContext> = {}): SessionToolContext {
  return {
    sessionId: 'test-session',
    workspacePath: '/ws/test',
    get sourcesPath() { return '/ws/test/sources'; },
    get skillsPath() { return '/ws/test/skills'; },
    plansFolderPath: '/ws/test/plans',
    callbacks: { onPlanSubmitted: () => {}, onAuthRequest: () => {} },
    fs: makeFakeFs(),
    loadSourceConfig: () => null,
    ...overrides,
  } as SessionToolContext;
}

function textOf(result: ToolResult): string {
  const first = result.content[0];
  return first && first.type === 'text' ? first.text : JSON.stringify(result.content);
}

describe('handleListMessagingChannels', () => {
  it('lists bindings when the capability exists', async () => {
    const ctx = makeFakeContext({
      getMessagingBindings: () => [
        { platform: 'wecom', channelId: 'user-1', enabled: true },
        { platform: 'telegram', channelId: '-1001', threadId: 7, enabled: true },
      ],
    });
    const result = await handleListMessagingChannels(ctx, {});
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('wecom: user-1');
    expect(textOf(result)).toContain('Topic #7');
  });

  it('errors when messaging is not configured', async () => {
    const ctx = makeFakeContext();
    const result = await handleListMessagingChannels(ctx, {});
    expect(result.isError).toBe(true);
  });
});

describe('handleUnbindMessagingChannel', () => {
  it('reports the removed count', async () => {
    const ctx = makeFakeContext({ unbindMessagingChannel: () => 2 });
    const result = await handleUnbindMessagingChannel(ctx, { platform: 'wecom' });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('Unbound 2');
  });
});

describe('handleSendMessagingMedia', () => {
  it('reads the file and forwards voice data with the session id', async () => {
    let received: unknown;
    const ctx = makeFakeContext({
      fs: makeFakeFs({ '/tmp/reply.amr': 'amr-bytes' }),
      sendMessagingMedia: async (input) => {
        received = input;
        return { sent: 1, failed: 0, errors: [] };
      },
    });
    const result = await handleSendMessagingMedia(ctx, {
      kind: 'voice',
      filePath: '/tmp/reply.amr',
      caption: 'voice reply',
    });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('voice');
    expect(textOf(result)).toContain('1 channel');

    const sent = received as {
      sessionId: string;
      kind: string;
      data: Uint8Array;
      filename: string;
      caption?: string;
    };
    expect(sent.sessionId).toBe('test-session');
    expect(sent.kind).toBe('voice');
    expect(sent.filename).toBe('reply.amr');
    expect(Buffer.from(sent.data).toString('utf-8')).toBe('amr-bytes');
    expect(sent.caption).toBe('voice reply');
  });

  it('rejects missing files and oversized media', async () => {
    const noFile = await handleSendMessagingMedia(makeFakeContext({}), {
      kind: 'voice',
      filePath: '/nope.amr',
    });
    expect(noFile.isError).toBe(true);

    const big = makeFakeFs({ '/big.amr': 'x'.repeat(2 * 1024 * 1024 + 1) });
    const oversized = await handleSendMessagingMedia(
      makeFakeContext({
        fs: big,
        sendMessagingMedia: async () => ({ sent: 1, failed: 0, errors: [] }),
      }),
      {
        kind: 'voice',
        filePath: '/big.amr',
      },
    );
    expect(oversized.isError).toBe(true);
    expect(textOf(oversized)).toContain('too large');
  });

  it('reports per-channel failures', async () => {
    const ctx = makeFakeContext({
      fs: makeFakeFs({ '/ok.amr': 'audio' }),
      sendMessagingMedia: async () => ({ sent: 1, failed: 2, errors: ['telegram: unsupported'] }),
    });
    const result = await handleSendMessagingMedia(ctx, { kind: 'voice', filePath: '/ok.amr' });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('2 channel(s) failed');
    expect(textOf(result)).toContain('telegram: unsupported');
  });
});

describe('handleSendMessagingTemplateCard', () => {
  it('sends a card and validates card_type', async () => {
    let received: unknown;
    const ctx = makeFakeContext({
      sendMessagingTemplateCard: async (input) => {
        received = input;
        return { sent: 1, failed: 0, errors: [] };
      },
    });
    const card = { card_type: 'text_notice', main_title: { title: 'Hi' } };
    const result = await handleSendMessagingTemplateCard(ctx, { card });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('text_notice');
    expect((received as { sessionId: string }).sessionId).toBe('test-session');

    const bad = await handleSendMessagingTemplateCard(ctx, { card: { main_title: {} } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('card_type');
  });
});
