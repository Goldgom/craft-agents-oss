import { QQBot } from '@tencent-connect/qqbot-nodejs'
import { encodeMessage, parseFrames, type WorkerCommand, type WorkerEvent } from './protocol.js'

let bot: QQBot | null = null
let shuttingDown = false
const emit = (event: WorkerEvent) => process.stdout.write(encodeMessage(event))

async function handle(command: WorkerCommand): Promise<void> {
  if (command.type === 'shutdown') {
    shuttingDown = true
    bot?.stop()
    process.exit(0)
  }
  if (command.type === 'send_text') {
    if (!bot) { emit({ type: 'send_result', id: command.id, ok: false, error: 'QQ Bot worker is not connected' }); return }
    try {
      const result = await bot.sendText({ scope: command.scope, targetId: command.channelId }, command.text)
      emit({ type: 'send_result', id: command.id, ok: true, messageId: String((result as { id?: string }).id ?? '') })
    } catch (error) {
      emit({ type: 'send_result', id: command.id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (command.type !== 'start') return
  try {
    const logger = { info: (...args: unknown[]) => console.error('[qqbot-sdk]', ...args), warn: (...args: unknown[]) => console.error('[qqbot-sdk]', ...args), error: (...args: unknown[]) => console.error('[qqbot-sdk]', ...args), debug: (...args: unknown[]) => console.error('[qqbot-sdk]', ...args) }
    bot = new QQBot({ appId: command.appId, appSecret: command.appSecret, logger })
    bot.on('ready', () => emit({ type: 'connected' }))
    bot.on('error', (error) => emit({ type: 'error', message: error instanceof Error ? error.message : String(error) }))
    bot.on('message', async (_ctx, message) => {
      emit({
        type: 'incoming', scope: message.replyTarget.scope, channelId: message.replyTarget.targetId,
        messageId: String(message.messageId ?? ''), senderId: String(message.senderId ?? ''),
        text: String(message.content ?? '').trim(), timestamp: Date.now(), raw: message,
      })
    })
    await bot.start()
    emit({ type: 'ready' })
  } catch (error) {
    if (!shuttingDown) emit({ type: 'unavailable', message: error instanceof Error ? error.message : String(error) })
  }
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  const parsed = parseFrames<WorkerCommand>(input); input = parsed.rest
  for (const command of parsed.messages) void handle(command)
})
process.on('uncaughtException', (error) => emit({ type: 'error', message: error.message }))
process.on('unhandledRejection', (error) => emit({ type: 'error', message: String(error) }))
