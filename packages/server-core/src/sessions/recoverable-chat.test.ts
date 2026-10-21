import { describe, expect, it } from 'bun:test'
import type { AgentEvent } from '@tokenbird/core/types'
import { createAgentError } from '@tokenbird/shared/agent'
import { recoverableChat } from './recoverable-chat'

const activation: AgentEvent = { type: 'source_activated', sourceSlug: 'binance-cli-mcp', originalMessage: 'inspect only' }
const complete: AgentEvent = { type: 'complete' }
const unavailable: AgentEvent = { type: 'typed_error', error: createAgentError('service_error') }
const answer: AgentEvent = { type: 'text_complete', text: 'Recovered answer' }

function harness(turns: AgentEvent[][]) {
  let current = true
  let closed = false
  const calls: boolean[] = []
  let refreshes = 0
  const stream = recoverableChat({
    chat: async function* (continuing) {
      expect(closed || calls.length === 0).toBe(true)
      closed = false
      const turn = turns[calls.length]!
      calls.push(continuing)
      try { yield* turn } finally { closed = true }
    },
    isCurrent: () => current,
    refresh: async () => { expect(closed).toBe(true); refreshes++ },
    wait: async () => {},
  })
  return { stream, calls, stop: () => { current = false }, refreshes: () => refreshes }
}

describe('chat recovery', () => {
  it('waits for MCP abort cleanup and continues without a service error or intermediate completion', async () => {
    const h = harness([[activation], [answer, complete]])
    const events = await Array.fromAsync(h.stream)
    expect(h.calls).toEqual([false, true])
    expect(h.refreshes()).toBe(1)
    expect(events.filter(e => e.type === 'complete')).toHaveLength(1)
    expect(events.filter(e => e.type === 'typed_error')).toHaveLength(0)
    expect(events).toContainEqual(answer)
  })

  it('chains activations even when backend sends a trailing complete', async () => {
    const h = harness([[activation, complete], [activation], [answer, complete]])
    const events = await Array.fromAsync(h.stream)
    expect(h.calls).toEqual([false, true, true])
    expect(events.filter(e => e.type === 'complete')).toHaveLength(1)
  })

  it('automatically recovers a temporary AI service failure and preserves unfinished text', async () => {
    const h = harness([[{ type: 'text_delta', text: 'Checking…', turnId: 'old' }, unavailable, complete], [answer, complete]])
    const events = await Array.fromAsync(h.stream)
    expect(h.calls).toEqual([false, true])
    expect(events).toContainEqual({ type: 'text_complete', text: 'Checking…', turnId: 'old', isIntermediate: true })
    expect(events.filter(e => e.type === 'typed_error')).toHaveLength(0)
  })

  it('bounds AI recovery attempts and exposes the final error', async () => {
    const h = harness(Array.from({ length: 3 }, () => [unavailable, complete]))
    const events = await Array.fromAsync(h.stream)
    expect(h.calls).toHaveLength(3)
    expect(events.filter(e => e.type === 'typed_error')).toEqual([unavailable])
    expect(events.filter(e => e.type === 'complete')).toHaveLength(1)
  })

  it('recovers streams that end without an error or completion', async () => {
    const h = harness([[], [answer, complete]])
    const events = await Array.fromAsync(h.stream)
    expect(h.calls).toEqual([false, true])
    expect(events).toContainEqual(answer)
  })

  it('recovers thrown transport errors only after the old generator closes', async () => {
    let calls = 0
    let closed = false
    const events = await Array.fromAsync(recoverableChat({
      chat: async function* () {
        if (++calls === 1) {
          try { throw new Error('fetch failed: ECONNRESET') } finally { closed = true }
        }
        yield answer
        yield complete
      },
      isCurrent: () => true,
      refresh: async () => { expect(closed).toBe(true) },
      wait: async () => {},
    }))
    expect(calls).toBe(2)
    expect(events).toContainEqual(answer)
  })

  it('retains usage from a suppressed handoff completion', async () => {
    const handoffs: AgentEvent[] = []
    const usage: AgentEvent = { type: 'complete', usage: { inputTokens: 10, outputTokens: 3, costUsd: 0.01 } }
    let calls = 0
    const events = await Array.fromAsync(recoverableChat({
      chat: async function* () { yield* ++calls === 1 ? [activation, usage] : [answer, complete] },
      isCurrent: () => true,
      refresh: async () => {},
      onHandoffComplete: async event => { handoffs.push(event) },
    }))
    expect(handoffs).toEqual([usage])
    expect(events.filter(e => e.type === 'complete')).toEqual([complete])
  })

  it('never automatically retries auth, policy or billing errors', async () => {
    for (const code of ['invalid_api_key', 'content_policy_blocked', 'billing_error'] as const) {
      const error: AgentEvent = { type: 'typed_error', error: createAgentError(code) }
      const h = harness([[error, complete]])
      expect(await Array.fromAsync(h.stream)).toEqual([error, complete])
      expect(h.calls).toEqual([false])
    }
  })

  it('honors user stop during backoff without creating another chat', async () => {
    const h = harness([[activation], [answer, complete]])
    const events: AgentEvent[] = []
    for await (const event of h.stream) {
      events.push(event)
      if (event.type === 'retry') h.stop()
    }
    expect(h.calls).toEqual([false])
    expect(h.refreshes()).toBe(0)
    expect(events).not.toContainEqual(answer)
  })

  it('bounds repeated MCP activation loops', async () => {
    const h = harness(Array.from({ length: 9 }, () => [activation]))
    const events = await Array.fromAsync(h.stream)
    expect(h.calls).toHaveLength(9)
    expect(events.at(-2)?.type).toBe('typed_error')
    expect(events.at(-1)?.type).toBe('complete')
  })
})
