import { describe, expect, test } from 'bun:test'
import { resolveSessionTurnCompletion } from './session-turn-completion'

const oldAnswer = { id: 'old', role: 'assistant', content: '<super_agent_actions>{"tasks":["old task"]}</super_agent_actions>' }
const user = { id: 'user', role: 'user', content: 'Continue validation' }
const error = { id: 'error', role: 'error', content: 'Connection Error: Could not reach the AI service.' }
const answer = { id: 'new', role: 'assistant', content: 'Actual current result' }

describe('current turn completion', () => {
  test('preserves current structured failure metadata without using historical errors', () => {
    const typed = { ...error, errorCode: 'network_error', errorCanRetry: true }
    expect(resolveSessionTurnCompletion([oldAnswer, user, typed], 'complete', 'old', 'old'))
      .toEqual({ reason: 'error', finalText: error.content, errorCode: 'network_error', canRetry: true })
    expect(resolveSessionTurnCompletion([oldAnswer, user, { ...typed, errorCanRetry: false }], 'error', 'old', 'old').canRetry).toBe(false)
    expect(resolveSessionTurnCompletion([typed, oldAnswer, user, answer], 'complete', 'old', 'new'))
      .toEqual({ reason: 'complete', finalMessageId: 'new', finalText: answer.content })
  })
  test('a provider error followed by complete reports failure instead of replaying old actions', () => {
    expect(resolveSessionTurnCompletion([oldAnswer, user, error], 'complete', 'old', 'old'))
      .toEqual({ reason: 'error', finalText: error.content })
  })
  test('an empty completion cannot return the previous answer', () => {
    expect(resolveSessionTurnCompletion([oldAnswer, user], 'complete', 'old', 'old'))
      .toEqual({ reason: 'error', finalText: 'Turn completed without a new final assistant response.', errorCode: 'empty_response', canRetry: true })
  })
  test('blank new final answers are recoverable empty responses, not successful results', () => {
    for (const content of ['', ' \n\t ']) {
      expect(resolveSessionTurnCompletion([oldAnswer, user, { ...answer, content }], 'complete', 'old', 'new'))
        .toEqual({ reason: 'error', finalText: 'Turn completed without a new final assistant response.', errorCode: 'empty_response', canRetry: true })
    }
  })
  test('successful recovery after an error returns only the new final answer', () => {
    expect(resolveSessionTurnCompletion([oldAnswer, user, error, answer], 'complete', 'old', 'new'))
      .toEqual({ reason: 'complete', finalMessageId: 'new', finalText: answer.content })
  })
  test('an empty final answer cannot mask a preceding nonretryable error', () => {
    const typed = { ...error, content: 'Invalid API key', errorCode: 'invalid_api_key', errorCanRetry: false }
    expect(resolveSessionTurnCompletion([oldAnswer, user, typed, { ...answer, content: ' ' }], 'complete', 'old', 'new'))
      .toEqual({ reason: 'error', finalText: typed.content, errorCode: typed.errorCode, canRetry: false })
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
