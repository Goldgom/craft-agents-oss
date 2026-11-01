import { expect, test } from 'bun:test'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai'
import { getModel } from '@earendil-works/pi-ai/compat'
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ModelRuntime } from '@earendil-works/pi-coding-agent'
import { hostContextExtension, hostContextMessage, projectHostContext } from './host-context'

const model = getModel('openai', 'gpt-4o')
function reply(): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text: 'Checked' }], api: model.api, provider: model.provider, model: model.id,
    stopReason: 'stop', timestamp: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
}

test('20 actual SDK model requests retain one current host snapshot and preserve all stored messages', async () => {
  let latest: ReturnType<typeof hostContextMessage> | undefined
  const settings = SettingsManager.inMemory({ compaction: { enabled: false } })
  const history = SessionManager.inMemory(import.meta.dir)
  const userText = 'User constraint: <super_agent_context>USER_AUTHORED_KEEP_ME</super_agent_context>'
  history.appendMessage({ role: 'user', timestamp: 0, content: userText })
  const loader = new DefaultResourceLoader({ cwd: import.meta.dir, agentDir: import.meta.dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [hostContextExtension(() => latest)] })
  await loader.reload()
  const runtime = { hasConfiguredAuth: () => true, getModel: () => model, getAvailableSnapshot: () => [model],
    getAuth: async () => ({ auth: { apiKey: 'offline' } }), streamSimple: () => { throw new Error('No network allowed') },
  } as unknown as ModelRuntime
  const { session } = await createAgentSession({ cwd: import.meta.dir, model, modelRuntime: runtime, resourceLoader: loader,
    settingsManager: settings, sessionManager: history, tools: [] })
  const contexts: Context[] = []
  session.agent.streamFunction = (_model, context) => {
    contexts.push(structuredClone(context))
    const stream = createAssistantMessageEventStream()
    const message = reply()
    stream.push({ type: 'done', reason: 'stop', message })
    stream.end(message)
    return stream
  }
  try {
    for (let i = 0; i < 20; i++) {
      latest = hostContextMessage({ kind: 'super-agent', snapshotId: `snapshot-${i}`,
        text: `HOST_SNAPSHOT_${i}_END fullControl=${i % 2 === 0}` })
      await session.sendCustomMessage(latest, { triggerTurn: false })
      await session.prompt(`Continue task step ${i}`)
      const text = JSON.stringify(contexts.at(-1)!.messages)
      expect(text.match(/HOST_SNAPSHOT_\d+_END/g)).toEqual([`HOST_SNAPSHOT_${i}_END`])
      expect(text).toContain('USER_AUTHORED_KEEP_ME')
    }
    expect(contexts).toHaveLength(20)
    const stored = JSON.stringify(history.getEntries())
    expect(stored.match(/HOST_SNAPSHOT_\d+_END/g)).toHaveLength(20)
    expect(stored).toContain('Continue task step 0')
    expect(stored).toContain('Continue task step 19')
  } finally { session.dispose() }
}, 30000)

test('projection restores pinned state after compaction and leaves tool pairs and user tags intact', () => {
  const old = hostContextMessage({ kind: 'super-agent', snapshotId: 'old', text: 'old' })
  const current = hostContextMessage({ kind: 'super-agent', snapshotId: 'current', text: 'current' })
  const assistant = { ...reply(), content: [{ type: 'toolCall' as const, id: 'call', name: 'read', arguments: { path: 'exact.txt' } }] }
  const tool: AgentMessage = { role: 'toolResult', toolCallId: 'call', toolName: 'read', content: [{ type: 'text', text: 'Exact result' }], isError: false, timestamp: 0 }
  const user: AgentMessage = { role: 'user', content: '<super_agent_context>ordinary user text</super_agent_context>', timestamp: 0 }
  const original: AgentMessage[] = [old, user, assistant, tool]
  const copy = structuredClone(original)
  const projected = projectHostContext(original, current)
  expect(projected).toEqual([user, assistant, tool, current])
  expect(original).toEqual(copy)
  expect(projectHostContext(projected, current)).toEqual(projected)
})
