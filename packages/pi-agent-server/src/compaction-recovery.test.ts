import { describe, expect, it } from 'bun:test';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type ModelRuntime, type ExtensionAPI, type SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent';
import { createCompactionPolicy } from './compaction-policy.ts';

const model = getModel('openai', 'gpt-4o');
function answer(text: string, stopReason: AssistantMessage['stopReason'] = 'stop') {
  const stream = createAssistantMessageEventStream();
  stream.end({ role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider,
    model: model.id, stopReason, timestamp: 0, ...(stopReason === 'error' ? {errorMessage: text} : {}),
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  return stream;
}
async function activate(policy: ReturnType<typeof createCompactionPolicy>) {
  const handlers = new Map<string, (event: unknown) => unknown>();
  await policy.extension({ on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  const signal = new AbortController().signal;
  await handlers.get('session_before_compact')!({ signal, preparation: { tokensBefore: 10_000,
    firstKeptEntryId: 'tail', messagesToSummarize: [], turnPrefixMessages: [] }, branchEntries: [],
  } as unknown as SessionBeforeCompactEvent);
  return signal;
}

describe('compaction recovery', () => {
  it('falls back after an unavailable selected model and removes conversation auth overrides', async () => {
    const preferred = { ...model, id: 'selected' };
    const luna = { ...model, id: 'luna' };
    const haiku = { ...model, id: 'haiku' };
    const policy = createCompactionPolicy({ getModels: () => [preferred, luna, haiku] });
    const signal = await activate(policy);
    const calls: string[] = [];
    const raw: StreamFn = (target, _context, options) => {
      calls.push(target.id);
      expect(options?.apiKey).toBeUndefined();
      expect(options?.headers).toBeUndefined();
      return target === preferred ? answer('model_not_found', 'error') : answer('Complete checkpoint.');
    };
    const response = await (await policy.wrapStream(raw)(model, { messages: [{ role: 'user', timestamp: 0, content: 'Original task' }] },
      { signal, apiKey: 'conversation-override', headers: { 'X-Conversation': 'private' } })).result();
    expect(calls).toEqual(['selected', 'luna']);
    expect(response.stopReason).toBe('stop');
    expect(response.usage.totalTokens).toBe(60);
  });

  it('splits a multilingual history for a smaller model and merges complete segment checkpoints', async () => {
    const small = { ...model, id: 'luna-small', contextWindow: 16_384, maxTokens: 2_048 };
    const policy = createCompactionPolicy({ getModels: () => [small] });
    const signal = await activate(policy);
    const source = '开头必须保留🙂\n' + '历史事实与约束。'.repeat(8_000) + '\n末尾待办 FINAL-123';
    const original: Context = { messages: [{ role: 'user', timestamp: 0, content: source }] };
    const before = structuredClone(original);
    const calls: Context[] = [];
    const raw: StreamFn = (_model, ctx) => { calls.push(ctx); return answer('Pending FINAL-123; preserve constraints.'); };
    const result = await (await policy.wrapStream(raw)(model, original, {signal})).result();
    expect(result.stopReason).toBe('stop');
    expect(calls.length).toBeGreaterThan(2);
    const segments = calls.flatMap(call => call.messages).map(message => String(message.content)).filter(text => text.includes('<segment>'));
    const reconstructed = segments.map(text => text.split('<segment>\n')[1]!.split('\n</segment>')[0]!).join('');
    expect(reconstructed).toBe(source);
    expect(String(calls.at(-1)!.messages[0]!.content)).toContain('Merge these chronological segment summaries');
    for (const call of calls) {
      const bytes = Buffer.byteLength((call.systemPrompt ?? '') + call.messages.map(message => String(message.content)).join(''), 'utf8');
      expect(bytes).toBeLessThan(small.contextWindow - small.maxTokens);
    }
    expect(original).toEqual(before);
  });

  it('does not try another model after cancellation', async () => {
    const policy = createCompactionPolicy({ getModels: () => [model, { ...model, id: 'fallback' }] });
    const signal = await activate(policy);
    let calls = 0;
    const raw: StreamFn = () => { calls++; return answer('Cancelled', 'aborted'); };
    const result = await (await policy.wrapStream(raw)(model, {messages: []}, {signal})).result();
    expect(result.stopReason).toBe('aborted');
    expect(calls).toBe(1);
  });

  for (const reason of ['manual', 'threshold', 'overflow'] as const) {
    for (const recover of [true, false]) {
      it(`${reason}: ${recover ? 'recovers truncation' : 'rejects repeated truncation'} through the real SDK without losing history`, async () => {
        const settings = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 1_000 } });
        const history = SessionManager.inMemory(import.meta.dir);
        for (let i = 0; i < 30; i++) history.appendMessage({role: 'user', timestamp: i, content: `Request ${i}: ${'detail '.repeat(150)}`});
        const originals = structuredClone(history.getEntries());
        const policy = createCompactionPolicy();
        const loader = new DefaultResourceLoader({ cwd: import.meta.dir, agentDir: import.meta.dir, settingsManager: settings,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [policy.extension] });
        await loader.reload();
        const runtime = { hasConfiguredAuth: () => true, getModel: () => model, getAvailableSnapshot: () => [model],
          getAuth: async () => ({ auth: { apiKey: 'offline' } }), streamSimple: () => { throw new Error('No network allowed'); },
        } as unknown as ModelRuntime;
        const {session} = await createAgentSession({ cwd: import.meta.dir, model, modelRuntime: runtime, resourceLoader: loader,
          settingsManager: settings, sessionManager: history, tools: [] });
        let calls = 0;
        const raw: StreamFn = () => { calls++; return recover && calls > 1 ? answer('Complete task checkpoint.') : answer('Partial', 'length'); };
        session.agent.streamFunction = policy.wrapStream(raw);
        let failure: string | undefined;
        const unsubscribe = session.subscribe(event => { if (event.type === 'compaction_end') failure = event.errorMessage; });
        try {
          if (reason === 'manual') {
            try { await session.compact(); } catch (error) { failure = String(error); }
          } else {
            await (session as unknown as { _runAutoCompaction(reason: string, retry: boolean): Promise<boolean> })._runAutoCompaction(reason, reason === 'overflow');
          }
          expect(calls).toBe(recover ? 2 : 3);
          expect(history.getEntries().slice(0, originals.length)).toEqual(originals);
          expect(history.getEntries().some(entry => entry.type === 'compaction')).toBe(recover);
          if (recover) expect(failure).toBeUndefined();
          else expect(failure).toContain('token cap after 3');
        } finally { unsubscribe(); session.dispose(); }
      });
    }
  }
});
