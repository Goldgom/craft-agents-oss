import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { emptySuperAgentState, type SuperAgentSnapshot } from '@tokenbird/shared/super-agent'
import { createDynamicConfig, type SuperAgentText } from './super-agent-ui'
import { superAgentThinkingPhase } from './super-agent-thinking'
import { SuperAgentThinkingIndicator } from './SuperAgentThinkingIndicator'

const text: SuperAgentText = key => key
function fixture(): SuperAgentSnapshot {
  const config = createDynamicConfig([], text)
  const state = emptySuperAgentState(1)
  state.nodes = config.nodes.map(node => ({ nodeId: node.id, status: 'idle' }))
  return { config, state, environment: { available: true, isolation: 'host-folder', detail: '' } }
}

test('main node animation follows sending, queueing, preparation, thinking, reply and completion', () => {
  const snapshot = fixture(), main = snapshot.state.nodes[0]!
  expect(superAgentThinkingPhase(snapshot)).toBeUndefined()
  expect(superAgentThinkingPhase(snapshot, true)).toBe('mainQueued')
  snapshot.interactionPending = true
  expect(superAgentThinkingPhase(snapshot)).toBe('mainQueued')
  main.status = 'preparing'
  expect(superAgentThinkingPhase(snapshot)).toBe('mainPreparing')
  main.status = 'working'; main.sessionId = 'main-session'
  expect(superAgentThinkingPhase(snapshot)).toBe('mainThinking')
  snapshot.activity = [{ nodeId: main.nodeId, sessionId: main.sessionId, status: 'working', startedAt: 1, updatedAt: 2,
    entries: [{ id: 'text', kind: 'text', text: 'reply', createdAt: 2, updatedAt: 2 }] }]
  expect(superAgentThinkingPhase(snapshot)).toBe('mainReplying')
  main.status = 'recovering'
  expect(superAgentThinkingPhase(snapshot)).toBe('mainRecovering')
  main.status = 'idle'; snapshot.interactionPending = false
  expect(superAgentThinkingPhase(snapshot)).toBeUndefined()
  main.status = 'error'
  expect(superAgentThinkingPhase(snapshot)).toBeUndefined()
})

test('background work, paused recovery and user approvals do not imply main node thinking', () => {
  const snapshot = fixture(), main = snapshot.state.nodes[0]!
  snapshot.state.nodes[1]!.status = 'working'
  expect(superAgentThinkingPhase(snapshot)).toBeUndefined()
  snapshot.interactionPending = true; snapshot.recoverySuspended = true
  expect(superAgentThinkingPhase(snapshot)).toBeUndefined()
  main.status = 'working'
  expect(superAgentThinkingPhase(snapshot, false, true)).toBeUndefined()
  main.sessionId = 'main-session'
  snapshot.activity = [{ nodeId: main.nodeId, sessionId: main.sessionId, status: 'waiting_permission', startedAt: 1, updatedAt: 2, entries: [] }]
  expect(superAgentThinkingPhase(snapshot)).toBeUndefined()
})

test('thinking bubble exposes a live status, staggered dots and reduced-motion support, and disappears when idle', () => {
  const render = (phase?: ReturnType<typeof superAgentThinkingPhase>) => renderToStaticMarkup(<SuperAgentThinkingIndicator phase={phase} avatar="✦" name="Main" text={text} />)
  expect(render()).toBe('')
  const html = render('mainThinking')
  expect(html).toContain('role="status"')
  expect(html).toContain('aria-live="polite"')
  expect(html).toContain('mainThinking')
  expect(html).toContain('motion-safe:animate-bounce')
  expect(html).toContain('animation-delay:150ms')
})
