/** Super Agent nodes use the session browser instead of native web tools. */
export const NATIVE_WEB_TOOL_NAMES = ['WebFetch', 'WebSearch'] as const;
const nativeWebToolNames = new Set<string>(NATIVE_WEB_TOOL_NAMES.map(name => name.toLowerCase()));

export function filterNativeWebTools<T extends { name: string }>(tools: T[], browserToolOnly = false): T[] {
  if (!browserToolOnly) return tools;
  return tools.filter(tool => !nativeWebToolNames.has(tool.name.toLowerCase().replace(/_/g, '')));
}

/** The interaction node communicates with workers; workers perform tool work. */
export function filterInteractionTools<T extends { name: string }>(tools: T[], interactionOnly = false): T[] {
  if (!interactionOnly) return tools;
  return tools.filter(tool => ['send_agent_message', 'mcp__session__send_agent_message'].includes(tool.name));
}
