import { describe, expect, it } from 'bun:test';
import { extractChatGptAccountId, NativeCodexAgent } from './native-codex-agent.ts';
import { AbortReason, type BackendConfig } from './backend/types.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function createAgent(overrides: Partial<BackendConfig> = {}): NativeCodexAgent {
  const now = Date.now();
  return new NativeCodexAgent({
    provider: 'pi',
    providerType: 'pi',
    authType: 'none',
    agentRuntime: 'codex',
    workspace: { id: 'test', name: 'Test', slug: 'test', rootPath: process.cwd(), createdAt: now },
    session: { id: 'test-session', name: 'Test', workspaceRootPath: process.cwd(), createdAt: now, lastUsedAt: now, permissionMode: 'ask' },
    isHeadless: true,
    ...overrides,
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
  it('isolates managed Codex configuration by TokenBird connection', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'tokenbird-codex-home-'));
    const previous = process.env.TOKENBIRD_CONFIG_DIR;
    process.env.TOKENBIRD_CONFIG_DIR = configRoot;
    const agent = createAgent({ authType: 'api_key', connectionSlug: 'deepseek-primary' });
    try {
      const env = await agent['buildCodexEnvironment']();
      expect(env?.CODEX_HOME).toBe(join(configRoot, 'codex', 'connections', 'deepseek-primary'));
      expect(env?.CODEX_HOME).not.toContain('.codex-native');
    } finally {
      agent.destroy();
      if (previous === undefined) delete process.env.TOKENBIRD_CONFIG_DIR;
      else process.env.TOKENBIRD_CONFIG_DIR = previous;
      await rm(configRoot, { recursive: true, force: true });
    }
  });

  it('uses non-reserved transport aliases for Craft dynamic tools', () => {
    const agent = createAgent();
    const tools = agent['buildDynamicTools']();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every(tool => tool.name.startsWith('craft__'))).toBe(true);
    expect(tools.some(tool => tool.name.startsWith('mcp__'))).toBe(false);
    expect(agent['nativeToolAliases'].get('craft__session__call_llm')).toBe('mcp__session__call_llm');
    agent.destroy();
  });

  it('registers MCP tools when restoring a persisted Codex session', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let cleared = 0;
    const agent = createAgent({
      session: { id: 'test-session', name: 'Test', workspaceRootPath: process.cwd(), createdAt: Date.now(), lastUsedAt: Date.now(), permissionMode: 'ask', sdkSessionId: 'persisted-thread' },
      mcpPool: {
        getProxyToolDefs: () => [{ name: 'mcp__beecount__List_Ledgers', description: 'List ledgers', inputSchema: { type: 'object', properties: {} } }],
        disconnectAll: async () => {},
      } as never,
      onSdkSessionIdCleared: () => { cleared++; },
    });
    const client = {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return { thread: { id: 'new-thread' } };
      },
    } as never;

    expect(await agent['ensureThread'](client)).toBe('new-thread');
    expect(calls.map(call => call.method)).toEqual(['thread/start']);
    expect((calls[0]!.params.dynamicTools as Array<{ name: string }>).some(tool => tool.name === 'craft__beecount__List_Ledgers')).toBe(true);
    expect(cleared).toBe(1);

    expect(await agent['ensureThread'](client)).toBe('new-thread');
    expect(calls).toHaveLength(1);
    agent.destroy();
  });

  it('rebuilds the Codex thread when a connected source exposes new tools', async () => {
    let sourceTools: Array<{ name: string; description: string; inputSchema: { type: string; properties: Record<string, never> } }> = [];
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const agent = createAgent({
      mcpPool: { getProxyToolDefs: () => sourceTools, disconnectAll: async () => {} } as never,
    });
    const client = {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return { thread: { id: `thread-${calls.length}` } };
      },
    } as never;

    expect(await agent['ensureThread'](client)).toBe('thread-1');
    sourceTools = [{ name: 'mcp__beecount__List_Ledgers', description: 'List ledgers', inputSchema: { type: 'object', properties: {} } }];
    expect(await agent['ensureThread'](client)).toBe('thread-2');
    expect(calls.map(call => call.method)).toEqual(['thread/start', 'thread/start']);
    expect((calls[1]!.params.dynamicTools as Array<{ name: string }>).some(tool => tool.name === 'craft__beecount__List_Ledgers')).toBe(true);
    agent.destroy();
  });

  it('registers current tools again after a Codex app-server reconnect', async () => {
    const calls: string[] = [];
    const agent = createAgent();
    const makeClient = (id: string) => ({
      request: async (method: string) => {
        calls.push(method);
        return { thread: { id } };
      },
    }) as never;

    expect(await agent['ensureThread'](makeClient('first'))).toBe('first');
    expect(await agent['ensureThread'](makeClient('second'))).toBe('second');
    expect(calls).toEqual(['thread/start', 'thread/start']);
    agent.destroy();
  });

  it('sets the Codex native auto-compaction token limit on the thread', async () => {
    let params: Record<string, unknown> | undefined;
    const agent = createAgent({ modelPromptSettings: { autoCompactionTokenLimit: 80_000 } });
    const client = { request: async (_method: string, requestParams: Record<string, unknown>) => {
      params = requestParams;
      return { thread: { id: 'configured-thread' } };
    } } as never;
    await agent['ensureThread'](client);
    expect(params?.config).toEqual({ model_auto_compact_token_limit: 80_000 });
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
