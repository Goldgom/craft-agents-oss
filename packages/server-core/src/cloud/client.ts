import WebSocket from 'ws'
import { getLlmConnection } from '@craft-agent/shared/config'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { getValidTokenNestCredentials } from '../../../shared/src/auth/tokennest-oauth'
import { normalizeCloudUrl, type CloudConfig, type CloudStatus, type TunnelFrame } from '../../../shared/src/cloud/types'
import { loadCloudSettings, saveCloudConfig } from './storage'
import { CloudHostStream } from './host-stream'

export interface LocalCloudTarget { url: string; token: string; tlsCert?: string | Buffer }
export class CloudClient {
  private tunnel?: WebSocket
  private timer?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private generation = 0
  private enableOnce = false
  private abort?: AbortController
  private streams = new Map<string, CloudHostStream>()
  private state: CloudStatus = { deviceId: '', connected: false }
  constructor(private target: LocalCloudTarget) {}
  get config(): CloudConfig { return loadCloudSettings().config }
  get status(): CloudStatus { return { ...this.state, deviceId: loadCloudSettings().deviceId } }

  async request<T>(path: string, method = 'GET', body?: unknown, config = this.config, signal?: AbortSignal): Promise<T> {
    const connection = getLlmConnection(config.connectionSlug)
    if (connection?.oauthProvider !== 'tokennest') throw new Error('Select a signed-in TokenNest account in Cloud Server settings')
    const credentials = await getValidTokenNestCredentials(connection.slug, getCredentialManager())
    if (!credentials) throw new Error('Sign in to TokenNest again to use cloud services')
    const response = await fetch(normalizeCloudUrl(config.serverUrl) + path, {
      method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${credentials.accessToken}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (!response.ok) throw new Error(`Cloud service returned HTTP ${response.status}. Check the server and TokenNest integration.`)
    return await response.json() as T
  }

  start(): void {
    this.stop()
    if (!this.config.remoteEnabled) return
    const generation = this.generation
    this.abort = new AbortController()
    void this.connect(generation)
  }
  stop(): void {
    this.generation++
    this.abort?.abort()
    clearTimeout(this.timer)
    clearInterval(this.heartbeat)
    this.tunnel?.terminate()
    this.tunnel = undefined
    for (const stream of this.streams.values()) stream.close()
    this.streams.clear()
    this.state = { deviceId: loadCloudSettings().deviceId, connected: false }
  }
  async configure(config: CloudConfig): Promise<void> {
    const previous = loadCloudSettings()
    const wasEnabled = previous.config.remoteEnabled
    // Validate before disrupting an existing connection.
    normalizeCloudUrl(config.serverUrl)
    if (config.remoteEnabled && getLlmConnection(config.connectionSlug)?.oauthProvider !== 'tokennest') throw new Error('Select a TokenNest account')
    if (typeof config.deviceName !== 'string' || !config.deviceName.trim() || config.deviceName.trim().length > 120 || typeof config.remoteEnabled !== 'boolean') throw new Error('Invalid cloud settings')
    this.stop()
    let revocationFailed = false
    if (wasEnabled) {
      // Confirm cloud revocation before reporting a successful disable/change.
      try { await this.request(`/v1/devices/${previous.deviceId}`, 'DELETE', undefined, previous.config) } catch { revocationFailed = true }
    }
    saveCloudConfig(config)
    this.enableOnce = config.remoteEnabled
    this.start()
    if (revocationFailed && !config.remoteEnabled) this.state.error = 'Remote access is disabled on this device. Cloud revocation could not be confirmed; the cloud lease expires within 90 seconds.'
  }
  private async connect(generation: number): Promise<void> {
    const current = () => generation === this.generation
    try {
      const settings = loadCloudSettings()
      const registration = await this.request<{ tunnelUrl: string; tunnelToken: string }>('/v1/devices/register', 'POST', { deviceId: settings.deviceId, deviceSecret: settings.deviceSecret, name: settings.config.deviceName, enable: this.enableOnce }, settings.config, this.abort?.signal)
      if (!current()) return
      this.enableOnce = false
      const expected = new URL(settings.config.serverUrl)
      expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:'
      if (registration.tunnelUrl !== `${expected.origin}/v1/tunnel/${settings.deviceId}`) throw new Error('Invalid cloud tunnel endpoint')
      const tunnel = new WebSocket(registration.tunnelUrl, { headers: { Authorization: `Bearer ${registration.tunnelToken}` }, handshakeTimeout: 15_000, maxPayload: 16 * 1024 * 1024 })
      this.tunnel = tunnel
      tunnel.on('open', () => {
        if (!current()) { tunnel.terminate(); return }
        this.state = { deviceId: settings.deviceId, connected: true }
        tunnel.send(JSON.stringify({ type: 'capabilities', direct: true }))
        let pending = false
        this.heartbeat = setInterval(() => {
          if (!current() || pending) return
          pending = true
          void this.request(`/v1/devices/${settings.deviceId}/heartbeat`, 'POST', { deviceSecret: settings.deviceSecret }, settings.config, this.abort?.signal).catch(() => tunnel.terminate()).finally(() => { pending = false })
        }, 30_000)
        this.heartbeat.unref()
      })
      tunnel.on('message', raw => {
        if (!current()) return
        try { this.accept(JSON.parse(raw.toString()) as TunnelFrame, tunnel) } catch { tunnel.close(1008, 'Invalid tunnel message') }
      })
      tunnel.on('error', () => { if (current()) this.state = { deviceId: settings.deviceId, connected: false, error: 'Cloud connection failed. Check server availability and TokenNest integration.' } })
      tunnel.on('close', () => {
        if (!current()) return
        clearInterval(this.heartbeat)
        this.state.connected = false
        for (const stream of this.streams.values()) stream.close()
        this.streams.clear()
        this.retry(generation)
      })
    } catch (error) {
      if (!current()) return
      this.state = { deviceId: loadCloudSettings().deviceId, connected: false, error: error instanceof Error && /Select|Sign in|HTTP|endpoint/.test(error.message) ? error.message : 'Cloud connection failed. Check server availability and TokenNest integration.' }
      this.retry(generation)
    }
  }
  private retry(generation: number): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { if (generation === this.generation) void this.connect(generation) }, 10_000 + Math.random() * 5_000)
    this.timer.unref()
  }
  private accept(frame: TunnelFrame, tunnel: WebSocket): void {
    if (frame.type === 'capabilities') return
    if (typeof frame.streamId !== 'string' || !/^[a-f0-9-]{36}$/.test(frame.streamId)) throw new Error('Invalid stream')
    const send = (frame: TunnelFrame) => {
      if (tunnel.bufferedAmount > 16 * 1024 * 1024) { tunnel.terminate(); return }
      if (tunnel.readyState === WebSocket.OPEN) tunnel.send(JSON.stringify(frame))
    }
    if (frame.type === 'open') {
      if (this.streams.size >= 64 || this.streams.has(frame.streamId)) throw new Error('Stream capacity reached')
      const stream = new CloudHostStream(this.target,
        data => send({ type: 'data', streamId: frame.streamId, data }),
        signal => send({ type: 'signal', streamId: frame.streamId, signal }),
        () => { this.streams.delete(frame.streamId); send({ type: 'close', streamId: frame.streamId }) }, frame.iceServers)
      this.streams.set(frame.streamId, stream)
    } else if (frame.type === 'close') {
      this.streams.get(frame.streamId)?.close()
      this.streams.delete(frame.streamId)
    } else if (frame.type === 'signal') {
      void this.streams.get(frame.streamId)?.acceptSignal(frame.signal)
    } else if (frame.type === 'data') {
      const stream = this.streams.get(frame.streamId)
      if (!stream || typeof frame.data !== 'string') return
      stream.acceptData(frame.data)
    }
  }
}
