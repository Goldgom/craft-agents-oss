#!/usr/bin/env bun
import { join } from 'node:path'
import { startCloudServer } from './server'
import { DEFAULT_CLOUD_URL, normalizeCloudUrl } from '../../shared/src/cloud/types'

const tokenNestUrl = normalizeCloudUrl(process.env.TOKENNEST_URL ?? 'https://openai.goldgom.top')
const serviceKey = process.env.TOKENBIRD_CLOUD_SERVICE_KEY
if (!serviceKey || serviceKey.length < 32 || serviceKey.trim() !== serviceKey || /[\r\n]/.test(serviceKey)) throw new Error('TOKENBIRD_CLOUD_SERVICE_KEY must contain at least 32 characters; configure the same key on TokenNest')
async function tokenNest(path: string, body: unknown) {
  const response = await fetch(tokenNestUrl + path, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
  if (response.status === 401 || response.status === 403) throw new Error('Authentication required')
  if (!response.ok) throw new Error('TokenNest integration unavailable')
  const payload = await response.json() as { success?: boolean; data?: unknown }
  if (payload.success === false || !payload.data) throw new Error('TokenNest integration unavailable')
  return payload.data
}
const cloud = startCloudServer({
  publicUrl: process.env.TOKENBIRD_CLOUD_PUBLIC_URL ?? DEFAULT_CLOUD_URL,
  hostname: process.env.TOKENBIRD_CLOUD_HOST ?? '0.0.0.0',
  port: Number(process.env.TOKENBIRD_CLOUD_PORT ?? 8080),
  databasePath: join(process.env.TOKENBIRD_CLOUD_DATA_DIR ?? './data', 'cloud.sqlite'),
  webuiDir: process.env.TOKENBIRD_CLOUD_WEBUI_DIR ?? './webui',
  serviceKey,
  authenticate: async accessToken => {
    const result = await tokenNest('/api/internal/tokenbird/identity', { access_token: accessToken }) as { subject: string; expires_at: number }
    return { subject: result.subject, expiresAt: result.expires_at }
  },
  recordDevice: async (owner, device) => { await tokenNest('/api/internal/tokenbird/devices/upsert', { subject: owner, device }) },
})
console.log(`TokenBird 云服务器端 listening on ${cloud.server.hostname}:${cloud.server.port}`)
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { cloud.stop(); process.exit(0) })
