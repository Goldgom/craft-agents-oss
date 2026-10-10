import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentBackend } from '../agent/backend/types.ts';

const root = mkdtempSync(join(tmpdir(), 'tokenbird-framework-tests-'));
const previousConfig = process.env.TOKENBIRD_CONFIG_DIR;
process.env.TOKENBIRD_CONFIG_DIR = join(root, 'config');
const { saveAgentPluginManifest } = await import('./storage.ts');
const { getBackendFrameworkCatalog, saveBackendFrameworkConfiguration, getBackendFrameworkFingerprint,
  validateBackendFrameworkConfiguration, setDetectedFrameworkLocation } = await import('./framework-storage.ts');
const { defaultFrameworkConfiguration, frameworkFeatureOptions } = await import('./frameworks.ts');
const { testBackendFrameworkConfiguration } = await import('./framework-probe.ts');
const { configureFrameworkAgent } = await import('./framework-runtime.ts');
const { frameworkToolBlockReason, registerFrameworkToolPolicy } = await import('./framework-tool-policy.ts');
const { createBackend, resolveBackendContext } = await import('../agent/backend/factory.ts');
const { runPreToolUseChecksWithPermissions } = await import('../agent/core/pre-tool-use.ts');
const fixture = resolve(import.meta.dir, '__fixtures__/bridge.ts');
const workspace = { id: 'framework-test', name: 'Framework test', slug: 'framework-test', rootPath: join(root, 'workspace'), createdAt: 1 };
const manifest = { schemaVersion: 1 as const, id: 'plugin:framework-fixture' as const, name: 'Framework fixture', description: '', version: '1', enabled: true,
  capabilities: ['resume', 'utilityCompletion', 'hostTools', 'toolApproval'] as const,
  compatibility: { providerTypes: ['pi_compat' as const], authTypes: ['none' as const] },
  transport: { type: 'stdio' as const, command: process.execPath, args: [fixture], env: { FRAMEWORK_TEST_SECRET: 'never-return-in-ui' } } };
const agents: AgentBackend[] = [];
const configuration = () => getBackendFrameworkCatalog().frameworks.find(item => item.id === manifest.id)!.configuration;
beforeAll(() => { mkdirSync(process.env.TOKENBIRD_CONFIG_DIR!, { recursive: true }); mkdirSync(workspace.rootPath); });
beforeEach(() => {
  writeFileSync(join(process.env.TOKENBIRD_CONFIG_DIR!, 'agent-frameworks.json'), JSON.stringify({ version: 1, frameworks: [] }));
  saveAgentPluginManifest({ ...manifest, capabilities: [...manifest.capabilities] });
});
afterEach(async () => { await Promise.all(agents.splice(0).map(agent => agent.disposeForRestart?.() ?? Promise.resolve(agent.destroy()))); });
afterAll(() => { if (previousConfig === undefined) delete process.env.TOKENBIRD_CONFIG_DIR; else process.env.TOKENBIRD_CONFIG_DIR = previousConfig; });

test('catalog shows supported frameworks and editable locations without transport secrets', () => {
  const catalog = getBackendFrameworkCatalog();
  expect(catalog.frameworks.map(item => item.id)).toEqual(expect.arrayContaining(['pi', 'codex', 'claude-code', 'plugin:hermes', 'plugin:dsh']));
  expect(JSON.stringify(catalog)).not.toContain('never-return-in-ui');
  expect(configuration().executablePath).toBe(process.execPath);
  expect(frameworkFeatureOptions(catalog.frameworks.find(item => item.id === 'codex')!, 'files')).toEqual(['native']);
});

test('unsupported routes and ambiguous relative locations are rejected before storing changes', () => {
  const hermes = getBackendFrameworkCatalog().frameworks.find(item => item.id === 'plugin:hermes')!;
  const draft = { ...defaultFrameworkConfiguration(hermes), executablePath: process.execPath, projectPath: root };
  expect(() => saveBackendFrameworkConfiguration({ ...draft, features: { ...draft.features, utility: 'native' } })).toThrow('Unsupported implementation');
  expect(() => validateBackendFrameworkConfiguration({ ...draft, projectPath: './hermes' })).toThrow('absolute Hermes');
  expect(JSON.parse(readFileSync(join(process.env.TOKENBIRD_CONFIG_DIR!, 'agent-frameworks.json'), 'utf8')).frameworks).toEqual([]);
});

test('settings round trip through the existing adapter and contribute to live runtime signatures', async () => {
  const original = configuration();
  const first = getBackendFrameworkFingerprint(manifest.id);
  saveBackendFrameworkConfiguration({ ...original, features: { ...original.features, sources: 'disabled' } });
  expect(configuration().features.sources).toBe('disabled');
  expect(getBackendFrameworkFingerprint(manifest.id)).not.toBe(first);
  const connection = { slug: 'fixture', providerType: 'pi_compat', authType: 'none', agentRuntime: manifest.id, defaultModel: 'fixture' };
  writeFileSync(join(process.env.TOKENBIRD_CONFIG_DIR!, 'config.json'), JSON.stringify({ workspaces: [workspace], llmConnections: [connection] }));
  const resolved = resolveBackendContext({ sessionConnectionSlug: 'fixture' });
  expect(resolved.agentPluginFingerprint).toBe(getBackendFrameworkFingerprint(manifest.id));
  expect(readFileSync(join(process.env.TOKENBIRD_CONFIG_DIR!, 'agent-plugins.json'), 'utf8')).toContain('never-return-in-ui');
});

test('a disabled tool family is blocked in the real subprocess path, including unadvertised tool calls', async () => {
  const original = configuration();
  saveBackendFrameworkConfiguration({ ...original, features: { ...original.features, files: 'disabled' } });
  writeFileSync(join(workspace.rootPath, 'instructions.md'), 'must-not-be-read');
  const agent = createBackend({ provider: 'pi', providerType: 'pi_compat', authType: 'none', agentRuntime: manifest.id,
    workspace, model: 'fixture', isHeadless: true,
    session: { id: 'tool-disabled', workspaceRootPath: workspace.rootPath, createdAt: 1, lastUsedAt: 1 } });
  agents.push(agent);
  agent.setPermissionMode('allow-all');
  const events = []; for await (const event of agent.chat('read')) events.push(event);
  expect(JSON.stringify(events)).toContain('File and command tools are disabled');
  expect(JSON.stringify(events)).not.toContain('must-not-be-read');
  const automaticSession = createBackend({ provider: 'pi', providerType: 'pi_compat', authType: 'none', agentRuntime: manifest.id,
    workspace, model: 'fixture', isHeadless: true });
  agents.push(automaticSession);
  const automaticEvents = []; for await (const event of automaticSession.chat('read')) automaticEvents.push(event);
  expect(JSON.stringify(automaticEvents)).toContain('File and command tools are disabled');
});

test('tool policy leases isolate sessions and a replaced backend cannot clear the new policy', async () => {
  const features = { ...configuration().features, files: 'disabled' as const, sources: 'disabled' as const };
  const releaseOld = registerFrameworkToolPolicy('policy-test', {}, features);
  const releaseNew = registerFrameworkToolPolicy('policy-test', {}, features);
  releaseOld();
  expect(frameworkToolBlockReason('another-session', 'Write')).toBeUndefined();
  expect(frameworkToolBlockReason('policy-test', 'mcp__source__query')).toContain('Data source');
  const result = await runPreToolUseChecksWithPermissions({ sessionId: 'policy-test', toolName: 'Bash', input: { command: 'echo unsafe' } } as any);
  expect(result).toMatchObject({ type: 'block' });
  releaseNew();
  expect(frameworkToolBlockReason('policy-test', 'Bash')).toBeUndefined();
});

test('shared history recovery survives failed turns, then stops reinjecting after success', async () => {
  const received: string[] = [];
  let fail = true;
  const native = { chat: async function* (message: string) { received.push(message); if (fail) yield { type: 'error', message: 'fixture' }; yield { type: 'complete' }; },
    getSessionId: () => 'native-id', setSessionId: () => {}, destroy: () => {} } as unknown as AgentBackend;
  const draft = { ...configuration(), features: { ...configuration().features, history: 'host' as const } };
  configureFrameworkAgent(native, draft, { session: { id: 'history' } } as any, () => { throw new Error('unused'); },
    () => [{ type: 'user', content: 'Previous visible message' }]);
  expect(native.getSessionId()).toBeNull();
  for await (const _ of native.chat('first')) {}
  fail = false;
  for await (const _ of native.chat('second')) {}
  for await (const _ of native.chat('third')) {}
  expect(received[0]).toContain('Previous visible message');
  expect(received[1]).toContain('Previous visible message');
  expect(received[2]).toBe('third');
  native.destroy();
});

test('shared auxiliary inference replaces both query and title paths and cleans up its transport', async () => {
  let disposed = false;
  let nativeCalls = 0;
  const native = { queryLlm: async () => { nativeCalls++; return { text: 'native' }; }, runMiniCompletion: async () => 'native', destroy: () => {} } as unknown as AgentBackend;
  const draft = { ...configuration(), features: { ...configuration().features, utility: 'host' as const } };
  configureFrameworkAgent(native, draft, {} as any, () => ({ queryLlm: async () => ({ text: 'shared' }), destroy: () => { disposed = true; } } as unknown as AgentBackend));
  expect(await native.runMiniCompletion('title')).toBe('shared');
  expect((await native.queryLlm!({ prompt: 'summary' })).text).toBe('shared');
  expect(nativeCalls).toBe(0);
  native.destroy(); expect(disposed).toBe(true);
});

test('local validity tests negotiate a real adapter without saving the draft or requesting credentials', async () => {
  const before = readFileSync(join(process.env.TOKENBIRD_CONFIG_DIR!, 'agent-frameworks.json'), 'utf8');
  const result = await testBackendFrameworkConfiguration(configuration());
  expect(result.success).toBe(true);
  expect(result.checks.map(item => item.kind)).toEqual(['location', 'runtime', 'protocol']);
  const missing = await testBackendFrameworkConfiguration({ ...configuration(), executablePath: join(root, 'missing.exe') });
  expect(missing.success).toBe(false); expect(missing.checks.at(-1)?.kind).toBe('location');
  expect(readFileSync(join(process.env.TOKENBIRD_CONFIG_DIR!, 'agent-frameworks.json'), 'utf8')).toBe(before);
}, 30_000);

test('Pi validity test starts the actual bundled service and checks the local init response', async () => {
  const pi = getBackendFrameworkCatalog().frameworks.find(item => item.id === 'pi')!;
  const entrypointPath = resolve(import.meta.dir, '../../../../apps/electron/resources/pi-agent-server/index.js');
  setDetectedFrameworkLocation('pi', { executablePath: process.execPath, entrypointPath });
  const result = await testBackendFrameworkConfiguration(defaultFrameworkConfiguration(pi));
  expect(result).toMatchObject({ success: true });
  expect(result.checks.at(-1)).toMatchObject({ kind: 'protocol', success: true });
}, 30_000);
