import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Session } from '@craft-agent/shared/protocol'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import { BindingStore } from '../binding-store'
import { Commands, resolveCommand } from '../commands'
import type { IncomingMessage, MessagingConfig, PlatformAdapter, SentMessage } from '../types'

function makeSession(id: string, name: string, lastMessageAt: number): Session {
  return {
    id,
    name,
    workspaceId: 'ws1',
    workspaceName: 'Workspace',
    messages: [],
    createdAt: lastMessageAt - 1000,
    updatedAt: lastMessageAt,
    lastMessageAt,
    isArchived: false,
  } as unknown as Session
}

function makeSessionManager(sessions: Session[]): ISessionManager {
  return {
    getSessions: () => sessions,
    getSession: async (sessionId: string) => sessions.find((session) => session.id === sessionId) ?? null,
    createSession: async () => { throw new Error('not implemented') },
    sendMessage: async () => {},
    cancelProcessing: async () => {},
    respondToPermission: () => true,
  } as unknown as ISessionManager
}

function makeAdapter(platform: 'telegram' | 'whatsapp', inlineButtons: boolean): PlatformAdapter & { sent: string[] } {
  const sent: string[] = []
  return {
    platform,
    capabilities: {
      messageEditing: inlineButtons,
      inlineButtons,
      maxButtons: 10,
      maxMessageLength: 4096,
      markdown: platform === 'telegram' ? 'v2' : 'whatsapp',
      webhookSupport: false,
    },
    sent,
    async initialize() {},
    async destroy() {},
    isConnected() { return true },
    onMessage() {},
    onButtonPress() {},
    async sendText(_channelId: string, text: string): Promise<SentMessage> {
      sent.push(text)
      return { platform, channelId: 'chan-1', messageId: String(sent.length) }
    },
    async editMessage() {},
    async sendButtons(_channelId: string, text: string): Promise<SentMessage> {
      sent.push(text)
      return { platform, channelId: 'chan-1', messageId: String(sent.length) }
    },
    async sendTyping() {},
    async sendFile(): Promise<SentMessage> {
      return { platform, channelId: 'chan-1', messageId: String(sent.length + 1) }
    },
  }
}

function makeMessage(text: string): IncomingMessage {
  return {
    platform: 'whatsapp',
    channelId: 'chan-1',
    messageId: 'm1',
    senderId: 'u1',
    senderName: 'Alice',
    text,
    timestamp: Date.now(),
    raw: {},
  }
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeStore(): BindingStore {
  const dir = mkdtempSync(join(tmpdir(), 'commands-bind-'))
  tempDirs.push(dir)
  return new BindingStore(dir)
}

describe('Commands', () => {
  it('resolves configured aliases and preserves arguments', () => {
    expect(resolveCommand('/start Project Alpha', {
      commands: { new: { aliases: ['start', '/create'] } },
    })).toEqual({ name: 'new', args: 'Project Alpha', invokedAs: '/start' })
    expect(resolveCommand('/create@MyBot Project Beta', {
      commands: { new: { aliases: ['start', '/create'] } },
    })).toEqual({ name: 'new', args: 'Project Beta', invokedAs: '/create' })
  })

  it('does not resolve disabled commands or invalid aliases', () => {
    expect(resolveCommand('/new', { commands: { new: { enabled: false, aliases: ['start'] } } })).toBeNull()
    expect(resolveCommand('/start', { commands: { new: { enabled: false, aliases: ['start'] } } })).toBeNull()
    expect(resolveCommand('/bad-alias', { commands: { new: { aliases: ['bad-alias'] } } })).toBeNull()
  })

  it('uses custom help text and expands the enabled command list', async () => {
    const config: MessagingConfig = {
      enabled: true,
      platforms: {},
      commands: {
        helpMessage: 'Custom help\n{commands}',
        commands: { stop: { enabled: false }, new: { aliases: ['start'] } },
      },
    }
    const commands = new Commands(makeSessionManager([]), makeStore(), 'ws1', undefined, undefined, {
      getWorkspaceConfig: () => config,
      seedOwnerOnFirstPair: async () => [],
    })
    const adapter = makeAdapter('whatsapp', false)

    await commands.handleCommand(adapter, makeMessage('/help'))

    expect(adapter.sent[0]).toContain('Custom help')
    expect(adapter.sent[0]).toContain('/new [name] (aliases: /start)')
    expect(adapter.sent[0]).not.toContain('/stop')
  })

  it('can silently ignore unknown commands in an unbound chat', async () => {
    const config: MessagingConfig = {
      enabled: true,
      platforms: {},
      commands: { unknownCommandBehavior: 'ignore' },
    }
    const commands = new Commands(makeSessionManager([]), makeStore(), 'ws1', undefined, undefined, {
      getWorkspaceConfig: () => config,
      seedOwnerOnFirstPair: async () => [],
    })
    const adapter = makeAdapter('whatsapp', false)

    await commands.handle(adapter, makeMessage('/does_not_exist'))

    expect(adapter.sent).toHaveLength(0)
  })

  it('binds by numbered recent-session index on non-inline platforms', async () => {
    const sessions = [
      makeSession('sess-1', 'Old', 100),
      makeSession('sess-2', 'Newest', 200),
    ]
    const store = makeStore()
    const commands = new Commands(makeSessionManager(sessions), store, 'ws1')
    const adapter = makeAdapter('whatsapp', false)

    await commands.handleCommand(adapter, makeMessage('/bind 1'))

    expect(store.findByChannel('whatsapp', 'chan-1')?.sessionId).toBe('sess-2')
    expect(adapter.sent.at(-1)).toContain('Newest')
  })

  it('lists numbered recent sessions with usable /bind instructions on WhatsApp', async () => {
    const sessions = [
      makeSession('sess-1', 'Alpha', 100),
      makeSession('sess-2', 'Beta', 200),
    ]
    const store = makeStore()
    const commands = new Commands(makeSessionManager(sessions), store, 'ws1')
    const adapter = makeAdapter('whatsapp', false)

    await commands.handleCommand(adapter, makeMessage('/bind'))

    expect(adapter.sent[0]).toContain('1. Beta (sess-2)')
    expect(adapter.sent[0]).toContain('/bind <number>')
  })
})
