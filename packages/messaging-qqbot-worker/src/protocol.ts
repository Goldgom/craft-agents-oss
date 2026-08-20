export type WorkerCommand =
  | { type: 'start'; appId: string; appSecret: string }
  | { type: 'send_text'; id: string; channelId: string; scope: 'c2c' | 'group'; text: string; replyMessageId?: string }
  | {
      type: 'send_media'
      id: string
      channelId: string
      scope: 'c2c' | 'group'
      kind: 'voice' | 'image' | 'video' | 'file'
      dataBase64: string
      filename: string
      caption?: string
      replyMessageId?: string
    }
  | { type: 'shutdown' }

export type WorkerEvent =
  | { type: 'ready' }
  | { type: 'connected' }
  | { type: 'incoming'; channelId: string; scope: 'c2c' | 'group'; messageId: string; senderId: string; text: string; timestamp: number; raw?: unknown }
  | { type: 'send_result'; id: string; ok: boolean; messageId?: string; error?: string }
  | { type: 'error'; message: string }
  | { type: 'unavailable'; message: string }

export function encodeMessage(msg: WorkerCommand | WorkerEvent): string { return JSON.stringify(msg) + '\n' }
export function parseFrames<T>(buffer: string): { messages: T[]; rest: string } {
  const messages: T[] = []; let rest = buffer
  while (true) {
    const nl = rest.indexOf('\n'); if (nl < 0) break
    const line = rest.slice(0, nl).trim(); rest = rest.slice(nl + 1)
    if (!line) continue
    try { messages.push(JSON.parse(line) as T) } catch { /* ignore malformed frames */ }
  }
  return { messages, rest }
}
