import { McpClientPool } from '../../mcp-pool.ts'
import type { PoolCallToolOptions, PoolClient } from '../../client.ts'

export function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export const config = (tag: string) => ({
  type: 'http' as const, url: 'http://127.0.0.1:1/never-opened', headers: { 'X-Dummy-Generation': tag },
})

export interface Handshake {
  client: PoolClient
  slug: string
  gate: ReturnType<typeof deferred>
  closeGate?: ReturnType<typeof deferred>
  closes: number
  calls: Array<{ name: string; options?: PoolCallToolOptions }>
  callGate?: ReturnType<typeof deferred>
}

/** Keep real pool/limiter ownership; replace only each client's transport I/O. */
export class ControllablePool extends McpClientPool {
  records: Handshake[] = []
  private changed = deferred()
  constructor(private toolName?: string, options?: ConstructorParameters<typeof McpClientPool>[0]) { super(options) }
  override async registerClient(slug: string, client: PoolClient): Promise<void> {
    const index = this.records.length
    const record: Handshake = { client, slug, gate: deferred(), closes: 0, calls: [] }
    this.records.push(record)
    const changed = this.changed
    this.changed = deferred()
    changed.resolve()
    client.listTools = async () => {
      await record.gate.promise
      return [{ name: this.toolName ?? `tool_${index}`, inputSchema: { type: 'object', properties: {} } }]
    }
    client.callTool = async (name, _args, options) => {
      record.calls.push({ name, options })
      await record.callGate?.promise
      return { content: [{ type: 'text', text: `client_${index}` }] }
    }
    client.close = async () => { record.closes++; await record.closeGate?.promise }
    await super.registerClient(slug, client)
  }
  getConfig(slug: string) { return this.activeConfigs.get(slug) }
  async started(count: number) {
    while (this.records.length < count) await this.changed.promise
  }
  releaseAll() {
    for (const record of this.records) {
      record.gate.resolve()
      record.closeGate?.resolve()
      record.callGate?.resolve()
    }
  }
}
