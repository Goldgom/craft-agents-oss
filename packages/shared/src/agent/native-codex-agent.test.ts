import { describe, expect, it } from 'bun:test';
import { extractChatGptAccountId, NativeCodexAgent } from './native-codex-agent.ts';
import { AbortReason } from './backend/types.ts';

function createAgent(): NativeCodexAgent {
  const now = Date.now();
  return new NativeCodexAgent({
    provider: 'pi',
    providerType: 'pi',
    authType: 'none',
    agentRuntime: 'codex',
    workspace: { id: 'test', name: 'Test', slug: 'test', rootPath: process.cwd(), createdAt: now },
    session: { id: 'test-session', name: 'Test', workspaceRootPath: process.cwd(), createdAt: now, lastUsedAt: now, permissionMode: 'ask' },
    isHeadless: true,
  }, { path: 'codex', source: 'PATH', version: '0.154.0', testedProtocol: true });
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.`;
}

describe('extractChatGptAccountId', () => {
  it('reads the namespaced OpenAI auth claim without exposing token data', () => {
    const token = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_test_123' } });
    expect(extractChatGptAccountId(token)).toBe('acct_test_123');
  });

  it('fails closed for malformed tokens', () => {
    expect(extractChatGptAccountId('not-a-jwt')).toBeNull();
  });

  it('does not substitute an organization id for the ChatGPT account id', () => {
    const token = jwt({ 'https://api.openai.com/auth': { organizations: [{ id: 'org-not-an-account' }] } });
    expect(extractChatGptAccountId(token)).toBeNull();
  });
});

describe('NativeCodexAgent protocol adaptation', () => {
  it('uses non-reserved transport aliases for Craft dynamic tools', () => {
    const agent = createAgent();
    const tools = agent['buildDynamicTools']();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every(tool => tool.name.startsWith('craft__'))).toBe(true);
    expect(tools.some(tool => tool.name.startsWith('mcp__'))).toBe(false);
    expect(agent['nativeToolAliases'].get('craft__session__call_llm')).toBe('mcp__session__call_llm');
    agent.destroy();
  });

  it('preserves the full Craft thinking-level range in Codex effort values', () => {
    const agent = createAgent();
    expect(agent['reasoningEffort']('off')).toBe('minimal');
    expect(agent['reasoningEffort']('low')).toBe('low');
    expect(agent['reasoningEffort']('medium')).toBe('medium');
    expect(agent['reasoningEffort']('high')).toBe('high');
    expect(agent['reasoningEffort']('xhigh')).toBe('xhigh');
    expect(agent['reasoningEffort']('max')).toBe('ultra');
    agent.destroy();
  });

  it('maps streamed text, usage, and completion into Craft events', async () => {
    const agent = createAgent();
    agent['queue'].reset();
    agent['processing'] = true;
    agent['codexThreadId'] = 'thread-1';
    agent['currentTurnId'] = 'pending';
    agent['handleNotification']('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
    agent['handleNotification']('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'Hello' });
    agent['handleNotification']('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'message-1', text: 'Hello' } });
    agent['handleNotification']('thread/tokenUsage/updated', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        total: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
        last: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
        modelContextWindow: 200_000,
      },
    });
    agent['handleNotification']('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', error: null, items: [] },
    });

    const events = [];
    for await (const event of agent['queue'].drain()) events.push(event);
    expect(events.map(event => event.type)).toEqual(['text_delta', 'text_complete', 'usage_update', 'complete']);
    expect(events.at(-1)).toMatchObject({ type: 'complete', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 } });
    agent.destroy();
  });

  it('does not let a late turn/started notification replace the active turn', () => {
    const agent = createAgent();
    agent['processing'] = true;
    agent['codexThreadId'] = 'thread-1';
    agent['currentTurnId'] = 'turn-new';
    agent['rememberIgnoredTurn']('turn-old');

    agent['handleNotification']('turn/started', { threadId: 'thread-1', turn: { id: 'turn-old' } });

    expect(agent['currentTurnId']).toBe('turn-new');
    agent.destroy();
  });

  it('keeps processing locked until an aborted generator reaches its finally block', () => {
    const agent = createAgent();
    agent['processing'] = true;
    agent['currentTurnId'] = 'turn-1';

    agent.forceAbort(AbortReason.UserStop);

    expect(agent.isProcessing()).toBe(true);
    expect(agent['ignoredTurnIds'].has('turn-1')).toBe(true);
    agent.destroy();
  });

  it('drains sibling tool results before restarting for source activation', async () => {
    const agent = createAgent();
    const fakeClient = {
      isConnected: true,
      request: async (method: string) => {
        if (method === 'turn/start') {
          agent.setPendingSourceActivationRestart({ sourceSlug: 'docs', userMessage: 'retry me' });
          agent['queue'].enqueue({ type: 'tool_result', toolUseId: 'a', toolName: 'source_test', result: 'ok', isError: false });
          agent['queue'].enqueue({ type: 'tool_result', toolUseId: 'b', toolName: 'other', result: 'ok', isError: false });
          agent['queue'].enqueue({ type: 'text_delta', text: 'must not leak' });
          return { turn: { id: 'turn-1', status: 'inProgress', error: null, items: [] } };
        }
        return {};
      },
    };
    agent['ensureClient'] = async () => fakeClient as never;
    agent['ensureThread'] = async () => {
      agent['codexThreadId'] = 'thread-1';
      return 'thread-1';
    };
    agent['authenticated'] = true;

    const events = [];
    for await (const event of agent['chatImpl']('retry me')) events.push(event);

    expect(events.map(event => event.type)).toEqual(['tool_result', 'tool_result', 'source_activated']);
    expect(events.at(-1)).toMatchObject({ sourceSlug: 'docs', originalMessage: 'retry me' });
    agent.destroy();
  });
});
