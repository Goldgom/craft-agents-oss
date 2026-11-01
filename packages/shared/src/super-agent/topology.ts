import type { SuperAgentConfig, SuperAgentNode } from './types'

export function hasPlanningTopology(config: SuperAgentConfig | null | undefined): boolean {
  return config?.architecture === 'dynamic' && config.roleTopologyVersion === 2
}

/** Preserve dispatch identity and worker ownership when splitting an existing team. */
export function withSuperAgentPlanner(config: SuperAgentConfig): SuperAgentConfig {
  if (config.architecture !== 'dynamic') return config
  const dispatcher = config.nodes.find(node => node.role === 'orchestrator')
  if (!dispatcher) throw new Error('A dispatch node is required before adding a planner')
  let planner = config.nodes.find(node => node.role === 'planner')
  if (!planner) {
    let id = 'planner'
    for (let suffix = 2; config.nodes.some(node => node.id === id); suffix++) id = `planner-${suffix}`
    planner = { ...dispatcher, id, role: 'planner', name: '后台规划', avatar: '◇', dynamic: undefined,
      parentNodeId: undefined, description: '分析用户原始需求，维护需求契约与工作计划，汇总阶段结论。',
      workPreferences: '只与主节点和协调节点交流；按阶段交接计划，保留用户约束与证据引用。',
      sourceSlugs: [], skillSlugs: [], abilityProfileIds: [] }
  }
  return { ...config, roleTopologyVersion: 2,
    nodes: [...config.nodes.filter(node => node.role !== 'planner').map(node => node.role === 'worker'
      ? { ...node, parentNodeId: node.parentNodeId ?? dispatcher.id } : node), planner] }
}

export function canSuperAgentCommunicate(config: SuperAgentConfig, sender: SuperAgentNode, target: SuperAgentNode): boolean {
  if (sender.id === target.id) return false
  if (!hasPlanningTopology(config)) return true
  if (sender.role === 'coordinator') return target.role === 'planner'
  if (sender.role === 'planner') return target.role === 'coordinator' || target.role === 'orchestrator'
  if (sender.role === 'orchestrator') return target.role === 'planner' || target.role === 'worker' && target.parentNodeId === sender.id
  return target.role === 'orchestrator' && sender.parentNodeId === target.id
}

export function superAgentReportRecipient(config: SuperAgentConfig, sender: SuperAgentNode): string {
  const role = !hasPlanningTopology(config) ? 'coordinator'
    : sender.role === 'worker' ? 'orchestrator' : sender.role === 'orchestrator' ? 'planner' : 'coordinator'
  const target = config.nodes.find(node => node.role === role)
  if (!target || hasPlanningTopology(config) && !canSuperAgentCommunicate(config, sender, target)) throw new Error('No valid report recipient for this node')
  return target.id
}
