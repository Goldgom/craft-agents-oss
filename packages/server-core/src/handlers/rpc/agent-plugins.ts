import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { getLlmConnections, getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { refreshAgentPluginCatalog, saveAgentPluginManifest, deleteAgentPluginManifest, setAgentPluginEnabled,
  exportPortableAgentProfile, importPortableAgentProfile, getBackendFrameworkCatalog, saveBackendFrameworkConfiguration,
  testBackendFrameworkConfiguration, type AgentPluginRuntime } from '@craft-agent/shared/agent-plugins';
import { clearNativeCodexBinaryCache } from '@craft-agent/shared/codex/binary-resolver';
import { refreshBackendFrameworkLocations } from '@craft-agent/shared/agent/backend';
import { buildBackendHostRuntimeContext } from '../utils';
import type { RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';
import { describeFrameworkInstallation, installBackendFramework, cancelBackendFrameworkInstall } from '@craft-agent/shared/agent-plugins/framework-installer';

export const HANDLED_CHANNELS = [RPC_CHANNELS.agentPlugins.LIST, RPC_CHANNELS.agentPlugins.LIST_FRAMEWORKS,
  RPC_CHANNELS.agentPlugins.SAVE_FRAMEWORK, RPC_CHANNELS.agentPlugins.TEST_FRAMEWORK, RPC_CHANNELS.agentPlugins.INSTALL_FRAMEWORK,
  RPC_CHANNELS.agentPlugins.CANCEL_INSTALL, RPC_CHANNELS.agentPlugins.SET_ENABLED, RPC_CHANNELS.agentPlugins.SAVE,
  RPC_CHANNELS.agentPlugins.DELETE, RPC_CHANNELS.agentPlugins.EXPORT_PROFILE, RPC_CHANNELS.agentPlugins.IMPORT_PROFILE] as const;

function workspaceRoot(id?: string): string | undefined {
  if (!id) return undefined;
  const workspace = getWorkspaceByNameOrId(id);
  if (!workspace) throw new Error('Workspace not found');
  return workspace.rootPath;
}

export function registerAgentPluginHandlers(server: RpcServer, deps: HandlerDeps): void {
  refreshAgentPluginCatalog();
  const changed = async (id: AgentPluginRuntime) => {
    for (const connection of getLlmConnections()) {
      const runtime = connection.agentRuntime ?? (connection.providerType === 'anthropic' ? 'claude-code' : 'pi');
      if (runtime === id) await deps.sessionManager.refreshConnectionRuntime(connection.slug);
    }
    server.push(RPC_CHANNELS.agentPlugins.CHANGED, { to: 'all' });
  };
  server.handle(RPC_CHANNELS.agentPlugins.LIST, () => refreshAgentPluginCatalog());
  server.handle(RPC_CHANNELS.agentPlugins.LIST_FRAMEWORKS, () => {
    refreshBackendFrameworkLocations(buildBackendHostRuntimeContext(deps.platform));
    const catalog = getBackendFrameworkCatalog();
    return { ...catalog, frameworks: catalog.frameworks.map(describeFrameworkInstallation) };
  });
  server.handle(RPC_CHANNELS.agentPlugins.SAVE_FRAMEWORK, async (_ctx, value: unknown) => {
    const configuration = saveBackendFrameworkConfiguration(value);
    if (configuration.id === 'codex') clearNativeCodexBinaryCache();
    await changed(configuration.id);
  });
  server.handle(RPC_CHANNELS.agentPlugins.TEST_FRAMEWORK, (_ctx, value: unknown) => {
    refreshBackendFrameworkLocations(buildBackendHostRuntimeContext(deps.platform));
    return testBackendFrameworkConfiguration(value);
  });
  server.handle(RPC_CHANNELS.agentPlugins.SET_ENABLED, async (_ctx, id: AgentPluginRuntime, enabled: boolean) => {
    setAgentPluginEnabled(id, enabled); await changed(id);
  });
  server.handle(RPC_CHANNELS.agentPlugins.INSTALL_FRAMEWORK, async (_ctx, id: AgentPluginRuntime, source?: import('@craft-agent/shared/agent-plugins/frameworks').FrameworkDownloadSource) => {
    refreshBackendFrameworkLocations(buildBackendHostRuntimeContext(deps.platform));
    const result = await installBackendFramework(id, buildBackendHostRuntimeContext(deps.platform), progress => {
      server.push(RPC_CHANNELS.agentPlugins.INSTALL_PROGRESS, { to: 'all' }, progress);
    }, source);
    if (result.success) await changed(id);
    return result;
  });
  server.handle(RPC_CHANNELS.agentPlugins.CANCEL_INSTALL, (_ctx, id: AgentPluginRuntime) => cancelBackendFrameworkInstall(id));
  server.handle(RPC_CHANNELS.agentPlugins.SAVE, async (_ctx, manifest: unknown) => {
    const plugin = saveAgentPluginManifest(manifest); await changed(plugin.id);
  });
  server.handle(RPC_CHANNELS.agentPlugins.DELETE, async (_ctx, id: AgentPluginRuntime) => {
    deleteAgentPluginManifest(id); await changed(id);
  });
  server.handle(RPC_CHANNELS.agentPlugins.EXPORT_PROFILE, (_ctx, workspaceId?: string) => exportPortableAgentProfile(workspaceRoot(workspaceId)));
  server.handle(RPC_CHANNELS.agentPlugins.IMPORT_PROFILE, (_ctx, input: unknown, workspaceId?: string) => {
    const result = importPortableAgentProfile(input, workspaceRoot(workspaceId));
    server.push(RPC_CHANNELS.agentPlugins.CHANGED, { to: 'all' }); return result;
  });
}
