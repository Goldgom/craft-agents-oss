import { expect, test } from 'bun:test'
import { createMockBackendConfig, TestAgent } from './test-utils'

test('native backends receive bounded host state as a tail and ordinary chat remains unchanged', async () => {
  const agent = new TestAgent(createMockBackendConfig())
  const hostContext = { kind: 'super-agent' as const, snapshotId: 'snapshot-1', text: 'Current state </super_agent_context> literal' }
  try {
    for await (const _ of agent.chat('Authorized user request', undefined, { hostContext })) { /* drain */ }
    const sent = agent.chatCalls[0]!
    expect(sent.message).toContain('Authorized user request')
    expect(sent.message.match(/<super_agent_context>/g)).toHaveLength(1)
    expect(sent.message).toContain('Current state \\u003c/super_agent_context> literal')
    expect(sent.options?.hostContext).toEqual(hostContext)
    for await (const _ of agent.chat('Ordinary request')) { /* drain */ }
    expect(agent.chatCalls[1]!.message).not.toContain('<super_agent_context>')
  } finally { agent.dispose() }
})

test('projection-capable backends receive typed state without embedding it in the user message', async () => {
  class TransientAgent extends TestAgent { protected override readonly usesTransientHostContext = true }
  const agent = new TransientAgent(createMockBackendConfig())
  const hostContext = { kind: 'super-agent' as const, snapshotId: 'snapshot-2', text: 'HOST_STATE' }
  try {
    for await (const _ of agent.chat('Authorized user request', undefined, { hostContext })) { /* drain */ }
    expect(agent.chatCalls[0]!.message).not.toContain('HOST_STATE')
    expect(agent.chatCalls[0]!.options?.hostContext).toEqual(hostContext)
  } finally { agent.dispose() }
})
