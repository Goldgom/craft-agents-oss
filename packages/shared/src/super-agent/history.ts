import type { Session } from '../protocol/dto'
import type { SuperAgentScriptRuntime, SuperAgentState } from './types'

function scriptNeedsReview(script: SuperAgentScriptRuntime): boolean {
  return ['running', 'untracked'].includes(script.status) || script.resultPending === true || script.resultQueuedAt != null
    || (!!script.runId && script.resultReportedAt == null && script.resultDeliveryPaused === true)
}

/** Keep the assignment and evidence until execution and result review are settled. */
function protectedHistoryEvidence(state: SuperAgentState) {
  const plans = new Set(state.plans.filter(plan => !['completed', 'cancelled'].includes(plan.status)).map(plan => plan.id))
  const tasks = new Set<string>()
  const scripts = new Set<string>()
  const taskById = new Map(state.tasks.map(task => [task.id, task]))

  for (const script of state.scripts) {
    if (!scriptNeedsReview(script)) continue
    if (script.taskId) tasks.add(script.taskId)
    if (script.planId) plans.add(script.planId)
    const taskPlanId = script.taskId ? taskById.get(script.taskId)?.planId : undefined
    if (taskPlanId) plans.add(taskPlanId)
  }
  for (const script of state.scripts) {
    const taskPlanId = script.taskId ? taskById.get(script.taskId)?.planId : undefined
    if (!scriptNeedsReview(script) && !(script.planId && plans.has(script.planId)) && !(taskPlanId && plans.has(taskPlanId))) continue
    scripts.add(script.scriptId)
    if (script.taskId) tasks.add(script.taskId)
  }
  for (const task of state.tasks) if (['queued', 'running'].includes(task.status) || (task.planId && plans.has(task.planId))) tasks.add(task.id)
  retainTaskReferences(taskById, tasks)
  return { plans, tasks, scripts }
}

function retainTaskReferences(taskById: Map<string, SuperAgentState['tasks'][number]>, retained: Set<string>): void {
  const queue = [...retained]
  for (let index = 0; index < queue.length; index++) {
    const task = taskById.get(queue[index]!)
    for (const id of [...(task?.dependsOn ?? []), ...(task?.acceptance ? [task.acceptance.evidenceTaskId] : [])]) {
      if (retained.has(id)) continue
      retained.add(id); queue.push(id)
    }
  }
}

export function planSuperAgentHistoryCleanup(state: SuperAgentState, before: number, keepRecentMessages: number) {
  const protectedEvidence = protectedHistoryEvidence(state)
  const candidates = state.tasks.filter(task => !['queued', 'running'].includes(task.status)
    && !protectedEvidence.tasks.has(task.id)
    && (!task.planId || !protectedEvidence.plans.has(task.planId)) && (task.completedAt ?? task.createdAt) < before)
  const candidateIds = new Set(candidates.map(task => task.id))
  const referenced = new Set(state.tasks.filter(task => !candidateIds.has(task.id)).map(task => task.id))
  retainTaskReferences(new Map(state.tasks.map(task => [task.id, task])), referenced)
  const tasks = candidates.filter(task => !referenced.has(task.id))
  const removedTasks = new Set(tasks.map(task => task.id))
  const retainedTasks = state.tasks.filter(task => !removedTasks.has(task.id))
  const retainedTaskIds = new Set(retainedTasks.map(task => task.id))
  const recent = new Set((keepRecentMessages ? state.messages.slice(-keepRecentMessages) : []).map(message => message.id))
  const messages = state.messages.filter(message => message.createdAt < before && !recent.has(message.id)
    && !(message.taskId && retainedTaskIds.has(message.taskId))
    && !(message.permission?.status === 'pending')
    && !(protectedEvidence.plans.size && message.fromNodeId === 'user'))
  const removedMessages = new Set(messages.map(message => message.id))
  const plans = state.plans.filter(plan => ['completed', 'cancelled'].includes(plan.status) && plan.updatedAt < before
    && !protectedEvidence.plans.has(plan.id) && !retainedTasks.some(task => task.planId === plan.id))
  const removedPlans = new Set(plans.map(plan => plan.id))
  const scriptLogs = state.scripts.filter(script => ['completed', 'failed', 'stopped'].includes(script.status)
    && !protectedEvidence.scripts.has(script.scriptId) && (script.completedAt ?? Infinity) < before && (script.output || script.error))
  const clearedScripts = new Set(scriptLogs.map(script => script.scriptId))
  return {
    removed: { tasks, messages, plans, scriptLogs },
    state: { ...state, tasks: retainedTasks, messages: state.messages.filter(message => !removedMessages.has(message.id)),
      plans: state.plans.filter(plan => !removedPlans.has(plan.id)),
      scripts: state.scripts.map(script => clearedScripts.has(script.scriptId) ? { ...script, output: undefined, error: undefined } : script) },
  }
}

export function protectedHistorySessionIds(state: SuperAgentState): Set<string> {
  const protectedEvidence = protectedHistoryEvidence(state)
  return new Set([
    ...state.nodes.flatMap(node => node.sessionId ? [node.sessionId] : []),
    ...state.tasks.flatMap(task => task.sessionId && (['queued', 'running'].includes(task.status)
      || protectedEvidence.tasks.has(task.id) || (task.planId && protectedEvidence.plans.has(task.planId))) ? [task.sessionId] : []),
  ])
}

export function historySessionEligible(session: Session, workspaceId: string, before: number, protectedIds: Set<string>): boolean {
  return session.workspaceId === workspaceId && session.lastMessageAt < before && !protectedIds.has(session.id)
    && !session.isProcessing && !session.isAsyncOperationOngoing && !session.isFlagged
    && !session.taskSlug && !session.taskRunId && !session.parentSessionId && !session.collaboration
    && (session.isArchived === true || ['done', 'cancelled'].includes(session.sessionStatus ?? ''))
}
