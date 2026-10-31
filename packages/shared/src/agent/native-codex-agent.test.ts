import { describe, expect, it, spyOn } from 'bun:test';
import { extractChatGptAccountId, NativeCodexAgent } from './native-codex-agent.ts';
import { NativeCodexAppServerClient } from '../codex/native-app-server-client.ts';
import { AbortReason, type BackendConfig } from './backend/types.ts';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setSessionExecutionPolicy, clearSessionExecutionPolicy } from './core/session-execution-policy.ts';
import * as preferences from '../config/preferences.ts';
import { COMPACT_AGENT } from '../agents/types.ts';

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
  it('refreshes commit attribution on the next turn and reuses an unchanged thread', async () => {
    let enabled = false;
    const preference = spyOn(preferences, 'getCoAuthorPreference').mockImplementation(() => enabled);
    const calls: Array<{ params: Record<string, unknown> }> = [];
    const agent = createAgent();
    const client = {
      request: async (_method: string, params: Record<string, unknown>) => {
        calls.push({ params });
        return { thread: { id: `thread-${calls.length}` } };
      },
    } as never;
    try {
      expect(await agent['ensureThread'](client)).toBe('thread-1');
      expect(String(calls[0]!.params.developerInstructions)).not.toContain('Co-Authored-By:');
      expect(await agent['ensureThread'](client)).toBe('thread-1');
      enabled = true;
      expect(await agent['ensureThread'](client)).toBe('thread-2');
      expect(String(calls[1]!.params.developerInstructions)).toContain('Co-Authored-By: TokenBird');
      enabled = false;
      expect(await agent['ensureThread'](client)).toBe('thread-3');
      expect(String(calls[2]!.params.developerInstructions)).not.toContain('Co-Authored-By:');
      expect(await agent['ensureThread'](client)).toBe('thread-3');
      expect(calls).toHaveLength(3);
    } finally {
      preference.mockRestore();
      agent.destroy();
    }
  }, 60000);

  it('returns desktop screenshot images to the native model with their tool result', async () => {
    const agent = createAgent()
    const replies: unknown[] = []
    const client = { respond: async (_id: unknown, result: unknown) => { replies.push(result) }, disconnect: async () => {} } as never
    agent['client'] = client
    agent['processing'] = true
    agent['codexThreadId'] = 'thread-image'
    agent['currentTurnId'] = 'turn-image'
    agent['nativeToolAliases'].set('tokenbird__session__computer_use', 'mcp__session__computer_use')
    agent['hostTools'].execute = async () => ({ content: '{"scale":0.5}', isError: false, images: [{ type: 'image', mimeType: 'image/png', data: 'c2NyZWVu' }] })
    try {
      await agent['handleDynamicToolCall'](client, { id: 'image-call', method: 'item/tool/call', params: {} }, {
        threadId: 'thread-image', turnId: 'turn-image', callId: 'screenshot', namespace: null, tool: 'tokenbird__session__computer_use', arguments: { action: 'screenshot' },
      })
      expect(replies).toEqual([{ success: true, contentItems: [{ type: 'inputText', text: '{"scale":0.5}' }, { type: 'inputImage', imageUrl: 'data:image/png;base64,c2NyZWVu' }] }])
    } finally { agent.destroy() }
  })
  it('rejects native command, patch and permission escalation approvals in policy-enforced mode', async () => {
    const agent = createAgent();
    const replies: unknown[] = [];
    setSessionExecutionPolicy('test-session', { nodeId: 'worker', role: 'worker', rootPath: process.cwd(),
      readFiles: true, writeFiles: true, runPrograms: true, browser: false, allowSources: [], allowSubagents: false });
    const client = { respond: async (_id: unknown, result: unknown) => { replies.push(result); } } as never;
    try {
      agent.setPermissionMode('allow-all');
      await agent['handleApproval'](client, { id: 'command', method: '', params: {} }, 'Bash', {} as never,
        { decision: 'decline' }, () => ({ decision: 'accept' }));
      await agent['handleApproval'](client, { id: 'patch', method: '', params: {} }, 'Edit', {} as never,
        { decision: 'decline' }, () => ({ decision: 'accept' }));
      await agent['handlePermissionsApproval'](client, { id: 'permissions', method: '', params: {} },
        { permissions: { network: { enabled: true } } } as never);
      expect(replies).toEqual([{ decision: 'decline' }, { decision: 'decline' }, { permissions: {}, scope: 'turn' }]);
    } finally { clearSessionExecutionPolicy('test-session'); agent.destroy(); }
  });

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

  it('uses non-reserved transport aliases for TokenBird dynamic tools', () => {
    const agent = createAgent();
    const tools = agent['buildDynamicTools']();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every(tool => tool.name.startsWith('tokenbird__'))).toBe(true);
    expect(tools.some(tool => tool.name.startsWith('mcp__'))).toBe(false);
    expect(agent['nativeToolAliases'].get('tokenbird__session__call_llm')).toBe('mcp__session__call_llm');
    agent.destroy();
  });

  it('uses a clean home for managed policy nodes without copying global login credentials', async () => {
    const agent = createAgent({ authType: 'api_key', connectionSlug: 'openai-managed' });
    setSessionExecutionPolicy('test-session', { nodeId: 'worker', role: 'worker', rootPath: process.cwd(),
      readFiles: true, writeFiles: true, runPrograms: false, browser: false, allowSources: [], allowSubagents: false });
    try {
      const env = await agent['buildCodexEnvironment']();
      expect(env!.CODEX_HOME).toContain(join('codex', 'controlled', 'host-'));
      expect(await readFile(join(env!.CODEX_HOME!, 'config.toml'), 'utf8')).toContain('trust_level = "untrusted"');
      expect(await readFile(join(env!.CODEX_HOME!, 'auth.json'), 'utf8').catch(error => error.code)).toBe('ENOENT');
    } finally { await agent.disposeForRestart(); clearSessionExecutionPolicy('test-session'); }
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
    expect((calls[0]!.params.dynamicTools as Array<{ name: string }>).some(tool => tool.name === 'tokenbird__beecount__List_Ledgers')).toBe(true);
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
    expect((calls[1]!.params.dynamicTools as Array<{ name: string }>).some(tool => tool.name === 'tokenbird__beecount__List_Ledgers')).toBe(true);
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
    expect(params?.config).toEqual({ model_auto_compact_token_limit: 80_000, compact_prompt: COMPACT_AGENT.prompt });
    agent.destroy();
  });

  it('preserves the full TokenBird thinking-level range in Codex effort values', () => {
    const agent = createAgent();
    expect(agent['reasoningEffort']('off')).toBe('minimal');
    expect(agent['reasoningEffort']('low')).toBe('low');
    expect(agent['reasoningEffort']('medium')).toBe('medium');
    expect(agent['reasoningEffort']('high')).toBe('high');
    expect(agent['reasoningEffort']('xhigh')).toBe('xhigh');
    expect(agent['reasoningEffort']('max')).toBe('ultra');
    agent.destroy();
  });

  it('routes compact commands to native compaction and waits for completion or failure', async () => {
    for (const status of ['completed', 'failed'] as const) {
      const agent = createAgent();
      const calls: Array<{ method: string; params: unknown }> = [];
      const client = { request: async (method: string, params: unknown) => {
        calls.push({ method, params });
        agent['handleNotification']('turn/started', { threadId: 'compact-thread', turn: { id: 'compact-turn' } });
        if (status === 'completed') agent['handleNotification']('thread/compacted', { threadId: 'compact-thread', turnId: 'compact-turn' });
        agent['handleNotification']('turn/completed', { threadId: 'compact-thread', turn: {
          id: 'compact-turn', status, items: [], error: status === 'failed' ? { message: 'Summary generation failed' } : null,
        } });
        return {};
      } };
      agent['ensureClient'] = async () => client as never;
      agent['ensureThread'] = async () => { agent['codexThreadId'] = 'compact-thread'; return 'compact-thread'; };
      agent['authenticated'] = true;
      try {
        const events = [];
        for await (const event of agent['chatImpl']('/compact [super-agent-high-compression]')) events.push(event);
        expect(calls).toEqual([{ method: 'thread/compact/start', params: { threadId: 'compact-thread' } }]);
        expect(events.at(-1)?.type).toBe('complete');
        expect(events.some(event => event.type === 'typed_error' || event.type === 'error')).toBe(status === 'failed');
        expect(agent.isProcessing()).toBe(false);
      } finally { agent.destroy(); }
    }
  });

  it('maps streamed text, usage, and completion into TokenBird events', async () => {
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

  it('keeps Codex commentary intermediate while preserving explicit and legacy final answers', async () => {
    const agent = createAgent();
    try {
      agent['queue'].reset();
      agent['processing'] = true;
      agent['codexThreadId'] = 'thread-1';
      agent['currentTurnId'] = 'turn-1';
      for (const phase of ['commentary', 'final_answer', null, undefined] as const) {
        agent['handleNotification']('item/completed', {
          threadId: 'thread-1', turnId: 'turn-1',
          item: { type: 'agentMessage', id: String(phase), text: 'Message', phase },
        });
      }
      agent['handleNotification']('turn/completed', {
        threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, items: [] },
      });
      const events = [];
      for await (const event of agent['queue'].drain()) events.push(event);
      expect(events[0]).toMatchObject({ type: 'text_complete', isIntermediate: true });
      for (const event of events.slice(1, 4)) {
        expect(event.type).toBe('text_complete');
        expect('isIntermediate' in event && event.isIntermediate).not.toBe(true);
      }
      expect(events.at(-1)?.type).toBe('complete');
    } finally { agent.destroy(); }
  });

  it('surfaces unexpected interruption and failed turns without error details before completing', async () => {
    for (const status of ['interrupted', 'failed'] as const) {
      const agent = createAgent();
      try {
        agent['queue'].reset();
        agent['processing'] = true;
        agent['currentTurnId'] = 'turn-1';
        agent['handleNotification']('turn/completed', {
          turn: { id: 'turn-1', status, error: null, items: [] },
        });
        const events = [];
        for await (const event of agent['queue'].drain()) events.push(event);
        expect(events.map(event => event.type)).toEqual(['typed_error', 'complete']);
        expect(events[0]).toMatchObject({ error: { canRetry: true,
          ...(status === 'interrupted' ? { message: expect.stringContaining('Codex') }
            : { originalError: expect.stringContaining('Codex') }) } });
      } finally { agent.destroy(); }
    }
  });

  it('does not report intentional stop or handoff notifications as failures', async () => {
    for (const reason of [AbortReason.UserStop, AbortReason.PlanSubmitted, AbortReason.AuthRequest]) {
      const agent = createAgent();
      try {
        agent['queue'].reset();
        agent['processing'] = true;
        agent['currentTurnId'] = 'turn-1';
        agent.forceAbort(reason);
        agent['handleNotification']('turn/completed', {
          turn: { id: 'turn-1', status: 'interrupted', error: null, items: [] },
        });
        const events = [];
        for await (const event of agent['queue'].drain()) events.push(event);
        expect(events).toEqual([]);
      } finally { agent.destroy(); }
    }
  });

  it('uses final utility answers and rejects interrupted utility queries', async () => {
    for (const status of ['completed', 'interrupted'] as const) {
      const agent = createAgent();
      agent['buildCodexEnvironment'] = async () => undefined;
      agent['authenticateClient'] = async () => true;
      const connect = spyOn(NativeCodexAppServerClient.prototype, 'connect').mockResolvedValue({
        userAgent: 'test', codexHome: '', platformFamily: 'windows', platformOs: 'windows',
      });
      const request = spyOn(NativeCodexAppServerClient.prototype, 'request').mockImplementation(
        async function<T>(this: NativeCodexAppServerClient, method: string): Promise<T> {
          if (method === 'thread/start') return { thread: { id: 'utility' } } as T;
          for (const phase of ['commentary', 'final_answer'] as const) {
            this.emit('notification', 'item/completed', { threadId: 'utility',
              item: { type: 'agentMessage', id: phase, text: phase, phase } });
          }
          this.emit('notification', 'turn/completed', { threadId: 'utility',
            turn: { id: 'utility-turn', status, error: null, items: [] } });
          return {} as T;
        },
      );
      try {
        const result = agent.queryLlm({ prompt: 'Return a result' });
        if (status === 'completed') expect((await result).text).toBe('final_answer');
        else await expect(result).rejects.toThrow('Codex utility turn interrupted');
      } finally { request.mockRestore(); connect.mockRestore(); agent.destroy(); }
    }
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
