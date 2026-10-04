import { describe, expect, test } from 'bun:test'
import { resolveSessionTurnCompletion } from './session-turn-completion'

const oldAnswer = { id: 'old', role: 'assistant', content: '<super_agent_actions>{"tasks":["old task"]}</super_agent_actions>' }
const user = { id: 'user', role: 'user', content: 'Continue validation' }
const error = { id: 'error', role: 'error', content: 'Connection Error: Could not reach the AI service.' }
const answer = { id: 'new', role: 'assistant', content: 'Actual current result' }

describe('current turn completion', () => {
  test('a provider error followed by complete reports failure instead of replaying old actions', () => {
    expect(resolveSessionTurnCompletion([oldAnswer, user, error], 'complete', 'old', 'old'))
      .toEqual({ reason: 'error', finalText: error.content })
  })
  test('an empty completion cannot return the previous answer', () => {
    expect(resolveSessionTurnCompletion([oldAnswer, user], 'complete', 'old', 'old'))
      .toEqual({ reason: 'error', finalText: 'Turn completed without a new final assistant response.' })
  })
  test('successful recovery after an error returns only the new final answer', () => {
    expect(resolveSessionTurnCompletion([oldAnswer, user, error, answer], 'complete', 'old', 'new'))
      .toEqual({ reason: 'complete', finalMessageId: 'new', finalText: answer.content })
  })
  test('an error after a new answer is still a failed turn', () => {
    expect(resolveSessionTurnCompletion([oldAnswer, user, answer, error], 'complete', 'old', 'new'))
      .toEqual({ reason: 'error', finalText: error.content })
  })
  test('historical errors and cancellation do not become current results', () => {
    expect(resolveSessionTurnCompletion([error, oldAnswer, user], 'interrupted', 'old', 'old'))
      .toEqual({ reason: 'interrupted', finalMessageId: undefined, finalText: undefined })
    expect(resolveSessionTurnCompletion([user, answer], 'complete', undefined, 'new'))
      .toEqual({ reason: 'complete', finalMessageId: 'new', finalText: answer.content })
  })
  test('native compaction completes without an assistant answer and never returns old actions', () => {
    const compact = { id: 'compact', role: 'user', content: '/compact Preserve goals' }
    const notice = { id: 'notice', role: 'info', statusType: 'compaction_complete', content: 'Compacted context to fit within limits' }
    expect(resolveSessionTurnCompletion([oldAnswer, compact, notice], 'complete', 'old', 'old'))
      .toEqual({ reason: 'complete', finalText: notice.content })
    expect(resolveSessionTurnCompletion([oldAnswer, compact, error], 'complete', 'old', 'old'))
      .toEqual({ reason: 'error', finalText: error.content })
    expect(resolveSessionTurnCompletion([oldAnswer, user, notice], 'complete', 'old', 'old').reason).toBe('error')
  })
})
