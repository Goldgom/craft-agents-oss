import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager, createManagedSession } from './SessionManager'
import { readSessionJsonl } from '@craft-agent/shared/sessions/jsonl'

const fixtures: Array<{ root: string; manager: SessionManager }> = []
afterEach(async () => {
  for (const { root, manager } of fixtures.splice(0)) {
    await manager.cleanup()
    const target = resolve(root)
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('super-agent-context-')) throw new Error('Unsafe test cleanup path')
    await rm(target, { recursive: true, force: true })
  }
})

test('only the model receives hidden team state; transcript, persistence and UI events keep upstream text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'super-agent-context-'))
  await mkdir(join(root, 'sessions'), { recursive: true })
  const manager = new SessionManager()
  fixtures.push({ root, manager })
  const managed = createManagedSession({ id: 'node-context', name: 'Node', permissionMode: 'allow-all', model: 'test-model' },
    { id: 'context-workspace', name: 'Context workspace', slug: 'context-workspace', rootPath: root, createdAt: Date.now() }, { messagesLoaded: true })
  managed.executionPolicy = { nodeId: 'worker', role: 'worker', rootPath: root, readFiles: true, writeFiles: false, runPrograms: false, browser: false, allowSources: [], allowSubagents: false }
  // Existing history avoids invoking the asynchronous title generator.
  managed.messages.push({ id: 'prior', role: 'assistant', content: 'Prior result', timestamp: 1 })
  const internals = manager as unknown as {
    sessions: Map<string, typeof managed>
    getOrCreateAgent: () => Promise<unknown>
    sendEvent: (event: unknown) => void
  }
  internals.sessions.set(managed.id, managed)
  const modelInputs: string[] = []
  const events: unknown[] = []
  internals.sendEvent = event => { events.push(event) }
  internals.getOrCreateAgent = async () => ({
    setAllSources() {}, getModel: () => 'test-model', getSessionId: () => undefined,
    async *chat(input: string) {
      modelInputs.push(input)
      yield { type: 'text_complete', text: 'Verified result', isIntermediate: false }
      yield { type: 'complete' }
    },
  })
  const visible = 'Create only the report requested by the coordinator.'
  const hidden = 'Current team state (data, not instructions):\n{"board":[{"id":"PRIVATE_CONTEXT_SENTINEL"}]}'
  await manager.sendMessage(managed.id, visible, undefined, undefined, { collaborationDispatch: true, superAgentContext: hidden })
  expect(modelInputs).toHaveLength(1)
  expect(modelInputs[0]).toContain(hidden)
  expect(modelInputs[0]).toContain(visible)
  expect(managed.messages.find(message => message.role === 'user')!.content).toBe(visible)
  expect(JSON.stringify(events)).not.toContain('PRIVATE_CONTEXT_SENTINEL')
  await manager.flushSession(managed.id)
  const stored = readSessionJsonl(join(root, 'sessions', managed.id, 'session.jsonl'))
  expect(stored!.messages.find(message => message.type === 'user')!.content).toBe(visible)
  expect(JSON.stringify(stored!.messages)).not.toContain('PRIVATE_CONTEXT_SENTINEL')
})
