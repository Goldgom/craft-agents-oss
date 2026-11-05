/** Real process boundary: write succeeds and its private receipt is synced, then
 * the host exits before receiving a tool_result or completing the model turn. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SuperAgentService, type SuperAgentSessionHost } from '../SuperAgentService'
import { completeReceipt } from '../SuperAgentReceiptArchive'

const [root, configPath] = process.argv.slice(2) as [string, string]
const config = JSON.parse(await readFile(configPath, 'utf8'))
const sessions = new Map<string, { id: string; workspaceId: string; isProcessing: boolean }>()
let service: SuperAgentService
const host: SuperAgentSessionHost = {
  async createSession(workspaceId) {
    const id = `crash-session-${sessions.size + 1}`
    sessions.set(id, { id, workspaceId, isProcessing: false })
    return { id }
  },
  async getSession(id) { return sessions.get(id) ?? null },
  async sendMessage(sessionId) {
    sessions.get(sessionId)!.isProcessing = true
    const path = join(config.environment.workingDirectory, 'effect-count.txt')
    await service.prepareNodeOperation('alpha', sessionId, { toolName: 'Write', input: { file_path: path, content: '1' }, invocationId: 'actual-write' })
    await writeFile(path, '1')
    const operation = (await service.get('alpha')).state.operations![0]!
    await completeReceipt(join(root, 'alpha'), 'alpha', operation, 'File written', false, Date.now())
    process.exit(0)
  },
  async cancelProcessing(id) { const session = sessions.get(id); if (session) session.isProcessing = false },
  onSessionComplete() { return () => {} },
  getSessionFinalText() { return undefined },
  applySessionPolicy() {},
  async ensureSuperAgentSessionSettings() {},
}
service = new SuperAgentService({ host, rootForWorkspace: id => join(root, id), autoTick: false })
await service.save('alpha', config)
await service.command('alpha', { type: 'task', id: 'crash-job', title: 'One write', instructions: 'Preserve the existing file and finish the remaining verification.', nodeId: 'worker', resources: ['repository'] })
