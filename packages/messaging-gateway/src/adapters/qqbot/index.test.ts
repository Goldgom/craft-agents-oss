import { describe, expect, test } from 'bun:test'
import { QQBotAdapter, normalizeQQBotCredentials, parseQQBotCredentials } from './index'

describe('normalizeQQBotCredentials', () => {
  test('accepts the AppSecret displayed by the current QQ console', () => {
    expect(normalizeQQBotCredentials('123456', ' app-secret ')).toEqual({ appId: '123456', token: 'app-secret' })
  })

  test('keeps the secret opaque instead of treating it as a legacy AppToken', () => {
    expect(normalizeQQBotCredentials('123456', 'Bot 123456.app-token')).toEqual({ appId: '123456', token: 'Bot 123456.app-token' })
  })

  test('parses credentials persisted as a JSON string', () => {
    expect(parseQQBotCredentials(JSON.stringify({ appId: '123456', token: 'app-secret' }))).toEqual({ appId: '123456', token: 'app-secret' })
  })
})

describe('QQBotAdapter media sending', () => {
  test('forwards voice data and reply context to the official SDK worker', async () => {
    const adapter = new QQBotAdapter()
    const internal = adapter as unknown as {
      scopes: Map<string, 'c2c' | 'group'>
      replyMessageIds: Map<string, string>
      send(command: Record<string, unknown>): void
      onEvent(event: Record<string, unknown>): void
    }
    internal.scopes.set('group-openid', 'group')
    internal.replyMessageIds.set('group-openid', 'incoming-message-id')

    let sentCommand: Record<string, unknown> | undefined
    internal.send = (command) => {
      sentCommand = command
      queueMicrotask(() => internal.onEvent({ type: 'send_result', id: command.id, ok: true, messageId: 'media-message-id' }))
    }

    const result = await adapter.sendMedia?.('group-openid', 'voice', Buffer.from('voice-bytes'), 'voice.mp3')

    expect(sentCommand).toMatchObject({
      type: 'send_media',
      channelId: 'group-openid',
      scope: 'group',
      replyMessageId: 'incoming-message-id',
      kind: 'voice',
      filename: 'voice.mp3',
      dataBase64: Buffer.from('voice-bytes').toString('base64'),
    })
    expect(result).toEqual({ platform: 'qqbot', channelId: 'group-openid', messageId: 'media-message-id' })
  })

  test('forwards generic files and captions to the official SDK worker', async () => {
    const adapter = new QQBotAdapter()
    const internal = adapter as unknown as {
      send(command: Record<string, unknown>): void
      onEvent(event: Record<string, unknown>): void
    }
    let sentCommand: Record<string, unknown> | undefined
    internal.send = (command) => {
      sentCommand = command
      queueMicrotask(() => internal.onEvent({ type: 'send_result', id: command.id, ok: true, messageId: 'file-message-id' }))
    }

    await adapter.sendFile('user-openid', Buffer.from('file-bytes'), 'report.pdf', 'Report')

    expect(sentCommand).toMatchObject({
      type: 'send_media',
      channelId: 'user-openid',
      scope: 'c2c',
      kind: 'file',
      filename: 'report.pdf',
      caption: 'Report',
    })
  })
})
