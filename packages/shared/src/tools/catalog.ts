import { getSessionToolDefs } from '@craft-agent/session-tools-core';
import { FEATURE_FLAGS } from '../feature-flags.ts';
import { proxyToolName } from '../mcp/proxy-tool-name.ts';

export interface BuiltinToolCatalogEntry {
  name: string;
  description: string;
  category: 'core' | 'session';
}

const CORE_TOOLS: readonly BuiltinToolCatalogEntry[] = [
  { name: 'Read', description: 'Read files from the current workspace.', category: 'core' },
  { name: 'Write', description: 'Create or overwrite files in the current workspace.', category: 'core' },
  { name: 'Edit', description: 'Apply targeted edits to existing files.', category: 'core' },
  { name: 'Bash', description: 'Run shell commands in the workspace environment.', category: 'core' },
  { name: 'Grep', description: 'Search file contents using text or regular expressions.', category: 'core' },
  { name: 'Glob', description: 'Match workspace files using glob patterns.', category: 'core' },
  { name: 'Find', description: 'Find files and directories by name or pattern.', category: 'core' },
  { name: 'LS', description: 'List files and directories.', category: 'core' },
  { name: 'Agent', description: 'Delegate a bounded task to a specialized subagent.', category: 'core' },
  { name: 'WebSearch', description: 'Search the web using the active model provider.', category: 'core' },
  { name: 'WebFetch', description: 'Fetch and extract content from a web page.', category: 'core' },
  { name: 'mcp__craft-agents-docs__SearchCraftAgents', description: 'Search the built-in Craft Agent feature documentation.', category: 'session' },
];

/** Return the built-in tools that Craft Agent can expose to a workspace session. */
export function getBuiltinToolCatalog(): BuiltinToolCatalogEntry[] {
  const sessionTools = getSessionToolDefs({
    includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback,
  }).map((tool) => ({
    name: proxyToolName('session', tool.name),
    description: tool.description,
    category: 'session' as const,
  }));

  return [...CORE_TOOLS, ...sessionTools];
}
