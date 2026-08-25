import { describe, expect, it } from 'bun:test';
import { WorkspaceEventBus } from '../event-bus.ts';
import { HostedScriptHandler } from './hosted-script-handler.ts';

describe('HostedScriptHandler', () => {
  it('emits only when the hosted script returns truthy and preserves metadata', async () => {
    const bus = new WorkspaceEventBus('ws');
    const seen: Record<string, unknown>[] = [];
    bus.on('HostedScriptTick', (payload) => { seen.push(payload.scriptInfo ?? {}); });
    const provider = {
      getConfig: () => ({ automations: {} }),
      getMatchersForEvent: () => [{ id: 's', script: 'return { ok: true, source: metadata.source }', intervalMs: 1000, scriptMetadata: { source: 'test' }, actions: [{ type: 'prompt', prompt: 'x' }] }],
    } as any;
    const handler = new HostedScriptHandler('ws', provider);
    handler.subscribe(bus);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual([{ ok: true, source: 'test' }]);
    handler.dispose();
    bus.dispose();
  });

  it('does not emit for false', async () => {
    const bus = new WorkspaceEventBus('ws');
    let count = 0;
    bus.on('HostedScriptTick', () => { count++; });
    const provider = { getConfig: () => ({ automations: {} }), getMatchersForEvent: () => [{ id: 's', script: 'return false', intervalMs: 1000, actions: [{ type: 'prompt', prompt: 'x' }] }] } as any;
    const handler = new HostedScriptHandler('ws', provider);
    handler.subscribe(bus);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(count).toBe(0);
    handler.dispose();
    bus.dispose();
  });

  it('only exposes explicitly granted environment variables', async () => {
    const bus = new WorkspaceEventBus('ws');
    const seen: Record<string, unknown>[] = [];
    bus.on('HostedScriptTick', (payload) => { seen.push(payload.scriptInfo ?? {}); });
    const provider = {
      getConfig: () => ({ automations: {} }),
      getMatchersForEvent: () => [{
        id: 's',
        script: 'return { denied: api.env("PATH") === undefined, granted: api.env("PATH") !== undefined }',
        intervalMs: 1000,
        scriptPermissions: { env: ['PATH'] },
        actions: [{ type: 'prompt', prompt: 'x' }],
      }],
    } as any;
    const handler = new HostedScriptHandler('ws', provider);
    handler.subscribe(bus);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual([{ denied: false, granted: true }]);
    handler.dispose();
    bus.dispose();
  });
});
