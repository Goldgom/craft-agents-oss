import type { NativeCredentialChange } from '../credentials/native-types.ts';
import { SourceCredentialManager } from './credential-manager.ts';
import { loadSource, saveSourceConfig } from './storage.ts';
import type { LoadedSource } from './types.ts';

/** Post-commit metadata reconciliation only. Callers must treat failures as
 * warnings: the credential transaction is already durable and must not retry.
 * SessionManager.reloadMcpServers defers busy sessions until their turn ends.
 */
export async function reconcileSourceCredentialChanges(
  changes: Array<Pick<NativeCredentialChange, 'op' | 'id'>>,
  getWorkspace: (sourceWorkspaceId: string) => { id: string; rootPath: string } | null | undefined,
): Promise<{ workspaceIds: string[]; failed: boolean }> {
  const manager = new SourceCredentialManager();
  const affected = new Set<string>();
  const processed = new Set<string>();
  let failed = false;
  const uses = (source: LoadedSource, type: string) => {
    if (source.config.type === 'local' || source.config.mcp?.transport === 'stdio') return false;
    const authType = source.config.type === 'mcp' ? source.config.mcp?.authType : source.config.api?.authType;
    if (authType === 'none' || authType === undefined) return false;
    return manager.getCredentialId(source).type === type;
  };
  for (const { id } of changes) {
    if (!id.type.startsWith('source_') || !id.workspaceId || !id.sourceId) continue;
    const key = JSON.stringify([id.type, id.workspaceId, id.sourceId]);
    if (processed.has(key)) continue;
    processed.add(key);
    try {
      const workspace = getWorkspace(id.workspaceId);
      if (!workspace) { failed = true; continue; }
      const root = workspace.rootPath;
      const source = loadSource(root, id.sourceId);
      if (!source || !uses(source, id.type)) continue;
      const credential = await manager.load(source);
      // Respect a newer authType change while the credential read was pending.
      const latest = loadSource(root, id.sourceId);
      if (!latest || !uses(latest, id.type)) continue;
      affected.add(workspace.id);
      saveSourceConfig(root, {
        ...latest.config,
        isAuthenticated: !!credential?.value,
        connectionStatus: credential?.value ? 'connected' : 'needs_auth',
        connectionError: credential?.value ? undefined : 'Credentials were removed. Add credentials in Settings to reconnect.',
      });
    } catch { failed = true; }
  }
  return { workspaceIds: [...affected], failed };
}
