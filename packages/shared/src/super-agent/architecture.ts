import type { SuperAgentConfig, SuperAgentTask } from './types'

/** Add a separate planner while preserving every existing node and binding. */
export function withSuperAgentOrchestrator(config: SuperAgentConfig): SuperAgentConfig {
  if (config.nodes.some(node => node.role === 'orchestrator')) return config
  if (config.nodes.length >= 32) throw new Error('Reserve one node slot for the orchestrator before upgrading this team')
  const main = config.nodes.find(node => node.role === 'coordinator')!
  let id = 'orchestrator'
  for (let suffix = 2; config.nodes.some(node => node.id === id); suffix++) id = `orchestrator-${suffix}`
  const planner = { ...main, id, role: 'orchestrator' as const, name: '任务编排', avatar: '◇',
    description: '拆解已授权意图，编排依赖与资源，维护计划并依据工作节点证据验收。',
    workPreferences: '按职责与负载派工；先满足依赖，避免同一资源并发修改。受阻时调整计划，需要用户决定时交意图主节点。',
    sourceSlugs: [], abilityProfileIds: [] }
  return { ...config, nodes: [main, planner, ...config.nodes.filter(node => node.id !== main.id)] }
}

export function superAgentDependencySatisfied(task: SuperAgentTask): boolean {
  return task.status === 'completed' && (!task.actionReceipt || task.actionReceipt.status === 'applied')
    && task.acceptance?.status !== 'rejected' && task.acceptance?.status !== 'stale'
    && (!(task.acceptanceCriteria?.length || task.requiresIndependentReview) || task.acceptance?.status === 'accepted')
}

/** Resources are names or canonical project paths, with parent/child conflicts. */
export function superAgentResourcesConflict(left: string[], right: string[]): boolean {
  const canonical = (value: string) => value.replace(/\\/g, '/').replace(/\/+/g, '/').split('/').filter(part => part !== '.').join('/').replace(/\/+$/, '').toLowerCase()
  return left.some(a => right.some(b => {
    const x = canonical(a), y = canonical(b)
    return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
  }))
}
