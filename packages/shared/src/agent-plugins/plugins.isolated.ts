import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Separate test process keeps application preferences/credentials untouched.
const root = mkdtempSync(join(tmpdir(), 'tokenbird-agent-plugins-'));
const previousConfig = process.env.TOKENBIRD_CONFIG_DIR;
process.env.TOKENBIRD_CONFIG_DIR = join(root, 'config');
const { PluginAgent } = await import('./plugin-agent.ts');
const { createBackend, resolveBackendContext } = await import('../agent/backend/factory.ts');
const { saveAgentPluginManifest, getAgentPluginManifest, refreshAgentPluginCatalog, deleteAgentPluginManifest } = await import('./storage.ts');
const { setAgentPluginCatalog } = await import('./catalog.ts');
const { getCompatibleAgentRuntimes, resolveAgentRuntime } = await import('../config/llm-connections.ts');
const { exportPortableAgentProfile, importPortableAgentProfile, parsePortableAgentProfile } = await import('./portable-profile.ts');
const { loadPreferences, updatePreferences } = await import('../config/preferences.ts');
const { saveWorkspaceConfig, loadWorkspaceConfig } = await import('../workspaces/storage.ts');
const { clearSessionExecutionPolicy, setSessionExecutionPolicy } = await import('../agent/core/session-execution-policy.ts');
const { AbortReason } = await import('../agent/backend/types.ts');
const { getCredentialManager } = await import('../credentials/index.ts');
const { getDefaultThinkingLevel } = await import('../config/storage.ts');
const { createBundledAgentManifest } = await import('./presets.ts');
const { resolveAgentPluginArguments } = await import('./stdio-client.ts');
const workspace = { id: 'test', slug: 'test', name: 'Test', rootPath: join(root, 'workspace'), createdAt: 1 };
const bridge = resolve(import.meta.dir, '__fixtures__/bridge.ts');
const manifest = {
  schemaVersion: 1 as const, id: 'plugin:fixture' as const, name: 'Fixture', description: 'Independent plugin', version: '1', enabled: true,
  capabilities: ['resume', 'hostTools', 'toolApproval', 'utilityCompletion'] as const,
  compatibility: { providerTypes: ['pi_compat' as const], authTypes: ['none' as const] },
  transport: { type: 'stdio' as const, command: process.execPath, args: [bridge], turnTimeoutMs: 1_000 },
};
let agents: InstanceType<typeof PluginAgent>[] = [];
function agent(overrides: Record<string, unknown> = {}) {
  const result = new PluginAgent({ provider: 'pi', providerType: 'pi_compat', authType: 'none', workspace, isHeadless: true,
    model: 'test-model', session: { id: 'plugin-test', workspaceRootPath: workspace.rootPath, createdAt: 1, lastUsedAt: 1 }, ...overrides } as any, { ...manifest, capabilities: [...manifest.capabilities] });
  agents.push(result); return result;
}
async function collect(instance: InstanceType<typeof PluginAgent>, text: string) {
  const events = []; for await (const value of instance.chat(text, undefined, { thinkingOverride: 'high' })) events.push(value); return events;
}
beforeAll(() => {
  mkdirSync(process.env.TOKENBIRD_CONFIG_DIR!, { recursive: true });
  writeFileSync(join(process.env.TOKENBIRD_CONFIG_DIR!, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id, activeSessionId: null, llmConnections: [] }));
  mkdirSync(workspace.rootPath, { recursive: true });
  writeFileSync(join(workspace.rootPath, 'instructions.md'), 'Project preferences from host');
  saveWorkspaceConfig(workspace.rootPath, { id: workspace.id, name: workspace.name, createdAt: 1, updatedAt: 1, defaults: {} } as any);
});
afterEach(async () => { await Promise.all(agents.map(instance => instance.disposeForRestart())); agents = []; setAgentPluginCatalog([]); clearSessionExecutionPolicy('plugin-test'); });
afterAll(() => { if (previousConfig == null) delete process.env.TOKENBIRD_CONFIG_DIR; else process.env.TOKENBIRD_CONFIG_DIR = previousConfig; });

describe('Agent plugin runtime', () => {
  test('streams a real subprocess, preserves ids, applies thinking and drops stale events', async () => {
    const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'must-not-leak';
    try {
      const instance = agent(); expect((await instance.postInit()).authInjected).toBe(true);
      const events = await collect(instance, 'hello');
      expect(events.some(value => value.type === 'text_delta' && value.text === 'STALE')).toBe(false);
      const completedText = events.find(value => value.type === 'text_complete');
      expect(completedText?.type === 'text_complete' ? completedText.text : '').toContain('hello high');
      expect(JSON.stringify(events)).toContain('ambient=false'); expect(JSON.stringify(events)).toContain('credentials=false');
      expect(instance.getSessionId()).toBe('fixture-native-session');
      expect(events.at(-1)).toMatchObject({ type: 'complete', usage: { inputTokens: 5, outputTokens: 2 } });
      expect(await instance.runMiniCompletion('utility')).toBe('utility result');
      expect((await collect(instance, 'second turn')).filter(value => value.type === 'complete')).toHaveLength(1);
    } finally { if (previous == null) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
  });
  test('provides shared host tools to a backend without its own file reader', async () => {
    const instance = agent(); instance.setPermissionMode('safe');
    const events = await collect(instance, 'read');
    expect(events.some(value => value.type === 'tool_result' && value.result === 'Project preferences from host')).toBe(true);
  });
  test('safe mode denies native writes and Ask requires actual approval', async () => {
    const instance = agent(); instance.setPermissionMode('safe');
    expect(JSON.stringify(await collect(instance, 'authorize'))).toContain('allowed\\\":false');
    instance.setPermissionMode('ask');
    instance.onPermissionRequest = request => instance.respondToPermission(request.requestId, true);
    expect(JSON.stringify(await collect(instance, 'authorize'))).toContain('allowed\\\":true');
    instance.onPermissionRequest = null;
    expect(JSON.stringify(await collect(instance, 'authorize'))).toContain('Approval UI is unavailable');
  });
  test('shared write execution preserves safe mode and applies approved writes', async () => {
    const instance = agent(); instance.setPermissionMode('safe');
    const target = join(workspace.rootPath, 'approved-output.txt');
    expect(JSON.stringify(await collect(instance, 'write-file'))).toContain('isError');
    expect(existsSync(target)).toBe(false);
    instance.setPermissionMode('ask');
    instance.onPermissionRequest = request => instance.respondToPermission(request.requestId, true);
    const events = await collect(instance, 'write-file');
    expect(events.some(value => value.type === 'tool_result' && !value.isError)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('Written through shared host tools');
  });
  test('process failures and invalid protocol output finish the turn with an error', async () => {
    for (const message of ['crash', 'invalid', 'hang']) {
      const instance = agent(); const events = await collect(instance, message);
      expect(events.some(value => value.type === 'error')).toBe(true); expect(events.at(-1)?.type).toBe('complete'); expect(instance.isProcessing()).toBe(false);
    }
  });
  test('stopping a turn releases the native process', async () => {
    const instance = agent(); await instance.postInit(); const active = collect(instance, 'hang');
    await new Promise(resolve => setTimeout(resolve, 50)); instance.forceAbort(AbortReason.UserStop);
    await active; expect(instance.isProcessing()).toBe(false); expect(instance.getProcessId()).toBeUndefined();
  });
  test('restores a plugin-owned native session', async () => {
    const instance = agent({ session: { id: 'plugin-test', workspaceRootPath: workspace.rootPath, sdkSessionId: 'existing-native', createdAt: 1, lastUsedAt: 1 } });
    await instance.postInit(); expect(instance.getSessionId()).toBe('existing-native');
  });
  test('retains migration context after a failed turn and consumes it after a successful turn', async () => {
    let context: string | undefined = '<agent_backend_migration>prior requirement</agent_backend_migration>';
    const instance = agent({ getAgentRuntimeMigrationContext: () => context, markAgentRuntimeMigrationApplied: () => { context = undefined; } });
    await collect(instance, 'crash'); expect(context).toContain('prior requirement');
    await collect(instance, 'hello'); expect(context).toBeUndefined();
  });
  test('credential opt-in requests only the selected connection and keeps keys out of chat events', async () => {
    const lookup = spyOn(getCredentialManager(), 'getLlmApiKey').mockImplementation(async slug => {
      expect(slug).toBe('selected-connection'); return 'isolated-provider-secret';
    });
    try {
      const instance = new PluginAgent({ provider: 'pi', providerType: 'pi_compat', authType: 'api_key', connectionSlug: 'selected-connection', workspace,
        isHeadless: true, session: { id: 'credential-test', workspaceRootPath: workspace.rootPath, createdAt: 1, lastUsedAt: 1 } },
      { ...manifest, capabilities: [...manifest.capabilities], useConnectionCredentials: true, compatibility: { providerTypes: ['pi_compat'], authTypes: ['api_key'] } });
      agents.push(instance); expect((await instance.postInit()).authInjected).toBe(true);
      const events = JSON.stringify(await collect(instance, 'hello'));
      expect(events).toContain('credentials=true'); expect(events).not.toContain('isolated-provider-secret'); expect(lookup).toHaveBeenCalledTimes(1);
    } finally { lookup.mockRestore(); }
  });
});

describe('Plugin management and migration', () => {
  test('exposes five backend choices, with native bridge runtimes requiring configuration', () => {
    const catalog = refreshAgentPluginCatalog();
    expect(catalog.plugins.map(value => value.id)).toEqual(expect.arrayContaining(['pi', 'codex', 'claude-code', 'plugin:hermes', 'plugin:dsh']));
    expect(catalog.plugins.find(value => value.id === 'plugin:dsh')).toMatchObject({ enabled: false, setupRequired: true });
    expect(getCompatibleAgentRuntimes({ providerType: 'pi_compat', piAuthProvider: 'openai' })).not.toContain('plugin:dsh');
    expect(() => createBundledAgentManifest({ backend: 'hermes', pythonPath: 'python' })).toThrow('Hermes');
    expect(() => createBundledAgentManifest({ backend: 'dsh', pythonPath: '' })).toThrow('Python');
    const preset = createBundledAgentManifest({ backend: 'dsh', pythonPath: 'python' });
    saveAgentPluginManifest(preset);
    expect(refreshAgentPluginCatalog().plugins.filter(value => value.id === 'plugin:dsh')).toHaveLength(1);
    expect(getCompatibleAgentRuntimes({ providerType: 'pi', piAuthProvider: 'deepseek', authType: 'api_key' })).toContain('plugin:dsh');
    expect(getCompatibleAgentRuntimes({ providerType: 'anthropic', authType: 'api_key' })).not.toContain('plugin:dsh');
    expect(resolveAgentPluginArguments(preset.transport.args)[0]).toMatch(/dsh_bridge\.py$/);
    expect(() => resolveAgentPluginArguments(['tokenbird:bridge:unknown'])).toThrow('Unknown');
    deleteAgentPluginManifest(preset.id);
    expect(refreshAgentPluginCatalog().plugins.find(value => value.id === 'plugin:dsh')).toMatchObject({ setupRequired: true });
  });
  test('installs through the factory and exposes only compatible plugins', () => {
    saveAgentPluginManifest({ ...manifest, capabilities: [...manifest.capabilities] });
    expect(refreshAgentPluginCatalog().plugins.find(value => value.id === manifest.id)).not.toHaveProperty('transport');
    const connection = { providerType: 'pi_compat' as const, authType: 'none' as const };
    expect(getCompatibleAgentRuntimes(connection)).toContain(manifest.id);
    expect(getCompatibleAgentRuntimes({ providerType: 'anthropic' })).not.toContain(manifest.id);
    const created = createBackend({ provider: 'pi', providerType: 'pi_compat', authType: 'none', agentRuntime: manifest.id, workspace, isHeadless: true });
    expect(created).toBeInstanceOf(PluginAgent); created.destroy();
    saveAgentPluginManifest({ ...manifest, capabilities: [...manifest.capabilities], enabled: false });
    expect(() => getAgentPluginManifest(manifest.id)).toThrow('disabled');
    expect(resolveAgentRuntime({ ...connection, agentRuntime: manifest.id })).toBe(manifest.id);
    expect(() => createBackend({ provider: 'pi', agentRuntime: manifest.id, workspace })).toThrow('disabled');
    deleteAgentPluginManifest(manifest.id);
    expect(() => getAgentPluginManifest(manifest.id)).toThrow('missing');
  });
  test('rejects invalid manifests and incompatible credentials instead of changing transport', () => {
    expect(() => saveAgentPluginManifest({ ...manifest, id: 'plugin:../../escape' })).toThrow();
    expect(() => saveAgentPluginManifest({ ...manifest, transport: { ...manifest.transport, shell: true } })).toThrow();
    expect(() => agent({ providerType: 'anthropic' })).toThrow('incompatible');
    expect(() => deleteAgentPluginManifest('pi')).toThrow('Built-in');
  });
  test('exports only portable settings and imports instructions without replacing existing workspace defaults', () => {
    updatePreferences({ name: 'User', notes: 'Use Chinese', preferredProxy: 'http://secret-proxy', startupServerLocation: 'private-server', birdCompanion: { alwaysVisible: true } });
    const exported = exportPortableAgentProfile(workspace.rootPath);
    expect(exported.preferences.name).toBe('User'); expect(JSON.stringify(exported)).not.toContain('secret-proxy'); expect(JSON.stringify(exported)).not.toContain('private-server');
    const imported = importPortableAgentProfile('Always verify the result before reporting completion.', workspace.rootPath);
    expect(imported.workspacePrompts?.[0]?.content).toContain('verify the result');
    importPortableAgentProfile('Always verify the result before reporting completion.', workspace.rootPath);
    expect(loadWorkspaceConfig(workspace.rootPath)?.prompts).toHaveLength(1);
    expect(loadPreferences().birdCompanion?.alwaysVisible).toBe(true);
  });
  test('validates the complete preference package before changing stored settings', () => {
    expect(() => importPortableAgentProfile({ format: 'tokenbird-agent-profile', version: 1, preferences: { name: 'Changed', apiKey: 'secret' } }, workspace.rootPath)).toThrow();
    expect(loadPreferences().name).toBe('User');
    expect(() => parsePortableAgentProfile('{broken json')).toThrow();
    expect(() => importPortableAgentProfile('Instructions without a workspace')).toThrow('Select a workspace');
  });
  test('round-trips a versioned preference package through the existing stores', () => {
    const profile = exportPortableAgentProfile(workspace.rootPath);
    const result = importPortableAgentProfile(JSON.stringify({ ...profile, defaultThinkingLevel: 'high' }), workspace.rootPath);
    expect(result.defaultThinkingLevel).toBe('high'); expect(getDefaultThinkingLevel()).toBe('high');
    expect(result.workspacePrompts).toHaveLength(1); expect(loadPreferences().startupServerLocation).toBe('private-server');
  });
});
