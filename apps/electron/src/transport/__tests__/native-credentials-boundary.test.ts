import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NATIVE_CREDENTIAL_IPC } from '@craft-agent/shared/credentials/native-types'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { CHANNEL_MAP } from '../channel-map'

const nativeMethods = {
  getNativeCredentialStatus: 'STATUS',
  listNativeCredentials: 'LIST',
  applyNativeCredentialChanges: 'APPLY',
  migrateNativeCredentials: 'MIGRATE',
} as const

describe('native credential preload boundary', () => {
  it('uses direct native IPC for exactly four management methods without an RPC fallback', () => {
    const preload = readFileSync(resolve(import.meta.dir, '../../preload/bootstrap.ts'), 'utf8')
    for (const [method, channel] of Object.entries(nativeMethods)) {
      const declaration = preload.split('\n').find(line => line.startsWith(`;(api as ElectronAPI).${method} =`))
      expect(declaration).toBeDefined()
      expect(declaration).toContain(`ipcRenderer.invoke(NATIVE_CREDENTIAL_IPC.${channel}`)
      expect(declaration).not.toContain('client.invoke')
      expect(declaration).not.toContain('workspaceId')
    }
  })

  it('never advertises native credential management in CHANNEL_MAP or public RPC channels', () => {
    const rpcChannels = JSON.stringify(RPC_CHANNELS)
    for (const channel of Object.values(NATIVE_CREDENTIAL_IPC)) {
      expect(Object.values(CHANNEL_MAP).some(entry => entry.channel === channel)).toBe(false)
      expect(rpcChannels).not.toContain(channel)
    }
    for (const method of Object.keys(nativeMethods)) expect(method in CHANNEL_MAP).toBe(false)
  })
})
