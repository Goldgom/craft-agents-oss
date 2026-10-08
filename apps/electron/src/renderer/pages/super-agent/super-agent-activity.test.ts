import { describe, expect, it } from 'bun:test'
import type { SuperAgentMessage, SuperAgentSnapshot, SuperAgentTask } from '@craft-agent/shared/super-agent'
import type { PermissionRequest } from '../../../shared/types'
import { conversationMessages, ordinaryPermissionHeads, recentActivityEntries, recentPermissionResolutions, taskActivity, tasklessWorkerActivities, visibleActivityEntries, visibleActivityText, type SuperAgentActivity, type SuperAgentApproval } from './super-agent-activity'

function workSnapshot(): SuperAgentSnapshot {
  const node = { name: 'Node', avatar: '', description: '', llmConnection: 'test', model: 'test', thinkingLevel: 'medium' as const, maxCallsPerMinute: 6, intelligenceRating: 3, workPreferences: '', sourceSlugs: [], abilityProfileIds: [] }
  return {
    config: { version: 1, name: 'Test team', avatar: '', idleInspectionMinutes: 15, nodes: [{ ...node, id: 'main', role: 'coordinator' }, { ...node, id: 'worker', role: 'worker' }], environment: { kind: 'folder', workingDirectory: 'C:\\test', permissionMode: 'allow-all', permissions: { readFiles: true, writeFiles: false, runPrograms: false, browser: false } }, sourceSlugs: [], abilityProfiles: [], scripts: [] },
    environment: { available: true, isolation: 'host-folder', detail: '' },
    state: { version: 1, revision: 1, lastUserActivityAt: 1, nodes: [{ nodeId: 'main', sessionId: 'session-main', status: 'working' }, { nodeId: 'worker', sessionId: 'session-worker', status: 'working' }], tasks: [], messages: [], board: [], plans: [], scripts: [] },
    activity: [],
  }
}

describe('Super Agent conversation activity', () => {
  it('shows interaction and necessary background replies while hiding legacy inspections and empty control replies', () => {
    const base: SuperAgentMessage = { id: 'user', fromNodeId: 'user', toNodeId: 'main', kind: 'chat', body: '需求', createdAt: 1 }
    const messages: SuperAgentMessage[] = [base,
      { ...base, id: 'internal', fromNodeId: 'main', body: 'Internal reasoning' },
      { ...base, id: 'inspection', fromNodeId: 'main', toNodeId: 'user', kind: 'inspection', body: '自检完成，无新增工作。' },
      { ...base, id: 'question', fromNodeId: 'main', toNodeId: 'user', kind: 'inspection', userFacing: true, body: '请提供目标版本。' },
      { ...base, id: 'empty', fromNodeId: 'main', toNodeId: 'user', body: '<super_agent_actions>{}</super_agent_actions>' },
      { ...base, id: 'error', fromNodeId: 'system', toNodeId: 'user', kind: 'error', body: 'Connection unavailable' },
    ]
    expect(conversationMessages(messages).map(message => message.id)).toEqual(['user', 'question', 'error'])
  })
  it('hides protocol blocks while retaining user-facing text around them', () => {
    expect(visibleActivityText('计划已更新。<super_agent_actions>{"tasks":[]}</super_agent_actions>\n请继续。')).toBe('计划已更新。\n请继续。')
    expect(visibleActivityText('已分配。<super_agent_actions>{"tasks":[')).toBe('已分配。')
    expect(visibleActivityText('<SUPER_AGENT_ACTIONS>{"tasks":[]}</SUPER_AGENT_ACTIONS>')).toBe('')
    for (let length = 1; length < '<super_agent_actions>'.length; length++) {
      expect(visibleActivityText('准备执行。' + '<super_agent_actions>'.slice(0, length))).toBe('准备执行。')
    }
    expect(visibleActivityText('a < b')).toBe('a < b')
  })

  it('replaces a completed streamed reply with its durable reply without hiding commentary or a new turn', () => {
    const activity: SuperAgentActivity = {
      nodeId: 'main', sessionId: 'session-main', status: 'working', startedAt: 10_000, updatedAt: 20_000,
      entries: [
        { id: 'thought', kind: 'thinking', text: '正在整理结果。', createdAt: 10_000, updatedAt: 11_000, status: 'completed' },
        { id: 'reply', kind: 'text', text: '已完成。', createdAt: 12_000, updatedAt: 19_000, status: 'completed' },
        { id: 'tool', kind: 'tool', text: '', toolName: 'node_status', createdAt: 13_000, updatedAt: 14_000, status: 'completed' },
        { id: 'control', kind: 'text', text: '<super_agent_actions>{', createdAt: 20_000, updatedAt: 20_000 },
      ],
    }
    const reply: SuperAgentMessage = { id: 'saved', fromNodeId: 'main', toNodeId: 'user', kind: 'chat', body: '已完成。', createdAt: 20_000 }
    expect(visibleActivityEntries(activity, [reply]).map(entry => entry.id)).toEqual(['thought', 'tool'])
    expect(visibleActivityEntries(activity, [{ ...reply, createdAt: 60_000 }]).map(entry => entry.id)).toEqual(['thought', 'tool'])
    expect(visibleActivityEntries(activity, [{ ...reply, createdAt: 9_000 }]).map(entry => entry.id)).toEqual(['thought', 'reply', 'tool'])
    activity.entries[1].status = 'running'
    expect(visibleActivityEntries(activity, [reply]).map(entry => entry.id)).toEqual(['thought', 'reply', 'tool'])
  })
})

describe('Super Agent permission inbox', () => {
  const request = (sessionId: string, requestId: string): PermissionRequest => ({ sessionId, requestId, toolName: 'Read', description: 'Read a document.' })
  const tracked: SuperAgentApproval = {
    id: 'tracked', nodeId: 'worker', coordinatorId: 'main', sessionId: 'owned', toolName: 'Read', description: 'Read a document.',
    status: 'pending', createdAt: 1,
  }

  it('shows only the queue head from sessions belonging to the team', () => {
    const pending = new Map([
      ['owned', [request('owned', 'first'), request('owned', 'second')]],
      ['other', [request('other', 'foreign')]],
      ['empty', []],
    ])
    expect(ordinaryPermissionHeads(new Set(['owned', 'empty']), pending, []).map(item => item.requestId)).toEqual(['first'])
  })

  it('does not redisplay inbox requests that are pending or already resolved', () => {
    const pending = new Map([['owned', [request('owned', 'tracked'), request('owned', 'next')]]])
    for (const status of ['pending', 'approved', 'denied', 'expired'] as const) {
      expect(ordinaryPermissionHeads(new Set(['owned']), pending, [{ ...tracked, status }])).toEqual([])
    }
    expect(ordinaryPermissionHeads(new Set(['owned']), pending, [{ ...tracked, sessionId: 'other' }]).map(item => item.requestId)).toEqual(['tracked'])
  })

  it('keeps a bounded, most-recent history of completed decisions', () => {
    const inbox: SuperAgentApproval[] = [
      { ...tracked, id: 'old', status: 'approved', resolvedAt: 10 },
      { ...tracked, id: 'pending', createdAt: 1_000 },
      { ...tracked, id: 'latest', status: 'denied', resolvedAt: 30 },
      { ...tracked, id: 'expired', status: 'expired', resolvedAt: 20 },
    ]
    expect(recentPermissionResolutions(inbox, 2).map(item => item.id)).toEqual(['latest', 'expired'])
    expect(inbox.map(item => item.id)).toEqual(['old', 'pending', 'latest', 'expired'])
  })
})

describe('Super Agent worker progress', () => {
  const worker: SuperAgentActivity = { nodeId: 'worker', sessionId: 'session-worker', taskId: 'current', status: 'waiting_permission', startedAt: 10, updatedAt: 20, entries: [] }
  const task: SuperAgentTask = { id: 'current', nodeId: 'worker', sessionId: 'session-worker', title: 'Work', instructions: 'Read a file.', status: 'running', createdAt: 1 }

  it('attaches live output only to the actual running task and its retained session', () => {
    const snapshot = workSnapshot()
    snapshot.activity = [worker]
    expect(taskActivity(snapshot, task)).toBe(worker)
    expect(taskActivity(snapshot, { ...task, id: 'old' })).toBeUndefined()
    expect(taskActivity(snapshot, { ...task, sessionId: 'session-old' })).toBeUndefined()
    expect(taskActivity(snapshot, { ...task, status: 'completed' })).toBeUndefined()
    expect(taskActivity(snapshot, { ...task, status: 'queued' })).toBeUndefined()
  })

  it('shows active taskless workers without duplicating assigned tasks or the coordinator', () => {
    const snapshot = workSnapshot()
    const taskless = { ...worker, taskId: undefined, status: 'working' as const }
    snapshot.activity = [worker, taskless, { ...taskless, nodeId: 'main', sessionId: 'session-main' }, { ...taskless, sessionId: 'session-old' }]
    expect(tasklessWorkerActivities(snapshot)).toEqual([taskless])
    snapshot.state.nodes[1].status = 'recovering'
    expect(tasklessWorkerActivities(snapshot)).toEqual([taskless])
    snapshot.state.nodes[1].status = 'idle'
    expect(tasklessWorkerActivities(snapshot)).toEqual([])
  })

  it('bounds worker disclosures by recent updates, retaining recent tool results and hiding protocol text', () => {
    const activity: SuperAgentActivity = { ...worker, entries: [
      { id: 'old', kind: 'thinking', text: 'An earlier summary.', createdAt: 10, updatedAt: 10 },
      { id: 'tool', kind: 'tool', toolName: 'Read', text: 'Latest result.', createdAt: 20, updatedAt: 80, status: 'completed' },
      { id: 'text', kind: 'text', text: 'Working on the output.', createdAt: 30, updatedAt: 60, status: 'running' },
      { id: 'status', kind: 'status', text: 'Waiting for approval.', createdAt: 40, updatedAt: 70 },
      { id: 'control', kind: 'text', text: '<super_agent_actions>{', createdAt: 50, updatedAt: 90 },
    ] }
    expect(recentActivityEntries(activity, 3).map(entry => entry.id)).toEqual(['tool', 'text', 'status'])
    expect(activity.entries.map(entry => entry.id)).toEqual(['old', 'tool', 'text', 'status', 'control'])
  })
})
