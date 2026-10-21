/** Super Agent nodes use the session browser instead of native web tools. */
export const NATIVE_WEB_TOOL_NAMES = ['WebFetch', 'WebSearch'] as const;
const nativeWebToolNames = new Set<string>(NATIVE_WEB_TOOL_NAMES.map(name => name.toLowerCase()));

export function filterNativeWebTools<T extends { name: string }>(tools: T[], browserToolOnly = false): T[] {
  if (!browserToolOnly) return tools;
  return tools.filter(tool => !nativeWebToolNames.has(tool.name.toLowerCase().replace(/_/g, '')));
}

export type SuperAgentToolRole = 'coordinator' | 'orchestrator' | 'worker';

const sharedTeamTools = ['send_agent_message', 'collaboration_board', 'get_session_info', 'super_agent_message', 'super_agent_task', 'super_agent_library', 'saved_credentials'];
const roleTools: Record<SuperAgentToolRole, readonly string[]> = {
  coordinator: [...sharedTeamTools, 'super_agent_settings', 'super_agent_intent', 'super_agent_deliver'],
  orchestrator: [...sharedTeamTools, 'super_agent_dispatch', 'super_agent_plan', 'super_agent_board', 'super_agent_accept', 'super_agent_resources'],
  worker: [...sharedTeamTools, 'super_agent_board', 'super_agent_resources', 'super_agent_script'],
};
const collaborationTools = new Set(Object.values(roleTools).flat());
const delegationTools = new Set(['call_llm', 'spawn_session', 'Task', 'Agent', 'spawn_agent', 'delegate', 'create_task']);

export function superAgentRoleToolNames(role: SuperAgentToolRole): readonly string[] {
  return roleTools[role];
}

/** Fail before model inference when a backend cannot provide the node's essential protocol. */
export function assertSuperAgentTools(tools: readonly { name: string }[], role?: SuperAgentToolRole): void {
  if (!role) return;
  const required = role === 'coordinator' ? ['super_agent_intent', 'super_agent_message', 'super_agent_deliver']
    : role === 'orchestrator' ? ['super_agent_plan', 'super_agent_dispatch', 'super_agent_resources', 'super_agent_accept', 'super_agent_message']
    : ['super_agent_task', 'super_agent_message', 'super_agent_resources'];
  const names = new Set(tools.map(tool => tool.name.replace(/^mcp__session__/, '')));
  const missing = required.filter(name => !names.has(name));
  if (missing.length) throw new Error(`Super Agent ${role} tools are unavailable: ${missing.join(', ')}. Check the backend tool registration and session tools configuration.`);
}

/** Tool visibility follows node responsibilities; execution still checks arguments and grants. */
export function filterSuperAgentTools<T extends { name: string }>(tools: T[], role?: SuperAgentToolRole): T[] {
  if (!role) return tools;
  const allowed = new Set(roleTools[role]);
  return tools.filter(tool => {
    const name = tool.name.replace(/^mcp__session__/, '');
    if (role !== 'worker') return (!tool.name.startsWith('mcp__') || tool.name.startsWith('mcp__session__')) && allowed.has(name);
    if (collaborationTools.has(name)) return allowed.has(name);
    return !delegationTools.has(name);
  });
}

/** Older subprocess callers only send a boolean; preserve both management tool sets. */
export function filterInteractionTools<T extends { name: string }>(tools: T[], interactionOnly = false, role?: SuperAgentToolRole): T[] {
  if (role) return filterSuperAgentTools(tools, role);
  if (!interactionOnly) return tools;
  const allowed = new Set([...roleTools.coordinator, ...roleTools.orchestrator]);
  return tools.filter(tool => (!tool.name.startsWith('mcp__') || tool.name.startsWith('mcp__session__')) && allowed.has(tool.name.replace(/^mcp__session__/, '')));
}
