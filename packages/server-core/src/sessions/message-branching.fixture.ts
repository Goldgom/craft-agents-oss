// Launched in an isolated process by message-branching.integration.test.ts.
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager'
import { createSession, saveSession, loadSession, listSessions, getSessionPath, deleteSession } from '@craft-agent/shared/sessions'

const root = process.env.TOKENBIRD_CONFIG_DIR!
const workspaceRoot = join(root, 'workspace')
const workspace = { id: 'branch-test', name: 'Branch Test', slug: 'branch-test', rootPath: workspaceRoot, createdAt: 1 }
await mkdir(workspaceRoot, { recursive: true })
await copyFile(join(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json'), join(root, 'config-defaults.json'))
await writeFile(join(workspaceRoot, 'config.json'), JSON.stringify({ ...workspace, defaults: { defaultLlmConnection: 'test', model: 'claude-sonnet-4-6' } }))
await writeFile(join(root, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id,
  defaultLlmConnection: 'test', llmConnections: [{ slug: 'test', name: 'Test', providerType: 'anthropic', authType: 'api_key', defaultModel: 'claude-sonnet-4-6' }] }))

const source = await createSession(workspaceRoot, { name: 'Parent', llmConnection: 'test' })
const stored = loadSession(workspaceRoot, source.id)!
const attachmentPath = join(getSessionPath(workspaceRoot, source.id), 'attachments', 'original.txt')
await mkdir(join(getSessionPath(workspaceRoot, source.id), 'attachments'), { recursive: true })
await writeFile(attachmentPath, 'attached content')
stored.messages = [
  { id: 'first', type: 'user', content: 'first question', timestamp: 1 },
  { id: 'reply', type: 'assistant', content: 'first answer', timestamp: 2 },
  { id: 'edit-node', type: 'user', content: 'original question', timestamp: 3,
    attachments: [{ id: 'file', type: 'text', name: 'original.txt', mimeType: 'text/plain', size: 16, storedPath: attachmentPath }] },
  { id: 'later', type: 'assistant', content: 'must not appear in branch', timestamp: 4,
    attachments: [{ id: 'missing', type: 'text', name: 'missing.txt', mimeType: 'text/plain', size: 1, storedPath: join(getSessionPath(workspaceRoot, source.id), 'attachments', 'missing.txt') }] },
]
await saveSession(stored)

function managerFromDisk() {
  const manager = new SessionManager()
  manager.setEventSink(() => {})
  const internals = manager as any
  for (const header of listSessions(workspaceRoot)) internals.sessions.set(header.id, createManagedSession(header, workspace))
  return { manager, internals }
}
const { manager, internals } = managerFromDisk()
const replayed: Array<{ id: string; text: string; attachments: any[] | undefined; callerClientId?: string }> = []
manager.sendMessage = async (id, text, attachments, _stored, _options, _existing, _retry, _ack, rpcContext) => {
  replayed.push({ id, text, attachments, callerClientId: rpcContext?.callerClientId })
}

const children = await Promise.all(Array.from({ length: 10 }, (_, index) => manager.createSession(workspace.id, {
  branchFromSessionId: source.id, branchFromMessageId: 'edit-node', editedMessageContent: `edited ${index}`,
  llmConnection: 'test', model: 'claude-sonnet-4-6', name: `Branch ${index}`,
}, { callerClientId: 'editing-device' })))
await new Promise(resolve => setTimeout(resolve, 100))
assert.equal(replayed.length, 10)
assert.equal(replayed[0]!.attachments?.[0]?.text, 'attached content')
assert.equal(replayed[0]!.callerClientId, 'editing-device')
for (const child of children) {
  const saved = loadSession(workspaceRoot, child.id)!
  assert.equal(saved.branchFromMessageId, 'edit-node')
  assert.equal(saved.branchFromSessionId, source.id)
  assert.equal(saved.branchFromSdkSessionId, undefined)
  assert.equal(saved.messages.length, 3)
  assert.equal(saved.messages[2]!.content.startsWith('edited '), true)
  assert.notEqual(saved.messages[2]!.id, 'edit-node')
  assert.equal(saved.messages[2]!.attachments![0]!.storedPath.includes(child.id), true)
  assert.equal(await readFile(saved.messages[2]!.attachments![0]!.storedPath, 'utf8'), 'attached content')
}
assert.equal(loadSession(workspaceRoot, source.id)!.messages[2]!.content, 'original question')
await assert.rejects(manager.createSession(workspace.id, { branchFromSessionId: source.id, branchFromMessageId: 'edit-node', editedMessageContent: 'eleventh' }), /MESSAGE_BRANCH_LIMIT/)

const restored = managerFromDisk()
assert.equal(restored.internals.sessions.get(children[0]!.id).branchContextStrategy, 'seeded-fresh-session')
await assert.rejects(restored.manager.createSession(workspace.id, { branchFromSessionId: source.id, branchFromMessageId: 'edit-node', editedMessageContent: 'after restart' }), /MESSAGE_BRANCH_LIMIT/)
const assistantChild = await manager.createSession(workspace.id, { branchFromSessionId: source.id, branchFromMessageId: 'reply', editedMessageContent: 'edited reply', llmConnection: 'test' })
assert.equal(assistantChild.messages.at(-1)?.role, 'assistant')
assert.equal(assistantChild.messages.at(-1)?.content, 'edited reply')
assert.equal(assistantChild.messages.length, 2)
await new Promise(resolve => setTimeout(resolve, 100))
assert.equal(replayed.length, 10)
const countBeforeFailure = listSessions(workspaceRoot).length
await assert.rejects(manager.createSession(workspace.id, { branchFromSessionId: source.id, branchFromMessageId: 'later', editedMessageContent: 'copy fails', llmConnection: 'test' }), /ENOENT/)
assert.equal(listSessions(workspaceRoot).length, countBeforeFailure)

// Removing the source must not remove the child's attached files.
deleteSession(workspaceRoot, source.id)
assert.equal(await readFile(loadSession(workspaceRoot, children[0]!.id)!.messages[2]!.attachments![0]!.storedPath, 'utf8'), 'attached content')
await manager.cleanup()
await restored.manager.cleanup()
console.log('BRANCH_SMOKE_OK')
