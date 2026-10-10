import type { SuperAgentState, SuperAgentTask } from './types'
import { superAgentDependencySatisfied } from './architecture'

export type SuperAgentTaskBlocker = { code: 'goalChanged' | 'goalCancelled' | 'dependencyCancelled' | 'dependencyFailed' | 'dependencyMissing' | 'dependencyWaiting' | 'planBlocked'; detail: string; permanent: boolean }

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
  }
  const plan = state.plans.find(plan => plan.id === task.planId)
  if (plan?.status === 'blocked' || plan?.status === 'cancelled') return { code: 'planBlocked', detail: plan.note || plan.title, permanent: plan.status === 'cancelled' }
  return undefined
}
