import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { emptySuperAgentState, type SuperAgentPlanItem, type SuperAgentTask } from '@tokenbird/shared/super-agent'
import { superAgentBlockingReports, superAgentPlanNeedsUserAction, superAgentTaskNeedsUserAction } from './super-agent-blockers'
import { SuperAgentBlockingCard } from './SuperAgentBlockingCard'
import type { SuperAgentText } from './super-agent-ui'
import zh from '@tokenbird/shared/i18n/locales/zh-Hans.json'

const text: SuperAgentText = (key, values) => {
  let value = (zh as Record<string, string>)[`superAgent.${key}`] ?? key
  for (const [name, item] of Object.entries(values ?? {})) value = value.replaceAll(`{{${name}}}`, String(item))
  return value
}
const plan: SuperAgentPlanItem = { id: 'plan', title: '投资研究', instructions: 'Research', status: 'blocked', priority: 1,
  note: 'Unsettled operation outcomes must be verified before acceptance; SHA256 abcdef', revision: 1, updatedBy: 'main', updatedAt: 1 }
const task: SuperAgentTask = { id: 'original', nodeId: 'worker', planId: 'plan', title: 'Research', instructions: '', status: 'completed', createdAt: 1 }
function render(report: ReturnType<typeof superAgentBlockingReports>[number], processing = false) {
  return renderToStaticMarkup(<SuperAgentBlockingCard report={report} text={text} processing={processing} disabled={false} onProvideInput={() => {}} />)
}

test('automatic verification stays internal and does not render a user blocker', () => {
  const state = emptySuperAgentState(1)
  state.plans = [plan]; state.tasks = [{ ...task, status: 'queued' }]
  state.operations = [{ id: 'op_unknown', key: 'a'.repeat(64), taskId: task.id, turnId: 'turn', nodeId: 'worker',
    sessionId: 'session', invocationId: 'call', toolName: 'Bash', status: 'unknown', createdAt: 1, updatedAt: 1 }]
  const report = superAgentBlockingReports(state)[0]!
  expect(report).toMatchObject({ kind: 'verification', requiresUserAction: false })
  expect(report.operations[0]!.id).toBe('op_unknown')
  expect(render(report)).toBe('')
  expect(render(report, true)).toBe('')
  expect(superAgentTaskNeedsUserAction(state, state.tasks[0]!)).toBe(false)
})

test('specific user information is explicit and uses a reply action instead of verification', () => {
  const state = emptySuperAgentState(1)
  state.plans = [{ ...plan, blocker: { kind: 'user', summary: '还没有确定目标市场', userAction: '请选择中国市场或美国市场，并提供分析周期。', systemAction: '收到后继续数据研究。' } }]
  const html = render(superAgentBlockingReports(state)[0]!)
  expect(html).toContain('需要你补充信息')
  expect(html).toContain('请选择中国市场或美国市场，并提供分析周期。')
  expect(html).toContain('补充信息</button>')
  expect(html).not.toContain('暂不需要你补充')
})

test('legacy reports do not invent a missing user requirement or claim completed acceptance', () => {
  const state = emptySuperAgentState(1)
  state.plans = [plan]; state.tasks = [{ ...task, status: 'queued' }]
  const reports = superAgentBlockingReports(state)
  expect(reports).toHaveLength(1)
  expect(reports[0]!.kind).toBe('unspecified')
  expect(render(reports[0]!)).toBe('')
  expect(render(reports[0]!)).not.toContain('需要你补充信息')
})

test('upstream operations are included while unrelated and reconciled operations stay out', () => {
  const state = emptySuperAgentState(1)
  state.tasks = [{ ...task, acceptanceCriteria: ['Verified result'] }, { ...task, id: 'next', status: 'queued', planId: undefined, dependsOn: [task.id] }]
  const base = { key: 'a'.repeat(64), turnId: 'turn', nodeId: 'worker', sessionId: 'session', invocationId: 'call', toolName: 'Bash', createdAt: 1, updatedAt: 1 }
  state.operations = [{ ...base, id: 'op_relevant', taskId: task.id, status: 'unknown' }, { ...base, id: 'op_other', taskId: 'other', status: 'unknown' }, { ...base, id: 'op_settled', taskId: task.id, status: 'reconciled' }]
  const reports = superAgentBlockingReports(state)
  expect(reports).toHaveLength(1)
  expect(reports[0]!.kind).toBe('verification')
  expect(reports[0]!.operations.map(operation => operation.id)).toEqual(['op_relevant'])
})
test('only explicit actionable user requests count as blocked, including pending dependencies', () => {
  const state = emptySuperAgentState(1)
  state.plans = [{ ...plan, blocker: { kind: 'user', summary: '请选择市场', userAction: '请选择中国或美国市场。' } }]
  const upstream: SuperAgentTask = { ...task, status: 'queued' }
  const downstream = { ...task, id: 'next', planId: undefined, status: 'queued' as const, dependsOn: [task.id] }
  state.tasks = [upstream, downstream]
  expect(superAgentPlanNeedsUserAction(state.plans[0])).toBe(true)
  expect(superAgentTaskNeedsUserAction(state, downstream)).toBe(true)
  upstream.status = 'completed'
  expect(superAgentTaskNeedsUserAction(state, downstream)).toBe(false)
  state.plans[0]!.blocker = { kind: 'system', summary: '核验结果', systemAction: '自动核验后继续' }
  expect(superAgentPlanNeedsUserAction(state.plans[0])).toBe(false)
  state.plans[0]!.blocker = { kind: 'user', summary: '原因不明确', userAction: ' ' }
  expect(superAgentPlanNeedsUserAction(state.plans[0])).toBe(false)
  expect(render(superAgentBlockingReports(state)[0]!)).toBe('')
})
