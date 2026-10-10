import { expect, test } from 'bun:test';
import { migrateAgentSessionRuntime } from './agent-runtime-migration';
import { buildRestartRequiredSignature } from './runtime-config';

test('changing agent engines clears native ids and carries recent visible context', () => {
  const state = { sdkSessionId: 'pi-native-id', sdkSessionRuntime: 'pi' as const, messages: [{ role: 'user', content: 'Project requirement' }, { role: 'assistant', content: 'internal', isIntermediate: true }] };
  expect(migrateAgentSessionRuntime(state, 'plugin:hermes')).toBe(true);
  expect(state.sdkSessionId).toBeUndefined();
  expect((state as any).agentRuntimeMigrationContext).toContain('Project requirement');
  expect((state as any).agentRuntimeMigrationContext).not.toContain('internal');
  expect(migrateAgentSessionRuntime(state, 'plugin:hermes')).toBe(false);
});
test('legacy built-in sessions remain resumable while legacy ids cannot be given to new plugins', () => {
  const legacy = { sdkSessionId: 'native-id', messages: [] };
  expect(migrateAgentSessionRuntime(legacy, 'pi')).toBe(false); expect(legacy.sdkSessionId).toBe('native-id');
  const plugin = { sdkSessionId: 'native-id', messages: [] };
  expect(migrateAgentSessionRuntime(plugin, 'plugin:other')).toBe(true); expect(plugin.sdkSessionId).toBeUndefined();
});
test('changing a plugin executable/config requires restarting the process', () => {
  const config = { connection: null, provider: 'pi' as const, agentRuntime: 'plugin:other' as const, resolvedModel: 'model' };
  expect(buildRestartRequiredSignature({ ...config, agentPluginFingerprint: 'old' })).not.toBe(buildRestartRequiredSignature({ ...config, agentPluginFingerprint: 'new' }));
});
