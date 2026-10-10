import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { getConfigDir } from '@craft-agent/shared/config/paths'
import { DEFAULT_CLOUD_URL, normalizeCloudUrl, type CloudConfig } from '../../../shared/src/cloud/types'

interface StoredCloud { config: CloudConfig; deviceId: string; deviceSecret: string }
export function loadCloudSettings(): StoredCloud {
  const path = join(getConfigDir(), 'cloud-server.json')
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'))
  const stored = { config: { serverUrl: DEFAULT_CLOUD_URL, connectionSlug: '', deviceName: hostname(), remoteEnabled: false }, deviceId: randomUUID(), deviceSecret: randomBytes(32).toString('hex') }
  writeCloudSettings(stored)
  return stored
}
function writeCloudSettings(stored: StoredCloud): void {
  const directory = getConfigDir()
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'cloud-server.json')
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(stored, null, 2), { mode: 0o600 })
  renameSync(temporary, path)
}
export function saveCloudConfig(config: CloudConfig): void {
  if (typeof config.connectionSlug !== 'string' || typeof config.deviceName !== 'string' || typeof config.remoteEnabled !== 'boolean') throw new Error('Invalid cloud settings')
  const name = config.deviceName.trim()
  if (!name || name.length > 120) throw new Error('Device name must contain 1–120 characters')
  const stored = loadCloudSettings()
  const identity = stored.config.connectionSlug && stored.config.connectionSlug !== config.connectionSlug ? { deviceId: randomUUID(), deviceSecret: randomBytes(32).toString('hex') } : {}
  writeCloudSettings({ ...stored, ...identity, config: { serverUrl: normalizeCloudUrl(config.serverUrl), connectionSlug: config.connectionSlug, deviceName: name, remoteEnabled: config.remoteEnabled } })
}
