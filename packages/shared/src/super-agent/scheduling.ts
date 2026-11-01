import type { SuperAgentState, SuperAgentTask } from './types'
import { superAgentDependencySatisfied, superAgentResourcesConflict } from './architecture'

export type SuperAgentTaskBlocker = { code: 'goalChanged' | 'goalCancelled' | 'dependencyCancelled' | 'dependencyFailed' | 'dependencyMissing' | 'dependencyWaiting' | 'planBlocked' | 'planChanged' | 'resourceBusy'; detail: string; permanent: boolean }

/** Execution completion and explicitly requested acceptance share one checklist rule. */
export function superAgentTaskCompleted(state: SuperAgentState, task: SuperAgentTask): boolean {
  const goal = state.intents?.find(goal => goal.id === task.goalId)
  const plan = state.plans.find(plan => plan.id === task.planId)
  return superAgentDependencySatisfied(task) && task.phase !== 'waiting' && task.phase !== 'outcome-unknown'
    && (!goal || goal.status !== 'cancelled' && task.goalRevision === (goal.revision ?? 1))
    && (task.planRevision == null || !plan || task.planRevision === (plan.contractRevision ?? plan.revision))
    && !state.operations?.some(operation => operation.taskId === task.id && ['prepared', 'running', 'unknown'].includes(operation.status))
}

/** Active tasks hold their declared resources; stopped tasks hold only unsettled effects. */
export function superAgentResourceBlockers(state: SuperAgentState, task: SuperAgentTask) {
  return state.tasks.filter(other => other.id !== task.id).flatMap(other => {
    const operations = (state.operations ?? []).filter(operation => operation.taskId === other.id && ['prepared', 'running', 'unknown'].includes(operation.status))
    const active = other.status === 'running'
      || state.nodes.some(node => ['preparing', 'working'].includes(node.status) && node.activeTaskId === other.id)
      || state.scripts.some(script => script.taskId === other.id && ['running', 'untracked'].includes(script.status))
    // Legacy operations without audited scopes retain the original conservative claims.
    const claims = active ? other.resources ?? [] : operations.flatMap(operation => operation.resourceClaims ?? other.resources ?? [])
    const resources = [...new Set(claims.filter(claim => superAgentResourcesConflict(task.resources ?? [], [claim])))]
    return resources.length ? [{ taskId: other.id, title: other.title, resources,
      operationIds: operations.filter(operation => superAgentResourcesConflict(task.resources ?? [], operation.resourceClaims ?? other.resources ?? [])).map(operation => operation.id) }] : []
  })
}

/** Explain durable queue blockers without guessing from an idle node or old model output. */
export function superAgentTaskBlocker(state: SuperAgentState, task: SuperAgentTask): SuperAgentTaskBlocker | undefined {
  const goal = state.intents?.find(goal => goal.id === task.goalId)
  if (goal?.status === 'cancelled') return { code: 'goalCancelled', detail: goal.goal, permanent: true }
  if (goal && task.goalRevision !== (goal.revision ?? 1)) return { code: 'goalChanged', detail: `${task.goalRevision ?? '?'} → ${goal.revision ?? 1}`, permanent: true }
  for (const id of task.dependsOn ?? []) {
    const dependency = state.tasks.find(item => item.id === id)
    if (!dependency) return { code: 'dependencyMissing', detail: id, permanent: true }
    if (dependency.status === 'cancelled') return { code: 'dependencyCancelled', detail: dependency.title, permanent: true }
    if (dependency.status === 'failed') return { code: 'dependencyFailed', detail: dependency.title, permanent: false }
    const ready = task.reviewOf === id ? dependency.status === 'completed' && (!dependency.actionReceipt || dependency.actionReceipt.status === 'applied') : superAgentDependencySatisfied(dependency)
    if (!ready) return { code: 'dependencyWaiting', detail: dependency.title, permanent: false }
    if (state.operations?.some(operation => operation.taskId === id && ['prepared', 'running', 'unknown'].includes(operation.status))) {
      return { code: 'dependencyWaiting', detail: `${dependency.title}: operation outcome is unsettled`, permanent: false }
    }
  }
  const plan = state.plans.find(plan => plan.id === task.planId)
  if (plan?.status === 'blocked' || plan?.status === 'cancelled') return { code: 'planBlocked', detail: plan.note || plan.title, permanent: plan.status === 'cancelled' }
  if (plan && task.planRevision != null && task.planRevision !== (plan.contractRevision ?? plan.revision)) return { code: 'planChanged', detail: plan.title, permanent: true }
  const resources = superAgentResourceBlockers(state, task)
  if (resources.length) return { code: 'resourceBusy', detail: resources.map(blocker => `${blocker.title} (${blocker.resources.join(', ')})${blocker.operationIds.length ? `: ${blocker.operationIds.join(', ')}` : ''}`).join('; '), permanent: false }
  return undefined
}
