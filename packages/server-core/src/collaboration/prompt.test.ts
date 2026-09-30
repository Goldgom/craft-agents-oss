import { describe, expect, it } from 'bun:test'
import { buildCollaborationPrompt } from './prompt'

const membership = { groupId: 'collab_test', memberId: 'primary', coordinatorWorkspaceId: 'main', role: 'primary' as const }

describe('collaboration role prompts', () => {
  it('gives primaries a verified assignment/integration workflow and accurate delivery semantics', () => {
    const prompt = buildCollaborationPrompt(membership)
    for (const text of ['goal.current', 'target session ID', 'not the member ID', 'bounded, non-overlapping', 'integration checks', 'not completed or verified', 'not permission grants', 'different workspace']) {
      expect(prompt).toContain(text)
    }
    expect(prompt).toContain('ask for the goal before dispatching')
  })

  it('instructs secondaries to report to the primary rather than silently finish or delegate sideways', () => {
    const prompt = buildCollaborationPrompt({ ...membership, role: 'secondary', memberId: 'secondary_1' })
    expect(prompt).toContain('Only send_agent_message to the primary session')
    expect(prompt).toContain('final response in this chat is not a report')
    expect(prompt).toContain('await a new assignment')
    expect(prompt).not.toContain('You own coordination and the final answer')
  })
})


it('uses member routing and truthful desktop/offline semantics for a negotiated relay', () => {
  const prompt = buildCollaborationPrompt({ ...membership, relay: { protocolVersion: 1, epoch: 'epoch', serverId: 'server', coordinator: { serverId: 'server', workspaceId: 'main' }, ownerId: 'owner', phase: 'active', creationOperationId: 'creation' } })
  expect(prompt).toContain('targetMemberId')
  expect(prompt).toContain('never a bare sessionId')
  expect(prompt).toContain('Electron app must remain running')
  expect(prompt).toContain('queued-for-relay is not delivery or completion')
  expect(prompt).not.toContain('not the member ID')
})
