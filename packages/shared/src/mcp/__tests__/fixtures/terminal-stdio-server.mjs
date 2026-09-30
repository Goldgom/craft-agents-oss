// Owned stdio-only MCP fixture. Every side effect is confined to its temp dir.
import { appendFileSync, existsSync, unlinkSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [logPath, exitPath, mode] = process.argv.slice(2)
const record = event => appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...event }) + '\n')
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
record({ event: 'spawn' })
process.on('exit', code => record({ event: 'exit', code }))
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('close', () => process.exit(0))
setInterval(() => {
  if (existsSync(exitPath)) { unlinkSync(exitPath); process.exit(17) }
}, 5)
lines.on('line', line => {
  const message = JSON.parse(line)
  const args = message.params?.arguments ?? {}
  record({ event: 'wire', method: message.method, token: args.token })
  if (message.method === 'initialize') {
    if (mode === 'exit-initialize') process.exit(17)
    send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'terminal-stdio-fixture', version: '1' } } })
  } else if (message.method === 'tools/list') {
    send({ id: message.id, result: { tools: [{ name: 'act', inputSchema: { type: 'object', properties: {} } }] } })
  } else if (message.method === 'tools/call') {
    if (args.action === 'crash') {
      record({ event: 'mutation', token: args.token })
      process.exit(17)
    }
    if (args.action === 'hold') return
    if (args.action === 'rpc-error') send({ id: message.id, error: { code: -32005, message: 'fixture request failure' } })
    else send({ id: message.id, result: { content: [{ type: 'text', text: args.token ?? 'ok' }], isError: args.action === 'tool-error' } })
  }
})
