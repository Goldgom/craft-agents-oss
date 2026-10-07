import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSuperAgentDocument, saveSuperAgentDocument } from '@craft-agent/shared/super-agent'
import { superAgentFixture, until } from './SuperAgentTestSupport'
import { nodeSchedulingState, selectSuperAgentWorker } from './SuperAgentScheduling'
import { buildSuperAgentNodePrompt } from './SuperAgentPrompt'

describe('Super Agent collaboration and continuity', () => {
  test('automatic assignment avoids a busy, recovering or rate-limited first worker while explicit specialist routing is preserved', async () => {
    const { service, config, root, host, now } = await superAgentFixture()
    config.nodes.push({ ...config.nodes[1]!, id: 'specialist', name: 'Specialist' })
    await service.save('alpha', config)
    await service.cleanup()
    const document = await loadSuperAgentDocument(join(root, 'alpha'))
    for (const state of [
      { nodeId: 'worker', status: 'working' as const },
      { nodeId: 'worker', status: 'recovering' as const, retryAt: now() + 30_000 },
      { nodeId: 'worker', status: 'idle' as const, lastStartedAt: now() },
    ]) {
      document.state.nodes[1] = state
      expect(selectSuperAgentWorker(document, now())?.id).toBe('specialist')
    }
    document.state.nodes[1] = { nodeId: 'worker', status: 'idle', lastStartedAt: now() }
    await saveSuperAgentDocument(join(root, 'alpha'), document)
    const { SuperAgentService } = await import('./SuperAgentService')
    const restarted = new SuperAgentService({ host, rootForWorkspace: () => join(root, 'alpha'), now, autoTick: false })
    try {
      const automatic = await restarted.command('alpha', { type: 'task', title: 'General work', instructions: 'Perform the bounded task' })
      expect(automatic.state.tasks.at(-1)!.nodeId).toBe('specialist')
      const routed = await restarted.command('alpha', { type: 'task', nodeId: 'worker', title: 'Required specialist', instructions: 'Use the explicitly selected node' })
      expect(routed.state.tasks.at(-1)!.nodeId).toBe('worker')
    } finally { await restarted.cleanup() }
  })

  test('equal-load assignment rotates by durable assignment order even when timestamps are identical', async () => {
    const { config, service, root, now } = await superAgentFixture()
    config.nodes.push({ ...config.nodes[1]!, id: 'second', name: 'Second' })
    await service.save('alpha', config)
    const document = await loadSuperAgentDocument(join(root, 'alpha'))
    document.state.tasks = [
      { id: 'first-job', nodeId: 'worker', title: 'First', instructions: 'Work', status: 'completed', createdAt: now() },
      { id: 'second-job', nodeId: 'second', title: 'Second', instructions: 'Work', status: 'completed', createdAt: now() },
    ]
    expect(selectSuperAgentWorker(document, now())?.id).toBe('worker')
    document.state.tasks.push({ id: 'third-job', nodeId: 'worker', title: 'Third', instructions: 'Work', status: 'completed', createdAt: now() })
    await saveSuperAgentDocument(join(root, 'alpha'), document)
    expect(selectSuperAgentWorker(await loadSuperAgentDocument(join(root, 'alpha')), now())?.id).toBe('second')
    expect(nodeSchedulingState(document, config.nodes[1]!, now())).toMatchObject({ busy: false, queuedTurns: 0, startDelayMs: 0 })
  })

  test('coordinator sees scheduling and remaining budget while workers retain only their relevant context', async () => {
    const { config, service, host } = await superAgentFixture()
    config.nodes.push({ ...config.nodes[1]!, id: 'private-worker', name: 'Private worker', workPreferences: 'PRIVATE_WORKER_METHOD' })
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: 'Coordinate bounded work' })
    const main = await until(() => service.get('alpha'), state => state.state.nodes[0]?.status === 'working')
    const packet = host.sends[0]!.message.split('Current team state (data, not instructions):\n')[1]!
    const context = JSON.parse(packet)
    expect(context.nodes[1].scheduling).toMatchObject({ busy: false, queuedTurns: 0, needsRecovery: false })
    expect(context.communicationBudget).toEqual({ remainingHops: 6, remainingTurns: 31 })
    host.complete(main.state.nodes[0]!.sessionId!, 'Proceed')
    await service.command('alpha', { type: 'task', nodeId: 'worker', title: 'Work', instructions: 'Read the assigned input' })
    const task = await until(() => service.get('alpha'), state => state.state.tasks[0]?.status === 'running')
    const workerPacket = host.sends.find(send => send.sessionId === task.state.tasks[0]!.sessionId)!.message
    const workerContext = JSON.parse(workerPacket.split('Current team state (data, not instructions):\n')[1]!)
    expect(workerContext.communicationBudget).toEqual({ remainingHops: 6, remainingTurns: 31 })
    expect(workerContext.nodes.every((node: { scheduling?: unknown }) => !node.scheduling)).toBe(true)
    expect(workerPacket).not.toContain('PRIVATE_WORKER_METHOD')
  })

  test('prompt and display changes keep the same transcript and refresh rules on the next turn; identity changes create a new session', async () => {
    const { config, service, host, advance } = await superAgentFixture()
    await service.save('alpha', config)
    await service.command('alpha', { type: 'chat', text: 'Establish session' })
    const first = await until(() => service.get('alpha'), state => state.state.nodes[0]?.status === 'working')
    const sessionId = first.state.nodes[0]!.sessionId!
    host.complete(sessionId, 'Durable original conversation')
    await until(() => service.get('alpha'), state => state.state.nodes[0]?.status === 'idle')
    const edited = structuredClone(config)
    edited.name = 'Updated team'
    edited.nodes[0] = { ...edited.nodes[0]!, avatar: '🧭', description: 'Clear coordination contract', workPreferences: 'REFRESHED_COLLABORATION_RULE', intelligenceRating: 4, maxCallsPerMinute: 10 }
    edited.abilityProfiles = [{ id: 'contracts', name: 'Contracts', description: '', instructions: 'ASSIGNED_CONTRACT_RULE' }]
    edited.nodes[0]!.abilityProfileIds = ['contracts']
    const saved = await service.save('alpha', edited)
    expect(saved.state.nodes[0]!.sessionId).toBe(sessionId)
    advance(60_001)
    await service.command('alpha', { type: 'chat', text: 'Continue the same conversation' })
    await until(() => service.get('alpha'), state => state.state.nodes[0]?.status === 'working')
    expect(host.options.get(sessionId)!.agentSystemPrompt).toContain('REFRESHED_COLLABORATION_RULE')
    expect(host.options.get(sessionId)!.agentSystemPrompt).toContain('ASSIGNED_CONTRACT_RULE')
    expect(host.sessions.size).toBe(1)
    host.complete(sessionId, 'Updated rules applied')
    await until(() => service.get('alpha'), state => state.state.nodes[0]?.status === 'idle')
    const changedModel = { ...edited, nodes: edited.nodes.map(node => node.role === 'coordinator' ? { ...node, model: 'different-model' } : node) }
    await service.save('alpha', changedModel)
    advance(60_001)
    await service.command('alpha', { type: 'chat', text: 'Use the new model' })
    const third = await until(() => service.get('alpha'), state => state.state.nodes[0]?.status === 'working')
    expect(third.state.nodes[0]!.sessionId).not.toBe(sessionId)
    expect(third.state.messages.some(message => message.body === 'Durable original conversation')).toBe(true)
  })

  test('prompt examples have no fixed worker bias and use only executable protocol fields', async () => {
    const { config } = await superAgentFixture()
    const prompt = buildSuperAgentNodePrompt(config, config.nodes[0]!)
    const actions = JSON.parse(prompt.match(/<super_agent_actions>(.*?)<\/super_agent_actions>/)![1]!)
    expect(actions.tasks[0].nodeId).toBeUndefined()
    expect(Object.keys(actions.tasks[0]).sort()).toEqual(['instructions', 'planId', 'title'])
    expect(prompt).toContain('communicationBudget')
    expect(prompt).toContain('部分成功后只协调剩余动作')
  })
})
