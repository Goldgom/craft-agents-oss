import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import { CloudClient, type LocalCloudTarget } from '../../cloud/client'
import type { CloudConfig, CloudDevice, CloudShare } from '../../../../shared/src/cloud/types'

export const HANDLED_CHANNELS = Object.values(RPC_CHANNELS.cloud)
export function registerCloudHandlers(server: RpcServer, deps: HandlerDeps, target: LocalCloudTarget): CloudClient {
  const client = new CloudClient(target)
  let saving = false
  server.handle(RPC_CHANNELS.cloud.GET_CONFIG, async () => client.config)
  server.handle(RPC_CHANNELS.cloud.SET_CONFIG, async (_ctx, config: CloudConfig) => {
    if (saving) throw new Error('Cloud settings are being saved')
    saving = true
    try { await client.configure(config) } finally { saving = false }
  })
  server.handle(RPC_CHANNELS.cloud.GET_STATUS, async () => client.status)
  server.handle(RPC_CHANNELS.cloud.LIST_DEVICES, async () => client.request<CloudDevice[]>('/v1/devices'))
  server.handle(RPC_CHANNELS.cloud.CONNECT_DEVICE, async (_ctx, id: string) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid device ID')
    const result = await client.request<{ url: string; token: string; expiresAt: number }>(`/v1/devices/${id}/connect`, 'POST')
    const expected = client.config.serverUrl.replace(/^http/, 'ws') + `/v1/connect/${id}`
    if (result.url !== expected) throw new Error('Invalid device endpoint')
    return result
  })
  server.handle(RPC_CHANNELS.cloud.LIST_SHARES, async () => client.request<CloudShare[]>('/v1/shares'))
  server.handle(RPC_CHANNELS.cloud.REVOKE_SHARE, async (_ctx, id: string) => {
    if (!/^[A-Za-z0-9_-]{32}$/.test(id)) throw new Error('Invalid share ID')
    return client.request(`/v1/shares/${id}`, 'DELETE')
  })
  server.handle(RPC_CHANNELS.cloud.SHARE_CHAT, async (_ctx, sessionId: string) => {
    const session = await deps.sessionManager.getSession(sessionId)
    if (!session) throw new Error('Session not found')
    const messages = session.messages.filter(m => (m.role === 'user' || m.role === 'assistant') && !m.isIntermediate && m.content).map(m => ({ role: m.role, content: m.content }))
    if (!messages.length) throw new Error('This chat has no messages to share')
    return client.request<CloudShare>('/v1/shares', 'POST', { title: session.name || 'TokenBird Chat', messages })
  })
  return client
}
