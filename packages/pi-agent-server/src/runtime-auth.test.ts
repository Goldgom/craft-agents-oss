import { describe, expect, it } from 'bun:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { buildCustomEndpointModelDef } from './custom-endpoint-models.ts';
import { installRequestAuthGuard, updateCustomEndpointCredential } from './runtime-auth.ts';

async function fixture() {
  const store = new InMemoryCredentialStore();
  await updateCustomEndpointCredential(store, 'old-token');
  const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null, modelsStore: new InMemoryModelsStore() });
  runtime.registerProvider('custom-endpoint', {
    baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', authHeader: true,
    models: [buildCustomEndpointModelDef('auth-test', undefined, undefined, 'openai-completions')],
  });
  const model = runtime.getModel('custom-endpoint', 'auth-test')!;
  return { store, runtime, model };
}

describe('TokenNest request credentials', () => {
  it('uses refreshed credentials with an already-created custom endpoint model', async () => {
    const { store, runtime, model } = await fixture();
    expect((await runtime.getAuth(model))?.auth.apiKey).toBe('old-token');
    await updateCustomEndpointCredential(store, 'refreshed-token');
    expect((await runtime.getAuth(model))?.auth.apiKey).toBe('refreshed-token');
    expect((await runtime.getAuth(model))?.auth.headers?.Authorization).toBe('Bearer refreshed-token');
  });

  it('checks and refreshes before each continuation and compaction auth resolution', async () => {
    const { store, runtime, model } = await fixture();
    let checks = 0;
    installRequestAuthGuard(runtime, async () => {
      checks++;
      if (checks === 2) await updateCustomEndpointCredential(store, 'refreshed-token');
    });
    expect((await runtime.getAuth(model))?.auth.apiKey).toBe('old-token');
    expect((await runtime.getAuth(model))?.auth.apiKey).toBe('refreshed-token');
    expect((await runtime.getAuth('custom-endpoint'))?.auth.apiKey).toBe('refreshed-token');
    expect(checks).toBe(3);
  });

  it('coalesces concurrent checks while preventing either request from using the stale token', async () => {
    const { store, runtime, model } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let checks = 0;
    installRequestAuthGuard(runtime, async () => {
      checks++;
      await gate;
      await updateCustomEndpointCredential(store, 'refreshed-token');
    });
    const first = runtime.getAuth(model);
    const second = runtime.getAuth(model);
    expect(checks).toBe(1);
    release();
    expect((await first)?.auth.apiKey).toBe('refreshed-token');
    expect((await second)?.auth.apiKey).toBe('refreshed-token');
  });

  it('blocks stale credentials when refresh fails and permits a later recovery', async () => {
    const { runtime, model } = await fixture();
    let fail = true;
    installRequestAuthGuard(runtime, async () => { if (fail) throw new Error('Your login has expired.'); });
    await expect(runtime.getAuth(model)).rejects.toThrow('Your login has expired');
    fail = false;
    expect((await runtime.getAuth(model))?.auth.apiKey).toBe('old-token');
  });

  it('cancels one waiter without cancelling a sibling credential check', async () => {
    const { runtime, model } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    installRequestAuthGuard(runtime, () => gate);
    const controller = new AbortController();
    const reason = new Error('user stopped');
    const cancelled = runtime.getAuth(model, { signal: controller.signal });
    const sibling = runtime.getAuth(model);
    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    release();
    expect((await sibling)?.auth.apiKey).toBe('old-token');
  });
});
