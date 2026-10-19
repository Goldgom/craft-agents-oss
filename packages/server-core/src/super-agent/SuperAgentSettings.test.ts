import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSuperAgentDocument } from '@tokenbird/shared/super-agent'
import { SESSION_TOOL_REGISTRY, type SessionToolContext } from '@tokenbird/session-tools-core'
import { filterSuperAgentTools } from '@tokenbird/shared/agent/core/browser-tool-policy'
import { superAgentFixture, until } from './SuperAgentTestSupport'

async function configured(credentialAccess?: boolean) {
  const f = await superAgentFixture()
  if (credentialAccess !== undefined) f.config.environment.credentialAccess = credentialAccess
  await f.service.save('alpha', f.config)
  const read = () => f.service.accessSettings('alpha', { action: 'get' }) as Promise<{ config: typeof f.config; revision: string; pending: boolean }>
  return { ...f, read }
}
async function interaction(credentialAccess?: boolean) {
  const f = await configured(credentialAccess)
  await f.service.command('alpha', { type: 'chat', text: 'Change my team settings' })
  const snapshot = await until(() => f.service.get('alpha'), s => s.state.nodes[0]?.status === 'working')
  return { ...f, sessionId: snapshot.state.nodes[0]!.sessionId! }
}

describe('AI Super Agent settings', () => {
  for (const credentialAccess of [undefined, false, true]) {
    for (const kind of ['chat', 'task'] as const) {
      test(`${kind} reconciles legacy and explicit credential access ${credentialAccess}`, async () => {
        const f = await configured(credentialAccess)
        if (kind === 'chat') await f.service.command('alpha', { type: 'chat', text: 'Can you use saved accounts?' })
        else await f.service.command('alpha', { type: 'task', nodeId: 'worker', title: 'List accounts', instructions: 'Check available accounts' })
        await until(() => f.service.get('alpha'), () => f.host.sends.length === 1)
        const sessionId = f.host.sends[0]!.sessionId
        expect(f.host.policies.get(sessionId)?.credentialAccess).toBe(credentialAccess !== false)
        expect(f.host.sends[0]!.context).toContain(`"credentialAccess":${credentialAccess !== false}`)
      })
    }
  }

  test('all node roles can discover the credential metadata tool', () => {
    for (const role of ['worker', 'coordinator', 'orchestrator'] as const) {
      const tools = filterSuperAgentTools([{ name: 'mcp__session__saved_credentials' }], role)
      expect(tools.map(tool => tool.name)).toEqual(['mcp__session__saved_credentials'])
    }
  })

  test('persists user vault grants and passes them to worker sessions', async () => {
    const f = await configured();
    f.config.environment.credentialAccess = true;
    await f.service.save('alpha', f.config);
    expect((await loadSuperAgentDocument(join(f.root, 'alpha'))).config!.environment.credentialAccess).toBe(true);
    await f.service.command('alpha', { type: 'task', nodeId: 'worker', title: 'Use saved account', instructions: 'List saved accounts' });
    await until(() => f.service.get('alpha'), () => f.host.sends.length > 0);
    const sessionId = f.host.sends[0]!.sessionId;
    expect(f.host.policies.get(sessionId)?.credentialAccess).toBe(true);
    expect(f.host.sends[0]!.context).toContain('"credentialAccess":true');
  });

  test('does not let a node grant itself credential vault access through settings', async () => {
    const f = await interaction(false); const before = await f.read();
    await expect(f.service.accessSettings('alpha', { action: 'update', expectedRevision: before.revision,
      changes: { environment: { ...before.config.environment, credentialAccess: true } } }, f.sessionId)).rejects.toThrow('changed by the user');
    expect((await f.read()).config.environment.credentialAccess).not.toBe(true);
  });
  test('reads complete config and edits every mutable top-level setting without dropping unrelated data', async () => {
    const f = await configured()
    const before = await f.read()
    const changes: typeof before.config = { ...before.config, name: 'Edited team', avatar: 'B', idleInspectionMinutes: 8,
      continuousWork: true, workflow: { pattern: 'research', maxParallelTasks: 2, independentReview: false },
      execution: { connectionConcurrency: 2, connectionCallsPerMinute: 10, stallMinutes: 5, maxResumeAttempts: 3 },
      requirements: { programs: ['python3'], browser: true }, sourceSlugs: ['source'],
      abilityProfiles: [{ id: 'research', name: 'Research', description: 'Scope', instructions: 'Check sources' }],
      scripts: [{ id: 'script', name: 'Script', path: 'test.py', args: ['a'], timeoutSeconds: 30 }],
      environment: { ...before.config.environment, safety: { autoReview: false, customRules: [] } },
      nodes: before.config.nodes.map(n => ({ ...n, model: 'new-model', thinkingLevel: 'high', skillSlugs: ['skill'], sourceSlugs: ['source'], abilityProfileIds: ['research'] })) }
    const { version, ...mutable } = changes
    const result = await f.service.accessSettings('alpha', { action: 'update', expectedRevision: before.revision, changes: mutable }) as { status: string }
    expect(result.status).toBe('saved')
    const after = await f.read()
    expect(after.config).toEqual(changes)
    expect(after.revision).not.toBe(before.revision)
    expect((await loadSuperAgentDocument(join(f.root, 'alpha'))).config).toEqual(changes)
    await f.service.accessSettings('alpha', { action: 'update', expectedRevision: after.revision, changes: { name: 'Partial' } })
    expect((await f.read()).config.nodes).toEqual(changes.nodes)
  })

  test('rejects stale, malformed and unknown fields atomically', async () => {
    const f = await configured()
    const before = await f.read()
    for (const changes of [{ version: 2 }, { unknown: true }, { nodes: [] }, { idleInspectionMinutes: 0 }, {}]) {
      await expect(f.service.accessSettings('alpha', { action: 'update', expectedRevision: before.revision, changes })).rejects.toThrow()
      expect(await f.read()).toEqual(before)
    }
    await f.service.accessSettings('alpha', { action: 'update', expectedRevision: before.revision, changes: { name: 'New' } })
    await expect(f.service.accessSettings('alpha', { action: 'update', expectedRevision: before.revision, changes: { avatar: 'X' } })).rejects.toThrow('changed')
    expect((await f.read()).config.avatar).toBe(before.config.avatar)
    await expect(f.service.accessSettings('alpha', { action: 'update', changes: { name: 'Missing revision' } })).rejects.toThrow('revision')
  })

  test('stages interaction edits and persists only after completion; blocks further dispatch', async () => {
    const f = await interaction()
    const before = await f.read()
    const result = await f.service.accessSettings('alpha', { action: 'update', expectedRevision: before.revision, changes: { name: 'From chat' } }, f.sessionId) as { status: string }
    expect(result.status).toBe('pending')
    expect((await f.read()).config.name).toBe(before.config.name)
    await expect(f.service.callNodeActionTool('alpha', f.sessionId, 'super_agent_message', { requestId: 'message', toNodeId: 'worker', body: 'Work' })).rejects.toThrow('pending')
    f.host.complete(f.sessionId, 'Settings are pending until this turn ends.')
    const after = await until(f.read, s => s.config.name === 'From chat' && !s.pending)
    expect(after.revision).not.toBe(before.revision)
    expect((await loadSuperAgentDocument(join(f.root, 'alpha'))).config?.name).toBe('From chat')
  })

  test('staged edits preserve newer UI settings and report the conflict', async () => {
    const f = await interaction()
    const before = await f.read()
    await f.service.accessSettings('alpha', { action: 'update', expectedRevision: before.revision, changes: { name: 'Stale draft' } }, f.sessionId)
    await f.service.save('alpha', { ...before.config, idleInspectionMinutes: 9 })
    f.host.complete(f.sessionId, 'Pending settings update.')
    await until(f.read, s => !s.pending)
    expect((await f.read()).config.name).toBe(before.config.name)
    expect((await f.read()).config.idleInspectionMinutes).toBe(9)
    expect((await f.service.get('alpha')).state.messages.some(m => m.body.includes('Settings update was not saved'))).toBe(true)
  })

  test('interrupted interaction cancels staged edits visibly', async () => {
    const f = await interaction()
    const before = await f.read()
    await f.service.accessSettings('alpha', { action: 'update', expectedRevision: before.revision, changes: { name: 'Must not save' } }, f.sessionId)
    f.host.complete(f.sessionId, '', 'interrupted')
    await until(f.read, s => !s.pending)
    expect((await f.read()).config.name).toBe(before.config.name)
    expect((await f.service.get('alpha')).state.messages.some(m => m.body.includes('Settings update was not saved'))).toBe(true)
  })

  test('rejects normal chat edits during work and worker access', async () => {
    const f = await configured()
    await f.service.command('alpha', { type: 'task', title: 'Work', instructions: 'Execute' })
    const running = await until(() => f.service.get('alpha'), s => s.state.nodes[1]?.status === 'working')
    const before = await f.read()
    await expect(f.service.accessSettings('alpha', { action: 'update', expectedRevision: before.revision, changes: { name: 'Busy' } })).rejects.toThrow('Stop active')
    await expect(f.service.accessSettings('alpha', { action: 'get' }, running.state.nodes[1]!.sessionId!)).rejects.toThrow('interaction node')
    expect((await f.read()).config.name).toBe(before.config.name)
  })

  test('tool is registered, errors are returned, and visibility is restricted to the interaction node', async () => {
    const tool = SESSION_TOOL_REGISTRY.get('super_agent_settings')!
    expect(tool).toBeDefined()
    const tools = [{ name: 'mcp__session__super_agent_settings' }]
    expect(filterSuperAgentTools(tools, 'coordinator')).toHaveLength(1)
    expect(filterSuperAgentTools(tools, 'orchestrator')).toHaveLength(0)
    expect(filterSuperAgentTools(tools, 'worker')).toHaveLength(0)
    expect((await tool.handler!({} as SessionToolContext, { action: 'get' })).isError).toBe(true)
    const f = await configured()
    const ctx = { superAgentSettings: args => f.service.accessSettings('alpha', args) } as SessionToolContext
    expect((await tool.handler!(ctx, { action: 'get' })).isError).not.toBe(true)
    expect((await tool.handler!(ctx, { action: 'update', changes: { name: 'X' } })).isError).toBe(true)
  })
})
