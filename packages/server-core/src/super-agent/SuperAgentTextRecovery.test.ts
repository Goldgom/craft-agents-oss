import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSuperAgentDocument, type SuperAgentDocument } from '@tokenbird/shared/super-agent'
import { EMPTY_RESPONSE_ERROR_CODE } from '../sessions/session-turn-completion'
import { superAgentFixture, until } from './SuperAgentTestSupport'

type Fixture = Awaited<ReturnType<typeof superAgentFixture>>
async function start(f: Fixture) {
  await f.service.save('alpha', f.config)
  await f.service.command('alpha', { type: 'task', title: 'Analyze', instructions: 'Analyze the supplied facts.' })
  const state = await until(() => f.service.get('alpha'), s => s.state.tasks[0]?.status === 'running' && f.host.sends.length === 1)
  return state.state.tasks[0]!.sessionId!
}
async function stopped(f: Fixture, sessionId: string) {
  f.host.loseCompletion(sessionId)
  f.advance(11_000); await f.service.tick()
  f.advance(5_000); await f.service.tick()
  return f.service.get('alpha')
}

describe('Super Agent current-turn text recovery', () => {
  test('accepts a real completion after more than the old one-second grace', async () => {
    const f = await superAgentFixture()
    const sessionId = await start(f)
    f.host.loseCompletion(sessionId)
    f.advance(11_000); await f.service.tick()
    f.advance(3_000); await f.service.tick()
    expect((await f.service.get('alpha')).state.tasks[0]!.status).toBe('running')
    f.host.complete(sessionId, 'Finished normally')
    const result = await until(() => f.service.get('alpha'), s => s.state.tasks[0]?.status === 'completed')
    expect(result.state.tasks[0]!.output).toBe('Finished normally')
    expect(f.host.sends).toHaveLength(1)
  })

  test('does not turn an unknown operation into success from prose alone', async () => {
    const f = await superAgentFixture()
    const sessionId = await start(f)
    f.host.emit({ type: 'text_complete', sessionId, turnId: 'answer', text: 'Claimed success' })
    await f.service.get('alpha')
    const doc = (f.service as unknown as { documents: Map<string, SuperAgentDocument> }).documents.get('alpha')!
    ;(doc.state.operations ??= []).push({ id: 'op', key: 'a'.repeat(64), nodeId: 'worker', sessionId,
      turnId: doc.pendingTurns[0]!.id, invocationId: 'write', toolName: 'Write', status: 'unknown',
      createdAt: f.now(), updatedAt: f.now() })
    const result = await stopped(f, sessionId)
    expect(result.state.tasks[0]!.status).toBe('failed')
    expect(result.state.tasks[0]!.output).toBeUndefined()
    expect(f.host.sends.filter(s => s.sessionId === sessionId)).toHaveLength(1)
  })

  test('uses a committed delivery when completion contains no extra prose', async () => {
    const f = await superAgentFixture()
    await f.service.save('alpha', f.config)
    await f.service.command('alpha', { type: 'chat', text: 'Report findings' })
    await until(() => f.service.get('alpha'), () => f.host.sends.length === 1)
    const sessionId = f.host.sends[0]!.sessionId
    f.host.emit({ type: 'tool_start', sessionId, toolUseId: 'delivery', toolName: 'super_agent_deliver', toolInput: {} })
    await f.service.callNodeActionTool('alpha', sessionId, 'super_agent_deliver', { requestId: 'reply', reply: 'Checked findings' })
    f.host.emit({ type: 'tool_result', sessionId, toolUseId: 'delivery', toolName: 'super_agent_deliver', result: 'applied' })
    await f.service.get('alpha')
    f.host.complete(sessionId, '')
    const result = await until(() => f.service.get('alpha'), s => s.state.nodes[0]?.status === 'idle')
    expect(result.state.messages.filter(m => m.toNodeId === 'user' && m.body === 'Checked findings')).toHaveLength(1)
    expect(f.host.sends).toHaveLength(1)
  })

  test('recovers final text after a tracked tool has finished', async () => {
    const f = await superAgentFixture()
    const sessionId = await start(f)
    f.host.emit({ type: 'tool_start', sessionId, toolUseId: 'read', toolName: 'Read', toolInput: {} })
    f.host.emit({ type: 'tool_result', sessionId, toolUseId: 'read', toolName: 'Read', result: 'contents' })
    f.host.emit({ type: 'text_complete', sessionId, turnId: 'answer', text: 'File checked' })
    await f.service.get('alpha')
    const result = await stopped(f, sessionId)
    expect(result.state.tasks[0]).toMatchObject({ status: 'completed', output: 'File checked' })
    expect(f.host.sends).toHaveLength(1)
  })

  test('returns this turn text after a lost completion without tools or replaying an earlier action block', async () => {
    const f = await superAgentFixture()
    const sessionId = await start(f)
    f.host.finalText = 'An older answer that must not be read'
    f.host.emit({ type: 'text_complete', sessionId, turnId: 'answer', text: 'Actual analysis. <super_agent_actions>{"board":[{"title":"not executed"}]}</super_agent_actions>' })
    await f.service.get('alpha')
    const durable = await loadSuperAgentDocument(join(f.root, 'alpha'))
    expect(durable.pendingTurns[0]).toMatchObject({ hasToolActivity: false, responseText: 'Actual analysis.' })
    const result = await stopped(f, sessionId)
    expect(result.state.tasks[0]).toMatchObject({ status: 'completed', phase: 'submitted', output: 'Actual analysis.' })
    expect(result.state.tasks[0]!.acceptance).toBeUndefined()
    expect(result.state.board).toHaveLength(0)
    expect(f.host.finalTextReads).toBe(0)
    expect(f.host.sends.filter(s => s.sessionId === sessionId)).toHaveLength(1)
    expect(result.state.messages.some(m => m.body.includes('The result is unknown'))).toBe(false)
    // A delayed terminal event must not replace the recovered result.
    f.host.complete(sessionId, 'Late answer')
    expect((await f.service.get('alpha')).state.tasks[0]!.output).toBe('Actual analysis.')
  })

  test('preserves streamed text beyond the live activity truncation limit', async () => {
    const f = await superAgentFixture()
    const sessionId = await start(f)
    const text = Array.from({ length: 1500 }, (_, i) => `Finding ${i}: checked input ${i * 7}.\n`).join('')
    f.host.emit({ type: 'text_delta', sessionId, turnId: 'answer', delta: text.slice(0, 1000) })
    f.host.emit({ type: 'text_delta', sessionId, turnId: 'answer', delta: text.slice(1000) })
    await f.service.get('alpha')
    const result = await stopped(f, sessionId)
    expect(result.state.tasks[0]!.output).toBe(text.trim())
  })

  for (const terminal of ['empty-complete', 'empty-error'] as const) {
    test(`uses observed current text for ${terminal} without retrying the request`, async () => {
      const f = await superAgentFixture()
      const sessionId = await start(f)
      f.host.emit({ type: 'text_complete', sessionId, turnId: 'answer', text: 'Current response' })
      await f.service.get('alpha')
      f.host.complete(sessionId, '', terminal === 'empty-complete' ? 'complete' : 'error',
        terminal === 'empty-error' ? { errorCode: EMPTY_RESPONSE_ERROR_CODE, canRetry: true } : {})
      const result = await until(() => f.service.get('alpha'), s => s.state.tasks[0]?.status === 'completed')
      expect(result.state.tasks[0]!.output).toBe('Current response')
      expect(f.host.sends.filter(s => s.sessionId === sessionId)).toHaveLength(1)
    })
  }

  for (const excluded of ['thinking', 'intermediate', 'discarded', 'none'] as const) {
    test(`does not recover ${excluded} text as the result`, async () => {
      const f = await superAgentFixture()
      const sessionId = await start(f)
      if (excluded === 'thinking') f.host.emit({ type: 'text_delta', sessionId, turnId: 'answer__thinking1', delta: 'Hidden reasoning' })
      if (excluded === 'intermediate') {
        f.host.emit({ type: 'text_delta', sessionId, turnId: 'answer', delta: 'Intermediate analysis' })
        f.host.emit({ type: 'text_complete', sessionId, turnId: 'answer', text: 'Intermediate analysis', isIntermediate: true })
      }
      if (excluded === 'discarded') {
        f.host.emit({ type: 'text_delta', sessionId, turnId: 'answer', delta: 'Discard this' })
        f.host.emit({ type: 'text_discard', sessionId, turnId: 'answer' })
      }
      await f.service.get('alpha')
      const result = await stopped(f, sessionId)
      expect(result.state.tasks[0]!.status).toBe('failed')
      expect(result.state.tasks[0]!.output).toBeUndefined()
    })
  }

  for (const toolEvent of ['tool_start', 'tool_result'] as const) {
    test(`${toolEvent === 'tool_start' ? 'preserves an unfinished tool' : 'recovers a completed tool and final answer'}`, async () => {
      const f = await superAgentFixture()
      const sessionId = await start(f)
      if (toolEvent === 'tool_start') f.host.emit({ type: 'tool_start', sessionId, toolUseId: 'read-1', toolName: 'Read', toolInput: {} })
      else f.host.emit({ type: 'tool_result', sessionId, toolUseId: 'read-1', toolName: 'Read', result: 'data' })
      f.host.emit({ type: 'text_complete', sessionId, turnId: 'answer', text: 'Tool work summary' })
      await f.service.get('alpha')
      expect((await loadSuperAgentDocument(join(f.root, 'alpha'))).pendingTurns[0]!.hasToolActivity).toBe(true)
      const result = await stopped(f, sessionId)
      if (toolEvent === 'tool_start') {
        expect(result.state.tasks[0]!.status).toBe('failed')
        expect(result.state.tasks[0]!.error).toContain('The result is unknown')
      } else {
        expect(result.state.tasks[0]).toMatchObject({ status: 'completed', output: 'Tool work summary' })
      }
    })
  }

  test('retains a normal final answer rather than replacing it with observed text', async () => {
    const f = await superAgentFixture()
    const sessionId = await start(f)
    f.host.emit({ type: 'text_complete', sessionId, turnId: 'draft', text: 'Observed draft' })
    await f.service.get('alpha')
    f.host.complete(sessionId, 'Authoritative final answer')
    const result = await until(() => f.service.get('alpha'), s => s.state.tasks[0]?.status === 'completed')
    expect(result.state.tasks[0]!.output).toBe('Authoritative final answer')
  })

  test('does not reuse observed text from an earlier turn in the same session', async () => {
    const f = await superAgentFixture()
    const sessionId = await start(f)
    f.host.emit({ type: 'text_complete', sessionId, turnId: 'old', text: 'Earlier turn output' })
    await f.service.get('alpha')
    f.host.complete(sessionId, 'Earlier turn output')
    await until(() => f.service.get('alpha'), s => s.state.tasks[0]?.status === 'completed')
    f.advance(1001)
    await f.service.command('alpha', { type: 'task', nodeId: 'worker', title: 'New work', instructions: 'Different task' })
    await until(() => f.service.get('alpha'), s => s.state.tasks[1]?.status === 'running' && f.host.sends.filter(x => x.sessionId === sessionId).length === 2)
    const result = await stopped(f, sessionId)
    expect(result.state.tasks[1]!.status).toBe('failed')
    expect(result.state.tasks[1]!.output).toBeUndefined()
  })
})
