import { describe, expect, it } from 'bun:test';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, estimateTokens,
  type ModelRuntime, type ExtensionAPI, type SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent';
import { compactWithPolicy, createCompactionPolicy, summaryTokenBudget } from './compaction-policy.ts';

const model = getModel('openai', 'gpt-4o');
const context: Context = { systemPrompt: 'Summarize.', messages: [{ role: 'user', content: 'History', timestamp: 0 }] };
function response(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider,
    model: model.id, stopReason, timestamp: 0,
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } } };
}
function streamOf(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  stream.end(message);
  return stream;
}
async function setup(reason: SessionBeforeCompactEvent['reason'] = 'manual', config: Parameters<typeof createCompactionPolicy>[0] = {}) {
  const policy = createCompactionPolicy(config);
  const handlers = new Map<string, (...args: any[]) => any>();
  await policy.extension({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  const signal = new AbortController().signal;
  const history = { role: 'user' as const, content: 'Original history', timestamp: 0 };
  const prefix = { role: 'user' as const, content: 'Current task prefix', timestamp: 1 };
  const suffix = { role: 'user' as const, content: 'Recent original text', timestamp: 2 };
  const event = { type: 'session_before_compact', reason, signal, customInstructions: 'Preserve ticket TB-123',
    branchEntries: [
      { type: 'message', id: 'history', message: history },
      { type: 'message', id: 'prefix', message: prefix },
      { type: 'message', id: 'kept', message: suffix },
    ],
    preparation: { firstKeptEntryId: 'kept', tokensBefore: 10_000, messagesToSummarize: [history],
      turnPrefixMessages: [prefix], isSplitTurn: true, previousSummary: 'Prior checkpoint',
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      fileOps: { read: new Set(['src/file.ts']), edited: new Set(), written: new Set() } },
  } as unknown as SessionBeforeCompactEvent;
  const originalBranch = JSON.stringify(event.branchEntries);
  await handlers.get('session_before_compact')!(event);
  return { policy, event, signal, handlers, originalBranch };
}

describe('summary-only compaction policy', () => {
  it('archives before dropping file lists and adds the retrieval pointer independently of model output', async () => {
    let archived: unknown;
    const { policy, signal, event, originalBranch } = await setup('threshold', {
      archive: async event => {
        archived = [...event.preparation.fileOps.read];
        return 'Session memory: C:/session/memory/compactions/archive.md';
      },
    });
    expect(archived).toEqual(['src/file.ts']);
    expect([...event.preparation.fileOps.read]).toEqual([]);
    expect(JSON.stringify(event.branchEntries)).toBe(originalBranch);
    const result = await (await policy.wrapStream((_model, context) => {
      expect(context.systemPrompt).toContain('Omit unrelated/completed tasks');
      return streamOf(response('Continue TB-123.'));
    })(model, context, { signal })).result();
    expect(result.content).toEqual([{ type: 'text', text: 'Continue TB-123.\n\nSession memory: C:/session/memory/compactions/archive.md' }]);
  });

  it('retains file metadata and never claims archival when memory is unavailable or disabled', async () => {
    for (const archive of [undefined, async () => undefined, async () => { throw new Error('disk full'); }]) {
      const { policy, signal, event } = await setup('overflow', { archive });
      expect([...event.preparation.fileOps.read]).toEqual(['src/file.ts']);
      const result = await (await policy.wrapStream(() => streamOf(response('Continue TB-123.')))(model, context, { signal })).result();
      expect(result.content).toEqual([{ type: 'text', text: 'Continue TB-123.' }]);
    }
  });

  it('uses the policy through real SDK compact and keeps the entire original transcript', async () => {
    const policy = createCompactionPolicy();
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 1_000 } });
    const sessionManager = SessionManager.inMemory(import.meta.dir);
    for (let i = 0; i < 30; i++) {
      sessionManager.appendMessage({ role: 'user', content: `Original request ${i}: ${'detail '.repeat(150)}`, timestamp: i });
      const reply = response(`Original response ${i}: ${'evidence '.repeat(150)}`);
      reply.usage = { ...reply.usage, input: (i + 1) * 600 - 20, totalTokens: (i + 1) * 600 };
      sessionManager.appendMessage(reply);
    }
    const originalEntries = structuredClone(sessionManager.getEntries());
    const loader = new DefaultResourceLoader({ cwd: import.meta.dir, agentDir: import.meta.dir,
      settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      noContextFiles: true, extensionFactories: [policy.extension] });
    await loader.reload();
    const runtime = { hasConfiguredAuth: () => true, getModel: () => model, getAvailableSnapshot: () => [model],
      getAuth: async () => ({ auth: { apiKey: 'offline-test', headers: { 'X-Auth': 'preserved' } } }),
      streamSimple: () => { throw new Error('No network permitted in test'); },
    } as unknown as ModelRuntime;
    const { session } = await createAgentSession({ cwd: import.meta.dir, model, modelRuntime: runtime,
      resourceLoader: loader, settingsManager, sessionManager, tools: [] });
    const calls: Array<{ context: Context; options: any }> = [];
    session.agent.streamFunction = policy.wrapStream((_model, ctx, options) => {
      calls.push({ context: ctx, options });
      return streamOf(response('Goal: continue the latest request. Constraint: keep original references. Next: inspect src/file.ts.'));
    });
    try {
      const result = await compactWithPolicy(session, '[super-agent-high-compression] Preserve the pending task');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.context.systemPrompt).toContain('不要逐条累积旧摘要');
      expect(calls[0]!.options.apiKey).toBe('offline-test');
      expect(calls[0]!.options.headers).toEqual({ 'X-Auth': 'preserved' });
      expect(sessionManager.getEntries().slice(0, originalEntries.length)).toEqual(originalEntries);
      expect(settingsManager.getCompactionSettings().keepRecentTokens).toBe(1_000);
      const keptIndex = originalEntries.findIndex(entry => entry.id === result.firstKeptEntryId);
      expect(keptIndex).toBeGreaterThan(0);
      const expectedRecent = originalEntries.slice(keptIndex).filter(entry => entry.type === 'message').map(entry => entry.message);
      expect(session.agent.state.messages.slice(-expectedRecent.length)).toEqual(expectedRecent);
      const retainedTokens = expectedRecent.reduce((sum, message) => sum + estimateTokens(message), 0);
      const budget = summaryTokenBudget(result.tokensBefore, retainedTokens);
      expect(budget).toBeGreaterThan(768);
      expect(calls[0]!.context.systemPrompt).toContain(`Target approximately ${budget} tokens`);
      expect(result.estimatedTokensAfter).toBeLessThan(result.tokensBefore * 0.1);
    } finally {
      session.dispose();
    }
  });

  it('restores retention settings after a failed high-compression attempt and leaves ordinary compact unchanged', async () => {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 20000, reserveTokens: 12000 } });
    const original = settingsManager.getCompactionSettings();
    const session = { settingsManager, compact: async () => {
      expect(settingsManager.getCompactionSettings().keepRecentTokens).toBe(512);
      throw new Error('provider unavailable');
    } };
    await expect(compactWithPolicy(session, '[super-agent-high-compression]')).rejects.toThrow('provider unavailable');
    expect(settingsManager.getCompactionSettings()).toEqual(original);
    const ordinary = { settingsManager, compact: async () => {
      expect(settingsManager.getCompactionSettings()).toEqual(original);
      throw new Error('ordinary compact');
    } };
    await expect(compactWithPolicy(ordinary, 'Keep references')).rejects.toThrow('ordinary compact');
    expect(settingsManager.getCompactionSettings()).toEqual(original);
  });

  it('budgets 10% for summary plus recent history and metadata without a fixed ceiling', () => {
    expect(summaryTokenBudget(100_000, 512)).toBe(9_360);
    expect(summaryTokenBudget(100_000, 4_000)).toBe(5_872);
    expect(summaryTokenBudget(10_000, 20_000)).toBe(256);
    expect(summaryTokenBudget(1_000_000, 512)).toBe(99_360);
    expect(summaryTokenBudget(100_000, 512, 1_000)).toBe(8_488);
  });

  for (const reason of ['manual', 'threshold', 'overflow'] as const) {
    it(`preserves original history, recent boundary and settings during ${reason} compaction`, async () => {
      const { event, originalBranch, policy, signal } = await setup(reason);
      expect(JSON.stringify(event.branchEntries)).toBe(originalBranch);
      expect(event.preparation.firstKeptEntryId).toBe('kept');
      expect(event.preparation.settings.keepRecentTokens).toBe(20_000);
      expect(event.preparation.messagesToSummarize.map(message => (message as any).content))
        .toEqual(['Original history', 'Current task prefix']);
      expect(event.preparation.isSplitTurn).toBe(false);
      expect(event.preparation.turnPrefixMessages).toEqual([]);
      expect(event.preparation.previousSummary).toBe('Prior checkpoint');
      expect([...event.preparation.fileOps.read]).toEqual(['src/file.ts']);
      const metadataTokens = 128 + estimateTokens({ role: 'user', content: 'src/file.ts', timestamp: 0 });
      const kept = event.branchEntries[2]!;
      const retainedTokens = kept.type === 'message' ? estimateTokens(kept.message) : 0;
      const budget = summaryTokenBudget(10_000, retainedTokens, metadataTokens);
      await policy.wrapStream((_model, ctx) => {
        expect(ctx.systemPrompt).toContain(`Target approximately ${budget} tokens`);
        return streamOf(response('Complete checkpoint.'));
      })(model, context, { signal });
    });
  }

  it('semantically rewrites an oversized checkpoint once and records both calls', async () => {
    const { policy, signal } = await setup();
    const calls: Array<{ context: Context; options: any }> = [];
    const raw: StreamFn = (_model, ctx, options) => {
      calls.push({ context: ctx, options });
      return streamOf(response(calls.length === 1 ? 'Long checkpoint '.repeat(400) : 'Continue TB-123; preserve src/file.ts.'));
    };
    const result = await (await policy.wrapStream(raw)(model, context, { signal, apiKey: 'test-key', headers: { 'X-Test': 'auth' } })).result();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.context.systemPrompt).toContain('不要逐条累积旧摘要');
    expect(calls[1]!.context.systemPrompt).toContain('Preserve ticket TB-123');
    expect(calls[1]!.options.apiKey).toBe('test-key');
    expect(calls[1]!.options.headers).toEqual({ 'X-Test': 'auth' });
    expect(result.content).toEqual([{ type: 'text', text: 'Continue TB-123; preserve src/file.ts.' }]);
    expect(result.usage.totalTokens).toBe(60);
    expect(result.usage.cost.total).toBe(6);
  });

  it('keeps a complete checkpoint when the rewrite is truncated', async () => {
    const { policy, signal } = await setup();
    const original = 'Essential facts '.repeat(400);
    let calls = 0;
    const raw: StreamFn = () => streamOf(++calls === 1 ? response(original) : response('partial', 'length'));
    const result = await (await policy.wrapStream(raw)(model, context, { signal })).result();
    expect(result.content).toEqual([{ type: 'text', text: original }]);
    expect(result.stopReason).toBe('stop');
  });

  it('retries initial truncation from the complete source and accounts for both calls', async () => {
    const { policy, signal } = await setup();
    const calls: Context[] = [];
    const raw: StreamFn = (_model, ctx) => {
      calls.push(ctx);
      return streamOf(response(calls.length === 1 ? 'partial' : 'Complete checkpoint.', calls.length === 1 ? 'length' : 'stop'));
    };
    const result = await (await policy.wrapStream(raw)(model, context, { signal })).result();
    expect(result.stopReason).toBe('stop');
    expect(result.usage.totalTokens).toBe(60);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages).toEqual(context.messages);
    expect(calls[1]!.systemPrompt).toContain('Start again from the full input');
    expect(calls[1]!.systemPrompt?.match(/Target approximately (\d+) tokens/)?.[1])
      .toBe(calls[0]!.systemPrompt?.match(/Target approximately (\d+) tokens/)?.[1]);
  });

  it('bounds repeated truncation without accepting a partial checkpoint', async () => {
    const { policy, signal } = await setup();
    let calls = 0;
    const raw: StreamFn = () => { calls++; return streamOf(response('partial', 'length')); };
    await expect(async () => (await policy.wrapStream(raw)(model, context, {signal})).result()).toThrow('after 3');
    expect(calls).toBe(3);
  });

  it('preserves provider errors for SDK retries and never retries an abort', async () => {
    for (const stop of ['error', 'aborted'] as const) {
      const { policy, signal } = await setup();
      let calls = 0;
      const raw: StreamFn = () => { calls++; return streamOf(response('partial', stop)); };
      const result = await (await policy.wrapStream(raw)(model, context, { signal })).result();
      expect(result.stopReason).toBe(stop);
      expect(calls).toBe(1);
    }
  });

  it('leaves normal chat unchanged and clears policy on completion/failure', async () => {
    for (const endEvent of ['session_compact', 'session_compact_failed']) {
      const { policy, signal, handlers } = await setup();
      const calls: Array<{ context: Context; options: any }> = [];
      const raw: StreamFn = (_model, ctx, options) => {
        calls.push({ context: ctx, options }); return streamOf(response('ok'));
      };
      const wrapped = policy.wrapStream(raw);
      const unrelated = { signal: new AbortController().signal, maxTokens: 50_000 };
      await wrapped(model, context, unrelated);
      expect(calls[0]).toEqual({ context, options: unrelated });
      handlers.get(endEvent)!();
      const options = { signal, maxTokens: 50_000 };
      await wrapped(model, context, options);
      expect(calls[1]).toEqual({ context, options });
    }
  });

  it('propagates cancellation during the optional rewrite', async () => {
    const { policy, event, handlers } = await setup();
    const controller = new AbortController();
    event.signal = controller.signal;
    await handlers.get('session_before_compact')!(event);
    let calls = 0;
    const raw: StreamFn = () => {
      if (++calls === 2) controller.abort();
      return streamOf(response('Essential '.repeat(500)));
    };
    await expect(async () => (await policy.wrapStream(raw)(model, context, { signal: controller.signal })).result()).toThrow();
  });
});
