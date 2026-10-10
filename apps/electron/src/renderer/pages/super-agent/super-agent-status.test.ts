import { describe, expect, it } from 'bun:test'
import type { SuperAgentActivityEntry, SuperAgentNodeActivity, SuperAgentSnapshot } from '@craft-agent/shared/super-agent'
import { nodeWorkStatus, teamWorkStatus } from './super-agent-status'

function snapshot(): SuperAgentSnapshot {
  const node = { name: 'Node', avatar: '', description: '', llmConnection: 'test', model: 'test', thinkingLevel: 'medium' as const, maxCallsPerMinute: 6, intelligenceRating: 3, workPreferences: '', sourceSlugs: [], abilityProfileIds: [] }
  return {
    config: { version: 1, name: 'Team', avatar: '', idleInspectionMinutes: 15, continuousWork: true,
      nodes: [{ ...node, id: 'main', role: 'coordinator' }, { ...node, id: 'worker', role: 'worker' }],
      environment: { kind: 'folder', workingDirectory: 'C:\\test', permissionMode: 'allow-all', permissions: { readFiles: true, writeFiles: false, runPrograms: false, browser: false } },
      sourceSlugs: [], abilityProfiles: [], scripts: [] },
    environment: { available: true, isolation: 'host-folder', detail: '' },
    state: { version: 1, revision: 1, lastUserActivityAt: 1,
      nodes: [{ nodeId: 'main', sessionId: 'session-main', status: 'idle' }, { nodeId: 'worker', sessionId: 'session-worker', status: 'idle', lastStartedAt: 10 }],
      tasks: [], messages: [], board: [], plans: [], scripts: [] },
    activity: [],
  }
}
function activity(entries: SuperAgentActivityEntry[] = []): SuperAgentNodeActivity {
  return { nodeId: 'worker', sessionId: 'session-worker', startedAt: 10, updatedAt: 20, status: 'working', entries }
}
const thinking: SuperAgentActivityEntry = { id: 'thought', kind: 'thinking', status: 'running', text: 'Reasoning', createdAt: 10, updatedAt: 20 }
const tool: SuperAgentActivityEntry = { ...thinking, id: 'tool', kind: 'tool', toolName: 'Read' }

describe('Super Agent current work status', () => {
  it('explains impossible dependency queues as blocked and preserves runnable queue status', () => {
    const current = snapshot()
    current.state.tasks = [
      { id: 'source', title: 'Source', instructions: '', nodeId: 'worker', status: 'cancelled', createdAt: 1 },
      { id: 'next', title: 'Next', instructions: '', nodeId: 'worker', status: 'queued', dependsOn: ['source'], createdAt: 1 },
    ]
    expect(nodeWorkStatus(current, 'worker')).toBe('blocked')
    expect(teamWorkStatus(current).status).toBe('blocked')
    current.state.tasks[1]!.dependsOn = []
    expect(teamWorkStatus(current).status).toBe('queued')
  })

  it('keeps blocked plans visible even after obsolete tasks leave the queue', () => {
    const current = snapshot()
    current.state.plans = [{ id: 'plan', title: 'Research', instructions: '', status: 'blocked', priority: 1, note: 'Need official source', revision: 1, updatedBy: 'main', updatedAt: 1 }]
    expect(teamWorkStatus(current).status).toBe('blocked')
    current.state.nodes[1]!.status = 'working'
    expect(teamWorkStatus(current).status).toBe('working')
  })
  it('stays idle during continuous work when nothing is actually running', () => {
    const current = snapshot()
    current.activity = [activity([thinking, tool])]
    current.state.tasks.push({ id: 'done', title: 'Done', instructions: '', nodeId: 'worker', status: 'completed', createdAt: 1 })
    expect(teamWorkStatus(current).status).toBe('idle')
  })

  it('tracks thinking, tool execution, replies and completion across a turn', () => {
    const current = snapshot()
    current.state.nodes[1].status = 'working'
    expect(teamWorkStatus(current).status).toBe('working')
    current.activity = [activity([thinking])]
    expect(teamWorkStatus(current).status).toBe('thinking')
    current.activity[0].entries.push(tool)
    expect(teamWorkStatus(current).status).toBe('working')
    current.activity[0].entries[1] = { ...tool, status: 'completed' }
    current.activity[0].entries.push({ ...thinking, id: 'reply', kind: 'text', updatedAt: 30 })
    expect(teamWorkStatus(current).status).toBe('working')
    current.state.nodes[1].status = 'idle'
    expect(teamWorkStatus(current).status).toBe('idle')
  })

  it('ignores thinking from old sessions, old turns and completed output', () => {
    const current = snapshot()
    current.state.nodes[1].status = 'working'
    for (const stale of [
      { ...activity([thinking]), sessionId: 'old-session' },
      { ...activity([thinking]), startedAt: 5 },
      activity([{ ...thinking, status: 'completed' }]),
    ]) {
      current.activity = [stale]
      expect(teamWorkStatus(current).status).toBe('working')
    }
  })

  it('shows permission waits and resumes execution after the request is resolved', () => {
    const current = snapshot()
    current.state.nodes[1].status = 'working'
    current.activity = [activity([tool])]
    current.permissionRequests = [{ id: 'approval', nodeId: 'worker', coordinatorId: 'main', sessionId: 'session-worker', toolName: 'Read', description: '', status: 'pending', createdAt: 10 }]
    expect(teamWorkStatus(current).status).toBe('waiting_permission')
    current.permissionRequests[0].status = 'approved'
    expect(teamWorkStatus(current).status).toBe('working')
    const pending = new Map([['session-worker', [{ sessionId: 'session-worker', requestId: 'ordinary', toolName: 'Read', description: '' }]]])
    expect(teamWorkStatus(current, pending).status).toBe('waiting_permission')
    expect(teamWorkStatus(current, new Map([['other-session', pending.get('session-worker')!]])).status).toBe('working')
  })

  it('keeps concurrent execution visible while another node waits for permission', () => {
    const current = snapshot()
    current.state.nodes[0].status = 'working'
    current.state.nodes[1].status = 'working'
    current.activity = [{ ...activity(), status: 'waiting_permission' }]
    expect(teamWorkStatus(current)).toMatchObject({ status: 'working', nodes: [{ nodeId: 'main', status: 'working' }, { nodeId: 'worker', status: 'waiting_permission' }] })
  })

  it('shows preparation, automatic recovery, errors and unavailable environments', () => {
    const current = snapshot()
    for (const status of ['preparing', 'recovering', 'error'] as const) {
      current.state.nodes[1].status = status
      expect(teamWorkStatus(current).status).toBe(status)
    }
    current.state.nodes[1].status = 'working'
    for (const status of ['recovering', 'error'] as const) {
      current.activity = [{ ...activity(), status }]
      expect(teamWorkStatus(current).status).toBe(status)
    }
    current.environment.available = false
    expect(teamWorkStatus(current).status).toBe('unavailable')
  })

  it('distinguishes queued work from work waiting on a condition', () => {
    const current = snapshot()
    current.state.tasks = [{ id: 'queued', title: 'Work', instructions: '', nodeId: 'worker', status: 'queued', createdAt: 1 }]
    expect(teamWorkStatus(current).status).toBe('queued')
    current.state.tasks[0].phase = 'waiting'
    expect(teamWorkStatus(current).status).toBe('waiting')
    current.state.tasks[0].status = 'running'
    expect(teamWorkStatus(current).status).toBe('waiting')
    current.state.tasks[0].phase = 'executing'
    expect(teamWorkStatus(current).status).toBe('working')
  })

  it('counts scripts that keep running after the node turn finishes', () => {
    const current = snapshot()
    current.config!.scripts = [{ id: 'script', name: 'Script', path: 'test.py', args: [], nodeId: 'worker', timeoutSeconds: 60 }]
    current.state.scripts = [{ scriptId: 'script', status: 'running' }]
    expect(nodeWorkStatus(current, 'worker')).toBe('working')
    expect(teamWorkStatus(current).status).toBe('working')
    current.state.scripts[0].status = 'completed'
    expect(teamWorkStatus(current).status).toBe('idle')
  })
})
