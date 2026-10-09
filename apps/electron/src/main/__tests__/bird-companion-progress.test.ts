import { describe, expect, it } from 'bun:test'
import { BirdCompanionProgress } from '../bird-companion-progress'
import { toBirdProgressEvent, type BirdProgressEvent } from '../../shared/bird-companion'

const tool = (id = 't1', computer = true, sessionId = 's1'): BirdProgressEvent => ({ type: 'tool', sessionId, toolUseId: id, activity: computer ? 'click' : 'reading', computer })
const result = (id = 't1', isError = false): BirdProgressEvent => ({ type: 'result', sessionId: 's1', toolUseId: id, isError })
const finish = (outcome: 'complete' | 'error' | 'interrupted' = 'complete'): BirdProgressEvent => ({ type: 'finish', sessionId: 's1', outcome })

describe('bird companion lifecycle', () => {
  it('defaults to hidden, automatically shows only for computer use, and retains the end message', () => {
    const progress = new BirdCompanionProgress()
    expect(progress.getState().visible).toBe(false)
    progress.observe('w', tool('read', false))
    expect(progress.getState().visible).toBe(false)
    progress.observe('w', tool())
    expect(progress.getState()).toMatchObject({ visible: true, mood: 'working', activity: 'click' })
    progress.observe('w', result())
    expect(progress.getState()).toMatchObject({ mood: 'working', activity: 'reading', completedSteps: 1 })
    progress.observe('w', result('read'))
    expect(progress.getState()).toMatchObject({ mood: 'thinking', completedSteps: 2 })
    progress.observe('w', finish())
    expect(progress.getState()).toMatchObject({ visible: true, mood: 'success', activity: 'finished', activeSessions: 0 })
    progress.clearFinished()
    expect(progress.getState().visible).toBe(false)
    progress.observe('w', tool())
    progress.observe('w', result())
    progress.observe('w', finish())
    expect(progress.getState().visible).toBe(false)
  })

  it('respects the automatic display switch independently from pinned display', () => {
    const progress = new BirdCompanionProgress()
    progress.setPreferences({ alwaysVisible: false, autoShowComputerUse: false })
    progress.observe('w', tool())
    expect(progress.getState().visible).toBe(false)
    progress.setPreferences({ alwaysVisible: true, autoShowComputerUse: false })
    expect(progress.getState().visible).toBe(true)
    progress.observe('w', finish())
    progress.clearFinished()
    expect(progress.getState()).toMatchObject({ visible: true, mood: 'idle' })
  })

  it('displays permission attempts immediately and does not revive resolved duplicate requests', () => {
    const progress = new BirdCompanionProgress()
    const permission: BirdProgressEvent = { type: 'permission', sessionId: 's1', requestId: 'p', computer: true }
    progress.observe('w', permission)
    expect(progress.getState()).toMatchObject({ visible: true, mood: 'waiting', activity: 'permission' })
    progress.observe('w', { type: 'permission_resolved', sessionId: 's1', requestId: 'p', allowed: false })
    expect(progress.getState().activity).toBe('denied')
    progress.observe('w', permission)
    expect(progress.getState().activity).toBe('denied')
    progress.observe('w', finish())
    expect(progress.getState()).toMatchObject({ mood: 'error', activity: 'finishedWithErrors' })
    progress.observe('w', permission)
    expect(progress.getState().activeSessions).toBe(0)
  })

  it('deduplicates local and renderer delivery without double counting or resetting an active turn', () => {
    const progress = new BirdCompanionProgress()
    const start: BirdProgressEvent = { type: 'start', sessionId: 's1', startId: 'm1' }
    progress.observe('w', start)
    progress.observe('w', tool())
    progress.observe('w', start)
    progress.observe('w', tool())
    progress.observe('w', result())
    progress.observe('w', result())
    progress.observe('w', finish())
    progress.observe('w', start)
    progress.observe('w', finish())
    expect(progress.getState()).toMatchObject({ completedSteps: 1, mood: 'success' })
    progress.observe('w', { ...start, startId: 'm2' })
    expect(progress.getState().visible).toBe(false)
    progress.observe('w', tool('t2'))
    expect(progress.getState()).toMatchObject({ completedSteps: 0, mood: 'working', visible: true })
  })

  it('keeps concurrent tasks and matching session ids in different workspaces separate', () => {
    const progress = new BirdCompanionProgress()
    progress.observe('w1', tool())
    progress.observe('w2', tool())
    expect(progress.getState().activeSessions).toBe(2)
    progress.observe('w2', finish())
    expect(progress.getState()).toMatchObject({ activeSessions: 1, mood: 'working' })
    progress.clearFinished()
    expect(progress.getState().activeSessions).toBe(1)
    progress.observe('w1', finish())
    expect(progress.getState().mood).toBe('success')
  })

  it('retains errors and interruption when the final complete event arrives', () => {
    for (const outcome of ['error', 'interrupted'] as const) {
      const progress = new BirdCompanionProgress()
      progress.observe('w', tool())
      progress.observe('w', finish(outcome))
      progress.observe('w', finish())
      expect(progress.getState()).toMatchObject({ mood: outcome, activity: outcome })
    }
    const progress = new BirdCompanionProgress()
    progress.observe('w', tool())
    progress.observe('w', result('t1', true))
    progress.observe('w', finish())
    expect(progress.getState()).toMatchObject({ mood: 'error', activity: 'finishedWithErrors' })
  })

  it('dismisses the current task until a new turn and handles session deletion', () => {
    const progress = new BirdCompanionProgress()
    progress.observe('w', tool())
    progress.dismiss()
    progress.observe('w', tool('t2'))
    expect(progress.getState().visible).toBe(false)
    progress.observe('w', finish())
    progress.observe('w', { type: 'start', sessionId: 's1', startId: 'm2' })
    progress.observe('w', tool('t3'))
    expect(progress.getState().visible).toBe(true)
    progress.observe('w', { type: 'delete', sessionId: 's1' })
    expect(progress.getState().visible).toBe(false)
  })
})

describe('bird progress projection', () => {
  it('supports native/MCP computer tools and excludes input text from progress', () => {
    for (const toolName of ['computer_use', 'mcp__session__computer_use']) {
      const event = toBirdProgressEvent({ type: 'tool_start', sessionId: 's', toolUseId: 't', toolName,
        toolInput: { action: 'type', text: 'private-password' }, toolIntent: 'private-intent' })
      expect(event).toEqual({ type: 'tool', sessionId: 's', toolUseId: 't', activity: 'type', computer: true })
      expect(JSON.stringify(event)).not.toContain('private')
    }
  })

  it('recognizes the bundled desktop-control command and ignores unrelated tool names', () => {
    const base = { type: 'tool_start' as const, sessionId: 's', toolUseId: 't', toolName: 'Bash' }
    expect(toBirdProgressEvent({ ...base, toolInput: { command: '"C:\\tools\\desktop-control.cmd" screenshot' } })).toMatchObject({ computer: true })
    expect(toBirdProgressEvent({ ...base, toolInput: { command: 'echo unrelated' } })).toMatchObject({ computer: false })
    expect(toBirdProgressEvent({ ...base, toolName: 'check_computer_use_docs', toolInput: {} })).toMatchObject({ computer: false })
  })

  it('handles new messages but ignores queued messages and streaming output', () => {
    const event = { type: 'user_message' as const, sessionId: 's', message: { id: 'm', role: 'user' as const, content: 'private', timestamp: 1 }, status: 'accepted' as const }
    expect(toBirdProgressEvent(event)).toEqual({ type: 'start', sessionId: 's', startId: 'm' })
    expect(toBirdProgressEvent({ ...event, status: 'queued' })).toBeNull()
    expect(toBirdProgressEvent({ type: 'text_delta', sessionId: 's', delta: 'private' })).toBeNull()
  })
})
