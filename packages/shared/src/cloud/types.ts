/** Public contract shared by desktop, headless hosts and the cloud relay. */
export const DEFAULT_CLOUD_URL = 'https://agent.tokenbird.goldgom.top'

export interface CloudConfig {
  serverUrl: string
  connectionSlug: string
  deviceName: string
  remoteEnabled: boolean
}
export interface CloudDevice {
  id: string
  name: string
  online: boolean
  lastSeen: number
  wsUrl: string
}
export interface CloudStatus {
  deviceId: string
  connected: boolean
  error?: string
}
export interface CloudShare {
  id: string
  title: string
  url: string
  createdAt: number
}
export type TunnelFrame =
  | { type: 'capabilities'; direct: boolean }
  | { type: 'open'; streamId: string; iceServers?: CloudIceServer[] }
  | { type: 'data'; streamId: string; data: string }
  | { type: 'close'; streamId: string }
  | { type: 'signal'; streamId: string; signal: CloudSignal }

export interface CloudIceServer { urls: string }
export type CloudDataPath = 'direct' | 'relay'
export type CloudSignal =
  | { action: 'negotiate'; iceServers: CloudIceServer[] }
  | { action: 'offer' | 'answer'; sdp: string }
  | { action: 'select' | 'selected'; mode: CloudDataPath }
  | { action: 'keepalive' | 'keepalive_ack' }

export const DEFAULT_CLOUD_ICE_SERVERS: CloudIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }]
export const CLOUD_DIRECT_TIMEOUT_MS = 8_000
export const CLOUD_MAX_MESSAGE_BYTES = 16 * 1024 * 1024

/** STUN only: failed direct connections use the existing authenticated relay. */
export function validateCloudIceServers(value: unknown): value is CloudIceServer[] {
  return Array.isArray(value) && value.length <= 8 && value.every(server =>
    server && Object.keys(server).length === 1 && typeof server.urls === 'string' && server.urls.length <= 256
    && /^stuns?:[^\s/@?#]+(?::\d+)?$/.test(server.urls))
}

export function isCloudSignal(value: unknown): value is CloudSignal {
  if (!value || typeof value !== 'object') return false
  const signal = value as Record<string, unknown>
  if (signal.action === 'offer' || signal.action === 'answer') return typeof signal.sdp === 'string' && signal.sdp.length <= 64 * 1024
  if (signal.action === 'select' || signal.action === 'selected') return signal.mode === 'direct' || signal.mode === 'relay'
  if (signal.action === 'negotiate') return validateCloudIceServers(signal.iceServers)
  return signal.action === 'keepalive' || signal.action === 'keepalive_ack'
}

export function normalizeCloudUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Cloud server must be an origin URL')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Cloud server requires HTTPS (HTTP is supported on localhost for development)')
  }
  return url.origin
}
