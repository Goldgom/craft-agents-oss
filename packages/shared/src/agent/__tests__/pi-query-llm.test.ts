/**
 * Tests for PiAgent.queryLlm — the subprocess RPC that powers `call_llm`.
 *
 * These tests are the drift guard for issue #596. The main-process side used to
 * route queryLlm through the mini_completion envelope which only carried `prompt`,
 * silently dropping model/systemPrompt/outputSchema/etc. The round-trip invariant
 * test below ensures the full request shape propagates end-to-end and fails loudly
 * if someone adds a new LLMQueryRequest field and forgets to plumb it through.
 */
import { afterEach, describe, expect, it, jest } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import { LLM_QUERY_TIMEOUT_MS, type LLMQueryRequest, type LLMQueryResult } from '../llm-tool.ts';

function createConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/craft-agent-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/craft-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    ...overrides,
  };
}

/**
 * Install a minimal subprocess stub so ensureSubprocess() resolves immediately
 * and send() captures outbound messages without hitting real stdin.
 */
function installFakeSubprocess(agent: PiAgent): { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  (agent as any).ensureSubprocess = async () => {};
  (agent as any).send = (cmd: Record<string, unknown>) => {
    sent.push(cmd);
  };
  return { sent };
}

/**
 * queryLlm awaits ensureSubprocess() before it calls send(), so a microtask
 * has to drain before the outbound envelope is captured.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  jest.useRealTimers();
});

describe('PiAgent.queryLlm — subprocess RPC round-trip', () => {
  it('propagates the full LLMQueryRequest shape over the llm_query RPC unchanged', async () => {
    const agent = new PiAgent(createConfig());
    const { sent } = installFakeSubprocess(agent);

    const request: LLMQueryRequest = {
      prompt: 'Summarize this transcript',
      systemPrompt: 'You are a concise summarizer.',
      model: 'pi/gpt-5-mini',
      maxTokens: 512,
      temperature: 0.3,
      outputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    };

    // Start the query and complete it by injecting a result for the captured id.
    const pending = agent.queryLlm(request);
    await flushMicrotasks();

    expect(sent).toHaveLength(1);
    const outbound = sent[0]!;
    expect(outbound.type).toBe('llm_query');
    expect(typeof outbound.id).toBe('string');

    // DRIFT GUARD: the outbound envelope must carry the entire request shape
    // byte-for-byte. If someone adds a field to LLMQueryRequest but doesn't
    // propagate it, this fails — prompting them to revisit queryLlm.
    expect(JSON.stringify(outbound.request)).toBe(JSON.stringify(request));

    // Resolve the pending query so the test doesn't hang.
    (agent as any).handleLine(JSON.stringify({
      type: 'llm_query_result',
      id: outbound.id,
      result: { text: 'ok', model: 'pi/gpt-5-mini' },
    }));

    const result = await pending;
    expect(result).toEqual({ text: 'ok', model: 'pi/gpt-5-mini' });

    agent.destroy();
  });

  it('resolves queryLlm with the exact returned text and model', async () => {
    jest.useFakeTimers();
    const agent = new PiAgent(createConfig());
    const { sent } = installFakeSubprocess(agent);

    const pending = agent.queryLlm({ prompt: 'hi' });
    await flushMicrotasks();
    const id = sent[0]!.id as string;

    const expected: LLMQueryResult = {
      text: 'hello world',
      model: 'pi/gpt-5-mini',
      inputTokens: 7,
      outputTokens: 3,
    };

    (agent as any).handleLine(JSON.stringify({
      type: 'llm_query_result',
      id,
      result: expected,
    }));

    const result = await pending;
    expect(result).toEqual(expected);
    expect((agent as any).pendingLlmQueries.size).toBe(0);

    // Successful settlement clears the deadline instead of sending a late cancel.
    jest.advanceTimersByTime(LLM_QUERY_TIMEOUT_MS);
    expect(sent.filter(message => message.type === 'cancel_ephemeral_query')).toHaveLength(0);

    agent.destroy();
  });

  it('rejects queryLlm and fires refreshAndPushTokens on auth errors for OAuth connections', async () => {
    const agent = new PiAgent(createConfig({ authType: 'oauth' }));
    const { sent } = installFakeSubprocess(agent);

    // Stub refreshAndPushTokens so we can observe the auth-refresh attempt.
    let refreshAttempts = 0;
    (agent as any).refreshAndPushTokens = async () => {
      refreshAttempts++;
    };

    const pending = agent.queryLlm({ prompt: 'hi' });
    await flushMicrotasks();
    expect(sent).toHaveLength(1);

    // Simulate the subprocess dual-emit: generic `error` first (triggers
    // centralized auth refresh), then the targeted `llm_query_result` that
    // rejects the specific promise.
    (agent as any).handleLine(JSON.stringify({
      type: 'error',
      code: 'llm_query_error',
      message: 'HTTP 401: Unauthorized',
    }));

    // The generic error loop already rejected the pending query, so the targeted
    // result handler is a no-op. That's fine — the dual-emit is defense-in-depth.
    let rejection: Error | null = null;
    try {
      await pending;
    } catch (err) {
      rejection = err as Error;
    }

    expect(rejection).not.toBeNull();
    expect(rejection!.message).toContain('401');

    // Yield once so the async refresh closure schedules.
    await new Promise((r) => setTimeout(r, 0));
    expect(refreshAttempts).toBe(1);
    expect((agent as any).pendingLlmQueries.size).toBe(0);

    agent.destroy();
  });

  it('rejects queryLlm on timeout and cancels only its subprocess query', async () => {
    jest.useFakeTimers();
    const agent = new PiAgent(createConfig());
    const { sent } = installFakeSubprocess(agent);

    const pending = agent.queryLlm({ prompt: 'hi' });
    const settled = pending.catch(error => error as Error);
    await flushMicrotasks();
    const id = sent[0]!.id as string;

    jest.advanceTimersByTime(LLM_QUERY_TIMEOUT_MS);
    const rejection = await settled;

    expect(rejection).toBeInstanceOf(Error);
    if (!(rejection instanceof Error)) {
      throw new Error('Expected queryLlm to reject');
    }
    expect(rejection.message).toMatch(/timed out/i);
    expect((agent as any).pendingLlmQueries.size).toBe(0);
    expect(sent).toContainEqual({ type: 'cancel_ephemeral_query', id });

    agent.destroy();
  });

  it('returns null and cancels the matching mini completion on timeout', async () => {
    jest.useFakeTimers();
    const agent = new PiAgent(createConfig());
    const { sent } = installFakeSubprocess(agent);

    const pending = agent.runMiniCompletion('make a title');
    await flushMicrotasks();
    const id = sent[0]!.id as string;

    jest.advanceTimersByTime(LLM_QUERY_TIMEOUT_MS);

    await expect(pending).resolves.toBeNull();
    expect((agent as any).pendingMiniCompletions.size).toBe(0);
    expect(sent).toContainEqual({ type: 'cancel_ephemeral_query', id });

    agent.destroy();
  });

  it('keeps a newer concurrent query alive when an older query times out and replies late', async () => {
    jest.useFakeTimers();
    const agent = new PiAgent(createConfig());
    const { sent } = installFakeSubprocess(agent);

    const first = agent.queryLlm({ prompt: 'first' });
    const firstSettled = first.catch(error => error as Error);
    await flushMicrotasks();
    const firstId = sent[0]!.id as string;

    jest.advanceTimersByTime(10_000);
    const second = agent.queryLlm({ prompt: 'second' });
    await flushMicrotasks();
    const secondId = sent.find(message => message.type === 'llm_query' && message.id !== firstId)!.id as string;

    // Only the first deadline has elapsed; the second still has ten seconds.
    jest.advanceTimersByTime(LLM_QUERY_TIMEOUT_MS - 10_000);
    expect(await firstSettled).toBeInstanceOf(Error);
    expect((agent as any).pendingLlmQueries.has(firstId)).toBe(false);
    expect((agent as any).pendingLlmQueries.has(secondId)).toBe(true);

    // A late response for the cancelled request is ignored and cannot settle q2.
    (agent as any).handleLine(JSON.stringify({
      type: 'llm_query_result',
      id: firstId,
      result: { text: 'late', model: 'pi/gpt-5-mini' },
    }));
    expect((agent as any).pendingLlmQueries.has(secondId)).toBe(true);

    (agent as any).handleLine(JSON.stringify({
      type: 'llm_query_result',
      id: secondId,
      result: { text: 'second result', model: 'pi/gpt-5-mini' },
    }));
    await expect(second).resolves.toEqual({ text: 'second result', model: 'pi/gpt-5-mini' });
    expect(sent.filter(message => message.type === 'cancel_ephemeral_query'))
      .toEqual([{ type: 'cancel_ephemeral_query', id: firstId }]);

    agent.destroy();
  });

  it('scopes subprocess utility errors to their matching concurrent request', async () => {
    jest.useFakeTimers();
    const agent = new PiAgent(createConfig());
    const { sent } = installFakeSubprocess(agent);

    const first = agent.queryLlm({ prompt: 'first' });
    const firstSettled = first.catch(error => error as Error);
    const second = agent.queryLlm({ prompt: 'second' });
    await flushMicrotasks();
    const queryMessages = sent.filter(message => message.type === 'llm_query');
    const firstId = queryMessages[0]!.id as string;
    const secondId = queryMessages[1]!.id as string;

    (agent as any).handleLine(JSON.stringify({
      type: 'error',
      code: 'llm_query_error',
      id: firstId,
      message: 'first failed',
    }));

    const firstError = await firstSettled;
    expect(firstError).toBeInstanceOf(Error);
    if (!(firstError instanceof Error)) {
      throw new Error('Expected first query to reject');
    }
    expect(firstError.message).toBe('first failed');
    expect((agent as any).pendingLlmQueries.has(secondId)).toBe(true);

    (agent as any).handleLine(JSON.stringify({
      type: 'llm_query_result',
      id: secondId,
      result: { text: 'ok', model: 'pi/gpt-5-mini' },
    }));
    await expect(second).resolves.toEqual({ text: 'ok', model: 'pi/gpt-5-mini' });

    agent.destroy();
  });

  it('rejects all pending queryLlm calls when the subprocess exits', async () => {
    const agent = new PiAgent(createConfig());
    installFakeSubprocess(agent);

    const p1 = agent.queryLlm({ prompt: 'one' });
    const p2 = agent.queryLlm({ prompt: 'two' });
    await flushMicrotasks();

    expect((agent as any).pendingLlmQueries.size).toBe(2);

    // Simulate subprocess death (the exit handler clears pending queries).
    (agent as any).handleSubprocessExit(1, null);

    const [r1, r2] = await Promise.allSettled([p1, p2]);
    expect(r1.status).toBe('rejected');
    expect(r2.status).toBe('rejected');
    expect((r1 as PromiseRejectedResult).reason.message).toMatch(/subprocess exited/i);
    expect((r2 as PromiseRejectedResult).reason.message).toMatch(/subprocess exited/i);
    expect((agent as any).pendingLlmQueries.size).toBe(0);

    agent.destroy();
  });
});
