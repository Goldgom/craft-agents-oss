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
  | { type: 'open'; streamId: string }
  | { type: 'data'; streamId: string; data: string }
  | { type: 'close'; streamId: string }

export function normalizeCloudUrl(value: string): string {
  const url = new URL(value.trim())
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Cloud server must be an origin URL')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Cloud server requires HTTPS (HTTP is supported on localhost for development)')
  }
  return url.origin
}
