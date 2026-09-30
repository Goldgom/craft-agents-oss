import { describe, expect, test } from 'bun:test'
import { createRemoteCredentialService, type RemoteCredentialDependencies } from './remote-credentials'
import { toProfileInfo, type RemoteServerProfile } from '@craft-agent/shared/config/remote-servers'
import { credentialIdToAccount, type StoredCredential } from '@craft-agent/shared/credentials'
import type { RemoteServerConfig } from '@craft-agent/core/types'

function fixture() {
  const profiles: RemoteServerProfile[] = [{ id: 'profile-one', name: 'Dummy', url: 'wss://example.invalid', token: 'dummy-token', createdAt: 1, updatedAt: 1,
    sftp: { enabled: true, host: 'sftp.invalid', port: 22, username: 'dummy', authMethod: 'password', password: ' dummy-password ', passphrase: ' dummy-phrase ' } }]
  const workspaces: Array<{ id: string; name: string; remoteServer: RemoteServerConfig }> = [
    { id: 'stub-one', name: 'Matching-looking but unbound', remoteServer: { url: 'wss://example.invalid', token: 'dummy-token', remoteWorkspaceId: 'remote-one' } },
    { id: 'stub-two', name: 'Another unbound stub', remoteServer: { url: 'wss://example.invalid', token: 'dummy-token', remoteWorkspaceId: 'remote-two' } },
  ]
  const secrets = new Map<string, StoredCredential>()
  const state = { protected: false, failVault: false, failProfiles: false, failWorkspaces: false, writes: 0 }
  const dependencies: RemoteCredentialDependencies = {
    credentials: {
      get: async id => secrets.get(credentialIdToAccount(id)) ?? null,
      setMany: async entries => { if (state.failVault) throw new Error('dummy-secret-error'); state.writes++; for (const entry of entries) secrets.set(credentialIdToAccount(entry.id), structuredClone(entry.credential)) },
    },
    profiles: () => structuredClone(profiles),
    publishProfiles: (next, expected) => {
      if (state.failProfiles || JSON.stringify(profiles) !== JSON.stringify(expected)) throw new Error('dummy-profile-publication-error')
      profiles.splice(0, profiles.length, ...structuredClone(next))
    },
    workspaces: () => structuredClone(workspaces),
    publishWorkspaces: updates => {
      if (state.failWorkspaces) throw new Error('dummy-workspace-publication-error')
      for (const update of updates) workspaces.find(workspace => workspace.id === update.workspaceId)!.remoteServer = structuredClone(update.next)
    },
    protectionEnabled: () => state.protected,
  }
  const service = createRemoteCredentialService(dependencies)
  return { profiles, workspaces, secrets, state, dependencies, ...service }
}

describe('revision-scoped remote credential service', () => {
  test('legacy reads and saves remain functional without implicit migration', async () => {
    const f = fixture()
    expect((await f.resolveProfile('profile-one'))?.token).toBe('dummy-token')
    expect((await f.resolveProfile('profile-one'))?.sftp?.password).toBe(' dummy-password ')
    await f.saveProfile({ id: 'profile-one', name: 'Renamed', url: 'wss://example.invalid' })
    expect(f.profiles[0]!.token).toBe('dummy-token')
    expect(f.profiles[0]!.sftp?.password).toBe(' dummy-password ')
    expect(f.state.writes).toBe(0)
  })
  test('explicit migration encrypts profiles and distinct unmatched stubs without guessing associations', async () => {
    const f = fixture()
    expect(await f.migrate()).toEqual({ migratedSecretCount: 5, migratedProfileCount: 1, migratedWorkspaceCount: 2 })
    expect(f.hasPendingMigration()).toBe(false)
    expect(JSON.stringify([f.profiles, f.workspaces])).not.toContain('dummy-token')
    expect(JSON.stringify([f.profiles, f.workspaces])).not.toContain('dummy-password')
    expect(f.workspaces[0]!.remoteServer.tokenRef).not.toBe(f.workspaces[1]!.remoteServer.tokenRef)
    expect(f.workspaces[0]!.remoteServer.profileId).toBeUndefined()
    expect((await f.resolveProfile('profile-one'))?.sftp?.passphrase).toBe(' dummy-phrase ')
    expect((await f.resolveWorkspace(f.workspaces[0]!.remoteServer)).token).toBe('dummy-token')
    expect(await f.migrate()).toEqual({ migratedSecretCount: 0, migratedProfileCount: 0, migratedWorkspaceCount: 0 })
  })
  test('failed vault staging leaves all original configs unchanged', async () => {
    const f = fixture(); const before = JSON.stringify([f.profiles, f.workspaces]); f.state.failVault = true
    await expect(f.migrate()).rejects.toThrow('snapshots are preserved')
    expect(JSON.stringify([f.profiles, f.workspaces])).toBe(before)
  })
  test('failed profile publication preserves the complete old endpoint and old token', async () => {
    const f = fixture(); await f.migrate(); const before = structuredClone(f.profiles[0]!); f.state.failProfiles = true
    await expect(f.saveProfile({ id: before.id, name: 'New', url: 'wss://new.invalid', token: 'dummy-new-token' })).rejects.toThrow('snapshots are preserved')
    expect(f.profiles[0]).toEqual(before)
    const resolved = await f.resolveProfile(before.id)
    expect(resolved?.url).toBe('wss://example.invalid'); expect(resolved?.token).toBe('dummy-token')
    expect([...f.secrets.values()].some(value => value.value === 'dummy-new-token')).toBe(true)
  })
  test('partial migration preserves functional old/new pairs and retry completes remaining stubs', async () => {
    const f = fixture(); f.state.failWorkspaces = true
    await expect(f.migrate()).rejects.toThrow('snapshots are preserved')
    expect(f.profiles[0]!.tokenRef).toBeDefined(); expect(f.workspaces[0]!.remoteServer.token).toBe('dummy-token')
    expect((await f.resolveProfile('profile-one'))?.token).toBe('dummy-token')
    expect((await f.resolveWorkspace(f.workspaces[0]!.remoteServer)).token).toBe('dummy-token')
    f.state.failWorkspaces = false
    expect(await f.migrate()).toEqual({ migratedSecretCount: 2, migratedProfileCount: 0, migratedWorkspaceCount: 2 })
  })
  test('successful rotation writes new immutable refs and old stub snapshots remain valid', async () => {
    const f = fixture(); await f.migrate(); const old = structuredClone(f.profiles[0]!)
    const bound: RemoteServerConfig = { url: old.url, token: '', tokenRef: old.tokenRef, tokenRefKind: 'profile', profileId: old.id, remoteWorkspaceId: 'remote-bound' }
    await f.saveProfile({ id: old.id, name: 'New', url: 'wss://new.invalid', token: 'dummy-new-token', sftp: { enabled: true, password: ' new-password ' } })
    expect(f.profiles[0]!.tokenRef).not.toBe(old.tokenRef)
    expect((await f.resolveWorkspace(bound)).token).toBe('dummy-token')
    expect((await f.resolveProfile(old.id))?.token).toBe('dummy-new-token')
    expect((await f.resolveProfile(old.id))?.sftp?.password).toBe(' new-password ')
  })
  test('missing or ambiguous references fail closed without legacy fallback', async () => {
    const f = fixture(); await f.migrate(); f.secrets.clear()
    await expect(f.resolveProfile('profile-one')).rejects.toThrow('unavailable')
    await expect(f.resolveWorkspace(f.workspaces[0]!.remoteServer)).rejects.toThrow('unavailable')
    f.profiles[0]!.token = 'dummy-fallback'
    await expect(f.resolveProfile('profile-one')).rejects.toThrow('unavailable')
  })
  test('metadata exposes no secrets, reference IDs, or URL credentials', async () => {
    const f = fixture(); f.profiles[0]!.url = 'wss://dummy-user:dummy-url-password@example.invalid/path?key=dummy-query#dummy-fragment'
    await f.migrate()
    const metadata = await f.listMetadata(); const serialized = JSON.stringify(metadata)
    for (const value of ['dummy-token', 'dummy-password', 'dummy-phrase', 'dummy-url-password', 'dummy-query', 'dummy-fragment', f.profiles[0]!.tokenRef!]) expect(serialized).not.toContain(value)
    expect(metadata).toHaveLength(3); expect(metadata[0]!.serverOrigin).toBe('wss://example.invalid')
    expect(toProfileInfo(f.profiles[0]!).hasToken).toBe(true)
    expect(toProfileInfo(f.profiles[0]!).sftp?.hasPassword).toBe(true)
  })
  test('once native protection is selected, new saves use references with no plaintext config publication', async () => {
    const f = fixture(); f.state.protected = true
    const created = await f.saveProfile({ name: 'New', url: 'wss://new.invalid', token: 'dummy-new-token' })
    expect(created.token).toBe(''); expect(created.tokenRef).toBeDefined()
    expect((await f.resolveProfile(created.id))?.token).toBe('dummy-new-token')
  })
})

test('ad-hoc workspace preparation respects legacy mode, then stages immutable encrypted metadata before publication', async () => {
  const f = fixture()
  const input: RemoteServerConfig = { url: 'wss://new.invalid', token: 'dummy-ad-hoc-token', remoteWorkspaceId: 'remote-new' }
  expect(await f.prepareWorkspace(input, 'new-owner')).toEqual(input)
  expect(f.state.writes).toBe(0)
  f.state.protected = true
  const prepared = await f.prepareWorkspace(input, 'new-owner')
  expect(prepared.token).toBe(''); expect(prepared.tokenRefKind).toBe('workspace')
  expect(input.token).toBe('dummy-ad-hoc-token')
  expect((await f.resolveWorkspace(prepared)).token).toBe('dummy-ad-hoc-token')
  expect(f.workspaces.some(workspace => workspace.id === 'new-owner')).toBe(false)
})

test('failed ad-hoc publication cannot change the previous workspace endpoint or credential', async () => {
  const f = fixture(); await f.migrate()
  const old = structuredClone(f.workspaces[0]!.remoteServer)
  // A protected existing workspace remains protected even in a legacy-format vault.
  const prepared = await f.prepareWorkspace({ url: 'wss://new.invalid', token: 'dummy-replacement', remoteWorkspaceId: old.remoteWorkspaceId }, 'stub-one')
  expect(prepared.tokenRef).not.toBe(old.tokenRef)
  // Simulated caller publication failure: nothing replaces the old snapshot.
  expect(f.workspaces[0]!.remoteServer).toEqual(old)
  expect((await f.resolveWorkspace(old)).token).toBe('dummy-token')
  expect((await f.resolveWorkspace(prepared)).token).toBe('dummy-replacement')
  await expect(f.prepareWorkspace({ ...old, token: 'dummy-accidentally-resolved' }, 'stub-one')).rejects.toThrow('unavailable')
})

test('optional storage migration preserves the identity of already-open profile and workspace connections', async () => {
  const f = fixture()
  const profileBefore = await f.resolveProfile('profile-one')
  const workspaceBefore = await f.resolveWorkspace(f.workspaces[0]!.remoteServer)
  await f.migrate()
  expect((await f.resolveProfile('profile-one'))?.revision).toBe(profileBefore?.revision)
  expect((await f.resolveWorkspace(f.workspaces[0]!.remoteServer)).revision).toBe(workspaceBefore.revision)
  await f.saveProfile({ id: 'profile-one', name: 'Dummy', url: 'wss://example.invalid', token: 'dummy-rotated' })
  expect((await f.resolveProfile('profile-one'))?.revision).not.toBe(profileBefore?.revision)
})

test('display-name edits and last-connected timestamps do not invalidate a live connection identity', async () => {
  const f = fixture(); const before = (await f.resolveProfile('profile-one'))!.revision
  await f.saveProfile({ id: 'profile-one', name: 'New display name', url: f.profiles[0]!.url })
  f.profiles[0]!.lastConnectedAt = Date.now()
  expect((await f.resolveProfile('profile-one'))!.revision).toBe(before)
})

for (const change of ['edit', 'delete', 'connected'] as const) test(`resolution checks descriptor after secret reads: ${change}`, async () => {
  const f = fixture(); await f.migrate()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  const get = f.dependencies.credentials.get
  f.dependencies.credentials.get = async id => { entered(); await gate; return get(id) }
  const result = f.resolveProfile('profile-one').then(value => ({ value }), () => ({ rejected: true }))
  await ready
  if (change === 'edit') f.profiles[0]!.url = 'wss://changed.invalid'
  else if (change === 'delete') f.profiles.splice(0)
  else f.profiles[0]!.lastConnectedAt = 123
  release()
  const outcome = await result
  if (change === 'connected') expect('value' in outcome).toBe(true)
  else expect(outcome).toEqual({ rejected: true })
})
