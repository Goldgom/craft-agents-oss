import { expect, test } from 'bun:test'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SecureStorageBackend } from '@craft-agent/shared/credentials/backends/secure-storage'
import { loadRemoteServerProfiles, publishRemoteServerProfiles, upsertRemoteServerProfile, getRemoteServersPath } from '@craft-agent/shared/config/remote-servers'
import { createRemoteCredentialService } from './remote-credentials'
import { nativeVaultFixture } from './__tests__/fixtures/native-vault-harness'

test('legacy vault migration persists encrypted refs with no plaintext backup and retains existing OAuth metadata', async () => {
  const fixture = nativeVaultFixture()
  const previous = process.env.TOKENBIRD_CONFIG_DIR
  process.env.TOKENBIRD_CONFIG_DIR = fixture.directory
  try {
    const legacy = new SecureStorageBackend(fixture.filePath)
    const id = { type: 'llm_oauth' as const, connectionSlug: 'dummy-llm' }
    const oauth = { value: 'dummy-llm-token', refreshToken: 'dummy-refresh', expiresAt: Date.now() + 60_000, idToken: 'dummy-identity' }
    await legacy.set(id, oauth)
    const profile = upsertRemoteServerProfile({ name: 'Dummy', url: 'wss://example.invalid', token: 'dummy-profile-token', sftp: { enabled: true, username: 'dummy-user', password: ' dummy-password ' } })
    const vault = fixture.create()
    const service = createRemoteCredentialService({ credentials: vault.backend, profiles: loadRemoteServerProfiles, publishProfiles: publishRemoteServerProfiles, workspaces: () => [], publishWorkspaces: () => {} })
    expect(vault.backend.getProtectionFormat()).toBe('legacy')
    await service.migrate()
    expect(vault.backend.getProtectionFormat()).toBe('legacy')
    expect(await vault.backend.get(id)).toEqual(oauth)
    expect((await service.resolveProfile(profile.id))?.token).toBe('dummy-profile-token')
    expect((await service.resolveProfile(profile.id))?.sftp?.password).toBe(' dummy-password ')
    await vault.backend.migrateToProtectedStorage()
    expect(await fixture.create().backend.get(id)).toEqual(oauth)
    for (const file of readdirSync(fixture.directory)) {
      const bytes = readFileSync(join(fixture.directory, file))
      for (const secret of ['dummy-profile-token', 'dummy-password', 'dummy-llm-token', 'dummy-refresh']) expect(bytes.includes(Buffer.from(secret))).toBe(false)
      expect(file.endsWith('.tmp')).toBe(false)
      expect(file === 'remote-servers.json.bak').toBe(false)
    }
  } finally {
    if (previous === undefined) delete process.env.TOKENBIRD_CONFIG_DIR; else process.env.TOKENBIRD_CONFIG_DIR = previous
    fixture.cleanup()
  }
})

test('profile publication refuses stale snapshots or unreadable/malformed records without overwriting them', () => {
  const fixture = nativeVaultFixture()
  const previous = process.env.TOKENBIRD_CONFIG_DIR
  process.env.TOKENBIRD_CONFIG_DIR = fixture.directory
  try {
    const first = upsertRemoteServerProfile({ name: 'Dummy', url: 'wss://example.invalid', token: 'dummy-token' })
    const stale = loadRemoteServerProfiles()
    upsertRemoteServerProfile({ id: first.id, name: 'Updated', url: first.url })
    expect(() => publishRemoteServerProfiles(stale, stale)).toThrow('changed')
    const path = getRemoteServersPath()
    for (const invalid of ['{broken', '[{"id":"invalid"}]']) {
      writeFileSync(path, invalid)
      expect(() => publishRemoteServerProfiles([], [])).toThrow()
      expect(readFileSync(path, 'utf8')).toBe(invalid)
    }
  } finally {
    if (previous === undefined) delete process.env.TOKENBIRD_CONFIG_DIR; else process.env.TOKENBIRD_CONFIG_DIR = previous
    fixture.cleanup()
  }
})
