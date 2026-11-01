/** Super Agent nodes use the session browser instead of native web tools. */
export const NATIVE_WEB_TOOL_NAMES = ['WebFetch', 'WebSearch'] as const;
const nativeWebToolNames = new Set<string>(NATIVE_WEB_TOOL_NAMES.map(name => name.toLowerCase()));

export function filterNativeWebTools<T extends { name: string }>(tools: T[], browserToolOnly = false): T[] {
  if (!browserToolOnly) return tools;
  return tools.filter(tool => !nativeWebToolNames.has(tool.name.toLowerCase().replace(/_/g, '')));
}

export type SuperAgentToolRole = 'coordinator' | 'planner' | 'orchestrator' | 'worker';
export type SuperAgentToolArchitecture = 'dynamic';

/** Shared with execution policy so the interaction node sees exactly its permitted routes. */
export const DYNAMIC_INTERACTION_TOOL_NAMES = [
  'super_agent_health', 'super_agent_intent', 'super_agent_deliver', 'super_agent_work_list',
  'super_agent_reports', 'super_agent_resource_catalog', 'super_agent_settings',
] as const;

const sharedTeamTools = ['send_agent_message', 'collaboration_board', 'get_session_info', 'super_agent_message', 'super_agent_task', 'super_agent_library', 'saved_credentials'];
const roleTools: Record<SuperAgentToolRole, readonly string[]> = {
  coordinator: [...sharedTeamTools, 'super_agent_settings', 'super_agent_intent', 'super_agent_deliver'],
  planner: [...sharedTeamTools, 'super_agent_intent', 'super_agent_plan', 'super_agent_report', 'super_agent_settings', 'super_agent_finish_turn'],
  orchestrator: [...sharedTeamTools, 'super_agent_dispatch', 'super_agent_plan', 'super_agent_board', 'super_agent_accept', 'super_agent_resources', 'super_agent_finish_turn'],
  worker: [...sharedTeamTools, 'super_agent_board', 'super_agent_resources', 'super_agent_script'],
};
const collaborationTools = new Set(Object.values(roleTools).flat());
const delegationTools = new Set(['call_llm', 'spawn_session', 'Task', 'Agent', 'spawn_agent', 'delegate', 'create_task']);
const dynamicQueries = ['super_agent_health', 'super_agent_work_list', 'super_agent_reports', 'super_agent_resource_catalog'];
const dynamicRoleTools: Record<SuperAgentToolRole, readonly string[]> = {
  coordinator: DYNAMIC_INTERACTION_TOOL_NAMES,
  planner: [...roleTools.planner, ...dynamicQueries, 'Read', 'Grep', 'Glob', 'read', 'grep', 'find', 'ls'],
  orchestrator: [...roleTools.orchestrator.filter(name => name !== 'get_session_info'), ...dynamicQueries,
    'super_agent_report', 'super_agent_manage_resources', 'super_agent_settings',
    'Read', 'Grep', 'Glob', 'read', 'grep', 'find', 'ls'],
  worker: [...roleTools.worker, ...dynamicQueries, 'super_agent_report'],
};
const dynamicCollaborationTools = new Set([...collaborationTools,
  'super_agent_submit_request', ...Object.values(dynamicRoleTools).flat().filter(name => name.startsWith('super_agent_'))]);

export function superAgentRoleToolNames(role: SuperAgentToolRole, architecture?: SuperAgentToolArchitecture, roleTopologyVersion?: 2): readonly string[] {
  const names = (architecture === 'dynamic' ? dynamicRoleTools : roleTools)[role];
  if (architecture === 'dynamic' && roleTopologyVersion === 2) {
    if (role === 'coordinator') return [...names.filter(name => name !== 'super_agent_intent'), 'super_agent_submit_request'];
    if (role === 'orchestrator') return names.filter(name => name !== 'super_agent_plan');
    if (role === 'planner') return names.filter(name => name !== 'get_session_info');
  }
  return names;
}

/** Fail before model inference when a backend cannot provide the node's essential protocol. */
export function assertSuperAgentTools(tools: readonly { name: string }[], role?: SuperAgentToolRole, architecture?: SuperAgentToolArchitecture, roleTopologyVersion?: 2): void {
  if (!role) return;
  const required = architecture === 'dynamic' && role === 'coordinator' ? roleTopologyVersion === 2 ? superAgentRoleToolNames(role, architecture, roleTopologyVersion) : DYNAMIC_INTERACTION_TOOL_NAMES
    : role === 'coordinator' ? ['super_agent_intent', 'super_agent_message', 'super_agent_deliver']
    : role === 'planner' ? ['super_agent_intent', 'super_agent_plan', 'super_agent_report', 'super_agent_message']
    : role === 'orchestrator' ? [...(roleTopologyVersion === 2 ? [] : ['super_agent_plan']), 'super_agent_dispatch', 'super_agent_resources', 'super_agent_accept', 'super_agent_message']
    : ['super_agent_task', 'super_agent_message', 'super_agent_resources'];
  const names = new Set(tools.map(tool => tool.name.replace(/^mcp__session__/, '')));
  const missing = required.filter(name => !names.has(name));
  if (missing.length) throw new Error(`Super Agent ${role} tools are unavailable: ${missing.join(', ')}. Check the backend tool registration and session tools configuration.`);
}

/** Tool visibility follows node responsibilities; execution still checks arguments and grants. */
export function filterSuperAgentTools<T extends { name: string }>(tools: T[], role?: SuperAgentToolRole, architecture?: SuperAgentToolArchitecture, roleTopologyVersion?: 2): T[] {
  if (!role) return tools;
  const allowed = new Set(superAgentRoleToolNames(role, architecture, roleTopologyVersion));
  const scopedCollaborationTools = architecture === 'dynamic' ? dynamicCollaborationTools : collaborationTools;
  return tools.filter(tool => {
    const name = tool.name.replace(/^mcp__session__/, '');
    if (role !== 'worker') return (!tool.name.startsWith('mcp__') || tool.name.startsWith('mcp__session__')) && allowed.has(name);
    if (scopedCollaborationTools.has(name)) return allowed.has(name);
    return !delegationTools.has(name);
  });
}

/** Older subprocess callers only send a boolean; preserve both management tool sets. */
export function filterInteractionTools<T extends { name: string }>(tools: T[], interactionOnly = false, role?: SuperAgentToolRole, architecture?: SuperAgentToolArchitecture, roleTopologyVersion?: 2): T[] {
  if (role) return filterSuperAgentTools(tools, role, architecture, roleTopologyVersion);
  if (!interactionOnly) return tools;
  const allowed = new Set([...roleTools.coordinator, ...roleTools.orchestrator]);
  return tools.filter(tool => (!tool.name.startsWith('mcp__') || tool.name.startsWith('mcp__session__')) && allowed.has(tool.name.replace(/^mcp__session__/, '')));
}
