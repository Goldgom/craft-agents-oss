import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'tokenbird-framework-rpc-'));
const previous = process.env.TOKENBIRD_CONFIG_DIR;
process.env.TOKENBIRD_CONFIG_DIR = root;
const { WsRpcServer } = await import('../../packages/server-core/src/transport/server');
const { WsRpcClient } = await import('../../packages/server-core/src/transport/client');
const { registerAgentPluginHandlers } = await import('../../packages/server-core/src/handlers/rpc/agent-plugins');
const { RPC_CHANNELS } = await import('../../packages/shared/src/protocol');
const { getBackendFrameworkCatalog } = await import('../../packages/shared/src/agent-plugins/framework-storage');
const server = new WsRpcServer({ host: '127.0.0.1', port: 0, requireAuth: true, validateToken: async value => value === 'local-framework-test' });
let client: InstanceType<typeof WsRpcClient>;
const refreshed: string[] = [];
beforeAll(async () => {
  const connection = { slug: 'pi-default', name: 'Pi default', providerType: 'pi_compat', authType: 'none', customEndpoint: { api: 'openai-completions' } };
  writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [], llmConnections: [connection] }));
  const appRootPath = resolve(import.meta.dir, '../../apps/electron');
  registerAgentPluginHandlers(server, { sessionManager: { refreshConnectionRuntime: async (slug: string) => { refreshed.push(slug); } },
    platform: { appRootPath, resourcesPath: appRootPath, isPackaged: false } } as any);
  await server.listen();
  client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, { token: 'local-framework-test', autoReconnect: false });
  await client.connect();
});
afterAll(async () => {
  client?.destroy(); await server.close();
  if (previous === undefined) delete process.env.TOKENBIRD_CONFIG_DIR; else process.env.TOKENBIRD_CONFIG_DIR = previous;
});

test('framework configuration, detection, test and runtime refresh use the real RPC route', async () => {
  const catalog = await client.invoke(RPC_CHANNELS.agentPlugins.LIST_FRAMEWORKS) as any;
  expect(catalog.frameworks).toHaveLength(5);
  const pi = catalog.frameworks.find((item: any) => item.id === 'pi');
  expect(pi.detectedLocation.executablePath).toBeTruthy();
  const draft = { ...pi.configuration, features: { ...pi.configuration.features, browser: 'disabled' } };
  const probe = await client.invoke(RPC_CHANNELS.agentPlugins.TEST_FRAMEWORK, draft) as any;
  expect(probe).toMatchObject({ success: true });
  expect(getBackendFrameworkCatalog().frameworks.find(item => item.id === 'pi')!.configuration.features.browser).toBe('host');
  await client.invoke(RPC_CHANNELS.agentPlugins.SAVE_FRAMEWORK, draft);
  expect(refreshed).toEqual(['pi-default']);
  const saved = await client.invoke(RPC_CHANNELS.agentPlugins.LIST_FRAMEWORKS) as any;
  expect(saved.frameworks.find((item: any) => item.id === 'pi').configuration.features.browser).toBe('disabled');
}, 30_000);

test('disabling a framework bound to a connection succeeds and preserves its disabled status', async () => {
  const manifest = { schemaVersion: 1, id: 'plugin:rpc-fixture', name: 'RPC fixture', description: '', version: '1', enabled: true,
    capabilities: ['hostTools', 'toolApproval'], compatibility: { providerTypes: ['pi_compat'], authTypes: ['none'] },
    transport: { type: 'stdio', command: process.execPath, args: [] } };
  writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [], llmConnections: [{ slug: 'plugin-connection',
    name: 'Plugin connection', providerType: 'pi_compat', authType: 'none', agentRuntime: manifest.id }] }));
  await client.invoke(RPC_CHANNELS.agentPlugins.SAVE, manifest);
  await client.invoke(RPC_CHANNELS.agentPlugins.SET_ENABLED, manifest.id, false);
  const catalog = await client.invoke(RPC_CHANNELS.agentPlugins.LIST_FRAMEWORKS) as any;
  expect(catalog.frameworks.find((item: any) => item.id === manifest.id).enabled).toBe(false);
  expect(refreshed.at(-1)).toBe('plugin-connection');
});

test('installation progress and cancellation traverse the authenticated RPC without replacing configuration', async () => {
  const before = getBackendFrameworkCatalog().frameworks.find(item => item.id === 'codex')!.configuration;
  const phases: string[] = [];
  let cancellation: Promise<unknown> | undefined;
  const unsubscribe = client.on(RPC_CHANNELS.agentPlugins.INSTALL_PROGRESS, (progress: any) => {
    if (progress.id !== 'codex') return;
    phases.push(progress.phase);
    if (progress.phase === 'preparing') cancellation = client.invoke(RPC_CHANNELS.agentPlugins.CANCEL_INSTALL, 'codex');
  });
  try {
    const result = await client.invoke(RPC_CHANNELS.agentPlugins.INSTALL_FRAMEWORK, 'codex');
    await cancellation;
    expect(result).toMatchObject({ success: false, error: 'Backend installation cancelled' });
    expect(phases).toContain('preparing');
    expect(phases).toContain('cancelled');
    expect(getBackendFrameworkCatalog().frameworks.find(item => item.id === 'codex')!.configuration).toEqual(before);
  } finally { unsubscribe(); }
}, 30_000);
