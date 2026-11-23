import { expect, test } from 'bun:test'
import type { Message } from '../../../../shared/types'
import { findVoiceReply, latestVoiceRequest, playVoice, voicePassages } from '../voice-audio'

const message = (id: string, role: Message['role'], overrides: Partial<Message> = {}): Message =>
  ({ id, role, content: id, timestamp: 0, ...overrides })

test('voice selects only the latest confirmed visible reply to the current prompt', () => {
  const messages = [
    message('old', 'user'), message('old-reply', 'assistant'), message('new', 'user'),
    message('live', 'assistant', { isStreaming: true }),
    message('progress', 'assistant', { isIntermediate: true }),
    message('child', 'assistant', { parentToolUseId: 'tool' }),
    message('hidden-user', 'user', { hidden: true }),
  ]
  const user = latestVoiceRequest(messages)
  expect(user).toBe('new')
  expect(findVoiceReply(messages, user)).toBeUndefined()
  const final = message('final', 'assistant')
  expect(findVoiceReply([...messages, final], user)).toBe(final)
  expect(findVoiceReply([...messages, final, message('error', 'error')], user)).toBeUndefined()
  expect(findVoiceReply(messages, 'old')).toBeUndefined()
})

test('speech splits at sentences and bounds Unicode clips for the voice transport', () => {
  const first = '一'.repeat(48) + '。'
  const second = '二'.repeat(48) + '！'
  expect([...voicePassages(first + second)]).toEqual([first, second])
  const text = '😀'.repeat(600)
  const chunks = [...voicePassages(text)]
  expect(chunks.map(chunk => Array.from(chunk).length)).toEqual([260, 260, 80])
  expect(chunks.join('')).toBe(text)
})

test('prefetches one clip, plays in order, and stops on cancellation', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const events: string[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
    tokenNestVoice: async (_action: string, passage: string) => {
      events.push('tts:' + passage[0])
      return btoa(passage[0]!)
    },
  } } })
  const sources: Array<{ onended: (() => void) | null }> = []
  const context = {
    decodeAudioData: async (bytes: ArrayBuffer) => String.fromCharCode(new Uint8Array(bytes)[0]!),
    createBufferSource: () => {
      const source = { buffer: '', onended: null, connect() {}, disconnect() {},
        start() { events.push('play:' + this.buffer) },
        stop() { events.push('stop:' + this.buffer) },
      }
      sources.push(source)
      return source
    },
  } as unknown as AudioContext
  const controller = new AbortController()
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  try {
    const play = playVoice('A'.repeat(46) + '! ' + 'B'.repeat(46) + '! ' + 'C'.repeat(46), context, undefined, controller.signal)
    const outcome = play.catch(error => error)
    await settle()
    expect(events).toEqual(['tts:A', 'play:A', 'tts:B'])
    sources[0]!.onended!()
    await settle()
    expect(events).toEqual(['tts:A', 'play:A', 'tts:B', 'play:B', 'tts:C'])
    controller.abort()
    expect(await outcome).toBe(controller.signal.reason)
    expect(events.at(-1)).toBe('stop:B')
    expect(events).not.toContain('play:C')
  } finally {
    controller.abort()
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
