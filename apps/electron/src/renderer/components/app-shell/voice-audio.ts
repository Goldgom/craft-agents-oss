import type { Message } from '../../../shared/types'

export function encodeVoiceWav(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const write = (offset: number, text: string) => bytes.set(new TextEncoder().encode(text), offset)
  write(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  write(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((sample, i) => {
    const value = Math.min(1, Math.max(-1, sample))
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
  })
  return bytes
}

export async function transcribeRecording(blob: Blob, slug: string | undefined, signal: AbortSignal) {
  const decoder = new OfflineAudioContext(1, 1, 16000)
  const decoded = await decoder.decodeAudioData(await blob.arrayBuffer())
  signal.throwIfAborted()
  if (!decoded.length || decoded.duration > 120) throw new Error('Invalid recording duration')
  const wav = encodeVoiceWav(decoded.getChannelData(0))
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1]!)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(new Blob([wav]))
  })
  signal.throwIfAborted()
  return window.electronAPI.tokenNestVoice('asr', base64, slug)
}

export function latestVoiceRequest(messages: Message[]): string | undefined {
  return messages.findLast(message => message.role === 'user' && !message.hidden)?.id
}

export function findVoiceReply(messages: Message[], userId: string | undefined): Message | undefined {
  if (userId == null) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.id === userId || message.role === 'error' || message.role === 'user' && !message.hidden) return undefined
    if (message.role === 'assistant' && !message.hidden && !message.isError && !message.isStreaming
      && !message.isPending && !message.isIntermediate && !message.parentToolUseId && message.content.trim()) return message
  }
  return undefined
}

/** Keep each WAV within the RPC frame budget. Prefer natural breaks over cutting words. */
export function* voicePassages(text: string): Generator<string> {
  const characters = Array.from(text.trim())
  const limit = 260
  for (let offset = 0; offset < characters.length;) {
    const span = characters.slice(offset, offset + limit)
    let stop = span.findIndex((char, index) => index >= 40 && (
      /[。！？!?\n]/u.test(char) || char === '.' && /\s/u.test(span[index + 1] ?? '')
    ))
    if (stop < 0 && span.length === limit && offset + span.length < characters.length) {
      stop = span.findLastIndex((char, index) => index >= 40 && /\s/u.test(char))
    }
    const length = stop >= 0 ? stop + 1 : span.length
    const passage = span.slice(0, length).join('').trim()
    offset += length
    if (passage) yield passage
  }
}

export async function playVoice(text: string, context: AudioContext, slug: string | undefined, signal: AbortSignal) {
  async function synthesize(passage: string) {
    signal.throwIfAborted()
    const encoded = await window.electronAPI.tokenNestVoice('tts', passage, slug)
    signal.throwIfAborted()
    const buffer = Uint8Array.from(atob(encoded), char => char.charCodeAt(0))
    return context.decodeAudioData(buffer.buffer)
  }

  const passages = voicePassages(text)
  const first = passages.next()
  if (first.done) return
  let decoded = await synthesize(first.value)
  for (const passage of passages) {
    // Only the next clip is requested ahead of time, while the current one plays.
    const [, next] = await Promise.all([playClip(decoded, context, signal), synthesize(passage)])
    decoded = next
  }
  await playClip(decoded, context, signal)
}

function playClip(audio: AudioBuffer, context: AudioContext, signal: AbortSignal) {
  signal.throwIfAborted()
  const source = context.createBufferSource()
  source.buffer = audio
  source.connect(context.destination)
  return new Promise<void>((resolve, reject) => {
    const cleanUp = () => {
      source.onended = null
      source.disconnect()
      signal.removeEventListener('abort', abort)
    }
    const abort = () => {
      source.onended = null
      source.stop()
      cleanUp()
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    source.onended = () => { cleanUp(); resolve() }
    try { source.start() }
    catch (error) { cleanUp(); reject(error) }
  })
}
