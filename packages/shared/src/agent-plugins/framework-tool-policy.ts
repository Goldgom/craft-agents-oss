import type { BackendFrameworkConfiguration } from './frameworks.ts';

const policies = new Map<string, { owner: object; features: BackendFrameworkConfiguration['features'] }>();
export function registerFrameworkToolPolicy(sessionId: string, owner: object, features: BackendFrameworkConfiguration['features']): () => void {
  policies.set(sessionId, { owner, features });
  return () => { if (policies.get(sessionId)?.owner === owner) policies.delete(sessionId); };
}

export function frameworkToolBlockReason(sessionId: string, toolName: string): string | undefined {
  const features = policies.get(sessionId)?.features;
  if (!features) return;
  const name = toolName.replace(/^mcp__session__/, '');
  if (features.browser === 'disabled' && (name === 'browser_tool' || name.startsWith('mcp__browser__'))) return 'Browser tools are disabled for this backend framework';
  if (features.files === 'disabled' && ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Bash', 'NotebookEdit', 'KillShell', 'TaskStop'].includes(name)) return 'File and command tools are disabled for this backend framework';
  if (features.sources === 'disabled' && toolName.startsWith('mcp__') && !toolName.startsWith('mcp__session__') && !toolName.startsWith('mcp__browser__')) return 'Data source tools are disabled for this backend framework';
  if (features.sessionTools === 'disabled' && toolName.startsWith('mcp__session__') && name !== 'browser_tool' && name !== 'call_llm') return 'Page and session tools are disabled for this backend framework';
}
