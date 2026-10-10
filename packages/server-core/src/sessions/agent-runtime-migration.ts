import type { AgentRuntimeProtocol } from '@craft-agent/shared/config';

/** Native ids are owned by an agent engine. Only visible transcript context is portable. */
export function migrateAgentSessionRuntime(state: {
  sdkSessionId?: string;
  sdkSessionRuntime?: AgentRuntimeProtocol;
  agentRuntimeMigrationContext?: string;
  branchFromSdkSessionId?: string;
  branchFromSdkCwd?: string;
  branchFromSdkTurnId?: string;
  messages: Array<{ role: string; content: string; isIntermediate?: boolean }>;
}, next: AgentRuntimeProtocol): boolean {
  const changed = state.sdkSessionRuntime != null ? state.sdkSessionRuntime !== next
    : !!state.sdkSessionId && next.startsWith('plugin:');
  if (changed) {
    state.sdkSessionId = undefined;
    state.branchFromSdkSessionId = undefined;
    state.branchFromSdkCwd = undefined;
    state.branchFromSdkTurnId = undefined;
    const messages = state.messages.filter(message => ['user', 'assistant'].includes(message.role) && !message.isIntermediate).slice(-6);
    let context = messages.map(message => `${message.role}: ${message.content.slice(0, 450)}`).join('\n\n');
    // Session list headers have an 8 KiB read budget; bound by UTF-8 bytes.
    while (Buffer.byteLength(context, 'utf8') > 2_000) context = context.slice(0, -1);
    state.agentRuntimeMigrationContext = context
      ? `<agent_backend_migration>\nThe agent backend has changed. This is recent visible conversation context; native hidden state and unfinished tool executions were not transferred.\n${context}\n</agent_backend_migration>` : undefined;
  }
  state.sdkSessionRuntime = next;
  return changed;
}
