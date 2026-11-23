import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createManagedSession, SessionManager } from './SessionManager.ts'

// Regression test for tokenbird#943:
//
//   The automation "Test" action awaited executePromptAutomation → sendMessage
//   to *full* completion. A prompt that used tools or produced >30s of output
//   tripped the 30s RPC client timeout and reported failure even though the
//   session streamed fine.
//
// The fix adds `waitForCompletion` to ExecutePromptAutomationInput. The Test
// handler passes `false` so the method returns once the session is created and
// the prompt is dispatched (fire-and-forget, error-logged). Real automation
// execution omits the flag and keeps awaiting completion.
//
// These tests stub the heavy collaborators (createSession / sendEvent /
// sendMessage) and lock the branch: waitForCompletion:false resolves even when
// sendMessage never settles; the default still awaits (and propagates errors).

describe('executePromptAutomation waitForCompletion', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'exec-prompt-automation-'))
    sm = new SessionManager()
    // Stub the collaborators executePromptAutomation touches. With no labels /
    // mentions / llmConnection in the input, everything else is skipped.
    ;(sm as unknown as { createSession: unknown }).createSession = async () => ({ id: 'test-sess' })
    ;(sm as unknown as { sendEvent: unknown }).sendEvent = () => {}
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('waitForCompletion:false returns as soon as the session is created (does not await the turn)', async () => {
    let sendCalled = false
    // Never-resolving send simulates a long tool-using turn.
    ;(sm as unknown as { sendMessage: unknown }).sendMessage = () => {
      sendCalled = true
      return new Promise<never>(() => {})
    }

    const result = await sm.executePromptAutomation({
      workspaceId: 'ws_test',
      workspaceRootPath: tmpRoot,
      prompt: 'do something long',
      waitForCompletion: false,
    })

    expect(result.sessionId).toBe('test-sess')
    expect(sendCalled).toBe(true)
  })

  it('groups scheduled runs and deduplicates a replay after the prompt is accepted', async () => {
    const workspace = { id: 'ws_test', name: 'Test', slug: 'test', rootPath: tmpRoot, createdAt: 1 }
    const ids: string[] = []
    const accepted: string[] = []
    sm['createSession'] = async (_id, options) => {
      const id = `session-${ids.length}`
      ids.push(id)
      sm['sessions'].set(id, createManagedSession({ id, parentSessionId: options?.parentSessionId }, workspace, { messagesLoaded: true }))
      return { id } as Awaited<ReturnType<SessionManager['createSession']>>
    }
    sm['persistSession'] = () => {}
    sm.flushSession = async () => {}
    sm.sendMessage = async (id, prompt, _attachments, _stored, _options, _existing, _authRetry, onAck) => {
      accepted.push(id)
      sm['sessions'].get(id)!.messages.push({ id: 'message', role: 'user', content: prompt, timestamp: 1 })
      onAck?.('message')
      await new Promise<never>(() => {})
    }
    const input = { workspaceId: workspace.id, workspaceRootPath: tmpRoot, prompt: 'daily report', automationName: 'Daily report' }
    const firstRun = { automationId: 'daily', runId: '1:0', timestamp: 1 }
    const first = await sm.executePromptAutomation({ ...input, scheduledRun: firstRun })
    expect(await sm.executePromptAutomation({ ...input, scheduledRun: firstRun })).toEqual(first)
    const next = await sm.executePromptAutomation({ ...input, scheduledRun: { ...firstRun, runId: '2:0', timestamp: 2 } })
    expect(accepted).toEqual([first.sessionId, next.sessionId])
    expect(ids).toHaveLength(3)
    expect(sm['sessions'].get(first.sessionId)?.parentSessionId).toBe(ids[0])
    expect(sm['sessions'].get(next.sessionId)?.parentSessionId).toBe(ids[0])
  })

  it('default (waitForCompletion unset) awaits sendMessage and propagates its error', async () => {
    ;(sm as unknown as { sendMessage: unknown }).sendMessage = () =>
      Promise.reject(new Error('send failed'))

    await expect(
      sm.executePromptAutomation({
        workspaceId: 'ws_test',
        workspaceRootPath: tmpRoot,
        prompt: 'do something',
      }),
    ).rejects.toThrow('send failed')
  })
})
