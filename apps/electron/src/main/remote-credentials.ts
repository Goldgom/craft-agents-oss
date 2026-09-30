/** Main-process-only remote secret resolution. Never send resolved records to a renderer. */
import { createHash, randomUUID } from 'node:crypto'
import type { RemoteServerConfig } from '@craft-agent/core/types'
import { getCredentialManager, type CredentialId, type CredentialWrite, type StoredCredential } from '@craft-agent/shared/credentials'
import {
  loadRemoteServerProfiles, prepareRemoteServerProfile, publishRemoteServerProfiles, isRemoteSecretRef,
  type RemoteServerProfile, type RemoteServerProfileInput,
} from '@craft-agent/shared/config/remote-servers'
import { getWorkspaces, publishWorkspaceRemoteServerUpdates } from '@craft-agent/shared/config'
import type { NativeManagedCredentialMetadata } from '@craft-agent/shared/credentials/native-types'

type RemoteCredentialType = 'remote_server_token' | 'remote_workspace_token' | 'remote_sftp_password' | 'remote_sftp_passphrase'
type Stub = { id: string; name: string; remoteServer?: RemoteServerConfig }
type StubUpdate = { workspaceId: string; expected: RemoteServerConfig; next: RemoteServerConfig }
export interface RemoteCredentialDependencies {
  credentials: { get(id: CredentialId): Promise<StoredCredential | null>; setMany(entries: CredentialWrite[]): Promise<void> }
  profiles(): RemoteServerProfile[]
  publishProfiles(next: RemoteServerProfile[], expected: RemoteServerProfile[]): void
  workspaces(): Stub[]
  publishWorkspaces(updates: StubUpdate[]): void
  protectionEnabled?(): boolean
}
export type ResolvedRemoteProfile = RemoteServerProfile & { profileId: string; revision: string }
export interface RemoteCredentialMigrationResult {
  migratedSecretCount: number
  migratedProfileCount: number
  migratedWorkspaceCount: number
}

const resolutionError = () => new Error('The saved remote credential is unavailable. Open Remote Servers settings to repair this connection.')
const publicationError = () => new Error('Remote credential migration or save could not finish. Existing connection snapshots are preserved; retry from Remote Servers settings.')
const profileHasReferences = (profile: RemoteServerProfile) => !!(profile.tokenRef || profile.sftp?.passwordRef || profile.sftp?.passphraseRef)
const profileHasPlaintext = (profile: RemoteServerProfile) => !!(profile.token || profile.sftp?.password || profile.sftp?.passphrase)
const clone = <T>(value: T): T => structuredClone(value)
const legacyRevisionSeeds = new Map<string, string>()
function legacyRevisionSeed(kind: string, value: unknown): string {
  const key = `${kind}:${revisionOf(value)}`
  let seed = legacyRevisionSeeds.get(key)
  if (!seed) { seed = randomUUID(); legacyRevisionSeeds.set(key, seed) }
  return seed
}
function revisionOf(value: unknown): string {
  // Legacy profiles have no revision. Main-only opaque digest detects any edit,
  // including same-millisecond token rotation, without exposing secret bytes.
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function newReference(ownerId: string): string {
  // Owner digest keeps arbitrary legacy IDs bounded without guessing identity.
  return `${createHash('sha256').update(ownerId).digest('hex').slice(0, 32)}/${randomUUID()}`
}
function originOf(url: string): string {
  try { return new URL(url).origin } catch { return 'Invalid server URL' }
}

export function createRemoteCredentialService(deps: RemoteCredentialDependencies) {
  let pending: Promise<unknown> = Promise.resolve()
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation, operation)
    pending = result.catch(() => {})
    return result
  }
  async function secret(type: RemoteCredentialType, ref: string | undefined, legacy?: string): Promise<string> {
    if (!ref) {
      if (legacy !== undefined && typeof legacy !== 'string') throw resolutionError()
      return legacy ?? ''
    }
    if (!isRemoteSecretRef(ref) || legacy) throw resolutionError()
    try {
      const stored = await deps.credentials.get({ type, name: ref })
      if (typeof stored?.value !== 'string' || !stored.value) throw resolutionError()
      return stored.value
    } catch { throw resolutionError() }
  }
  async function resolveProfileSnapshot(profile: RemoteServerProfile): Promise<ResolvedRemoteProfile> {
    const result = clone(profile) as ResolvedRemoteProfile
    result.profileId = profile.id
    const { lastConnectedAt: _lastConnectedAt, ...connectionSnapshot } = profile
    const seed = profile.revision ?? legacyRevisionSeed('profile', connectionSnapshot)
    result.token = await secret('remote_server_token', profile.tokenRef, profile.token)
    if (profile.sftp) {
      result.sftp = { ...profile.sftp,
        password: await secret('remote_sftp_password', profile.sftp.passwordRef, profile.sftp.password),
        passphrase: await secret('remote_sftp_passphrase', profile.sftp.passphraseRef, profile.sftp.passphrase),
      }
    }
    result.revision = revisionOf([seed, profile.id, profile.url, result.token, result.sftp])
    // Storage-only migration must not change effective connection identity.
    // Reference fields are not part of SFTP endpoint/auth identity.
    if (result.sftp) {
      const { passwordRef: _passwordRef, passphraseRef: _passphraseRef, ...effectiveSftp } = result.sftp
      result.revision = revisionOf([seed, profile.id, profile.url, result.token, effectiveSftp])
    }
    return result
  }
  async function resolveProfile(profileId: string): Promise<ResolvedRemoteProfile | undefined> {
    const found = deps.profiles().find(item => item.id === profileId)
    if (!found) return undefined
    const profile = clone(found)
    const resolved = await resolveProfileSnapshot(profile)
    const current = deps.profiles().find(item => item.id === profileId)
    const descriptor = (value: RemoteServerProfile) => {
      const { lastConnectedAt: _lastConnectedAt, ...rest } = value
      return JSON.stringify(rest)
    }
    if (!current || descriptor(current) !== descriptor(profile)) throw resolutionError()
    return resolved
  }
  async function resolveWorkspace(config: RemoteServerConfig): Promise<RemoteServerConfig> {
    const snapshot = clone(config)
    if (snapshot.tokenRef && snapshot.tokenRefKind !== 'profile' && snapshot.tokenRefKind !== 'workspace') throw resolutionError()
    const type = snapshot.tokenRefKind === 'profile' ? 'remote_server_token' : 'remote_workspace_token'
    const token = await secret(type, snapshot.tokenRef, snapshot.token)
    const seed = snapshot.revision ?? legacyRevisionSeed('workspace', snapshot)
    return { ...snapshot, token, revision: revisionOf([seed, snapshot.url, token, snapshot.remoteWorkspaceId, snapshot.profileId]) }
  }
  function stageProfile(profile: RemoteServerProfile, writes: CredentialWrite[], storageOnly = false): RemoteServerProfile {
    const next = clone(profile)
    const reference = newReference(profile.id)
    if (next.token) {
      if (next.tokenRef) throw resolutionError()
      writes.push({ id: { type: 'remote_server_token', name: reference }, credential: { value: next.token } })
      next.token = ''; next.tokenRef = reference
    }
    if (next.sftp?.password) {
      if (next.sftp.passwordRef) throw resolutionError()
      writes.push({ id: { type: 'remote_sftp_password', name: reference }, credential: { value: next.sftp.password } })
      delete next.sftp.password; next.sftp.passwordRef = reference
    }
    if (next.sftp?.passphrase) {
      if (next.sftp.passphraseRef) throw resolutionError()
      writes.push({ id: { type: 'remote_sftp_passphrase', name: reference }, credential: { value: next.sftp.passphrase } })
      delete next.sftp.passphrase; next.sftp.passphraseRef = reference
    }
    const { lastConnectedAt: _lastConnectedAt, ...snapshot } = profile
    next.revision = storageOnly ? profile.revision ?? legacyRevisionSeed('profile', snapshot) : profile.revision ?? randomUUID()
    return next
  }
  async function prepareWorkspace(config: RemoteServerConfig, ownerId: string = randomUUID()): Promise<RemoteServerConfig> {
    const next = clone(config)
    if (next.tokenRef) {
      // Only trusted stored metadata may retain a ref. Resolved snapshots have
      // both plaintext and a ref and must never be written back accidentally.
      if (next.token || !isRemoteSecretRef(next.tokenRef)
        || (next.tokenRefKind !== 'profile' && next.tokenRefKind !== 'workspace')) throw resolutionError()
      return next
    }
    const previous = deps.workspaces().find(workspace => workspace.id === ownerId)?.remoteServer
    if (!next.token || (!deps.protectionEnabled?.() && !previous?.tokenRef)) return next
    const reference = newReference(ownerId)
    try { await deps.credentials.setMany([{ id: { type: 'remote_workspace_token', name: reference }, credential: { value: next.token } }]) }
    catch { throw publicationError() }
    next.token = ''
    next.tokenRef = reference
    next.tokenRefKind = 'workspace'
    next.revision = randomUUID()
    // This stages only. The caller owns one atomic config publication. If it
    // fails, the old endpoint/ref stays intact and this unreferenced row remains
    // inert; never delete rows that another immutable snapshot might reference.
    return next
  }
  function hasPendingMigration(): boolean {
    return deps.profiles().some(profileHasPlaintext) || deps.workspaces().some(workspace => !!workspace.remoteServer?.token)
  }
  async function saveProfile(input: RemoteServerProfileInput): Promise<RemoteServerProfile> {
    return serialize(async () => {
      const profiles = deps.profiles()
      const existing = input.id ? profiles.find(profile => profile.id === input.id) : undefined
      if (input.id && !existing) throw new Error('Remote server profile no longer exists')
      const prepared = prepareRemoteServerProfile(input, existing)
      if (existing && prepared.url === existing.url && prepared.token === existing.token && prepared.tokenRef === existing.tokenRef
        && JSON.stringify(prepared.sftp) === JSON.stringify(existing.sftp)) {
        const { lastConnectedAt: _lastConnectedAt, ...snapshot } = existing
        prepared.revision = existing.revision ?? legacyRevisionSeed('profile', snapshot)
      }
      let next = prepared
      const writes: CredentialWrite[] = []
      // A save preserves the chosen storage mode. Only an explicit protection
      // upgrade or an already-protected profile opts future changes into refs.
      if (deps.protectionEnabled?.() || (existing && profileHasReferences(existing))) next = stageProfile(prepared, writes)
      try {
        if (writes.length) await deps.credentials.setMany(writes)
        deps.publishProfiles([...profiles.filter(profile => profile.id !== next.id), next], profiles)
      } catch { throw publicationError() }
      // No stub guessing/propagation here: another file cannot join this atomic
      // commit. Explicitly associated stubs retain their original complete pair
      // until deliberately reopened/rebound to the newly saved profile.
      return next
    })
  }
  async function migrate(): Promise<RemoteCredentialMigrationResult> {
    return serialize(async () => {
      const profiles = deps.profiles()
      const workspaces = deps.workspaces()
      const writes: CredentialWrite[] = []
      let migratedProfileCount = 0
      const nextProfiles = profiles.map(profile => {
        if (!profileHasPlaintext(profile)) return profile
        migratedProfileCount++
        return stageProfile(profile, writes, true)
      })
      const updates: StubUpdate[] = []
      for (const workspace of workspaces) {
        const remote = workspace.remoteServer
        if (!remote?.token) continue
        if (remote.tokenRef) throw resolutionError()
        const reference = newReference(workspace.id)
        // Legacy stubs are independently owned even when endpoint/token happen
        // to equal a profile. Never guess an association during migration.
        const next: RemoteServerConfig = { ...remote, token: '', tokenRef: reference, tokenRefKind: 'workspace', revision: remote.revision ?? legacyRevisionSeed('workspace', remote) }
        writes.push({ id: { type: 'remote_workspace_token', name: reference }, credential: { value: remote.token } })
        updates.push({ workspaceId: workspace.id, expected: remote, next })
      }
      try {
        if (writes.length) await deps.credentials.setMany(writes)
        // Each publication is atomic. If the second file fails, the first is
        // usable and retry skips it. Old immutable refs are never overwritten.
        if (migratedProfileCount) deps.publishProfiles(nextProfiles, profiles)
        if (updates.length) deps.publishWorkspaces(updates)
      } catch { throw publicationError() }
      return { migratedSecretCount: writes.length, migratedProfileCount, migratedWorkspaceCount: updates.length }
    })
  }
  async function listMetadata(): Promise<NativeManagedCredentialMetadata[]> {
    const results: NativeManagedCredentialMetadata[] = []
    for (const profile of deps.profiles()) {
      const fields: NativeManagedCredentialMetadata['fields'] = []
      if (profile.token || profile.tokenRef) fields.push('token')
      if (profile.sftp?.password || profile.sftp?.passwordRef) fields.push('sftp-password')
      if (profile.sftp?.passphrase || profile.sftp?.passphraseRef) fields.push('sftp-passphrase')
      if (!fields.length) continue
      const encrypted = profileHasReferences(profile)
      const plaintext = profileHasPlaintext(profile)
      results.push({ kind: 'remote-profile', id: profile.id, profileId: profile.id, name: profile.name, serverOrigin: originOf(profile.url), fields,
        protection: encrypted ? plaintext ? 'mixed' : 'encrypted-vault' : 'legacy-configuration', settingsTarget: 'remoteServers' })
    }
    for (const workspace of deps.workspaces()) {
      const remote = workspace.remoteServer
      if (!remote || (!remote.token && !remote.tokenRef)) continue
      results.push({ kind: 'remote-workspace', id: workspace.id, workspaceId: workspace.id, ...(remote.profileId ? { profileId: remote.profileId } : {}),
        name: workspace.name, serverOrigin: originOf(remote.url), fields: ['token'],
        protection: remote.tokenRef ? remote.token ? 'mixed' : 'encrypted-vault' : 'legacy-configuration', settingsTarget: 'remoteServers' })
    }
    return results
  }
  return { resolveProfile, resolveWorkspace, prepareWorkspace, saveProfile, hasPendingMigration, migrate, listMetadata }
}

let protectionEnabled = () => false
/** Bootstrap hook only; checking the mode never migrates or opens an OS prompt. */
export function configureRemoteCredentialProtection(check: () => boolean): void { protectionEnabled = check }
const service = createRemoteCredentialService({
  credentials: { get: id => getCredentialManager().get(id), setMany: entries => getCredentialManager().setMany(entries) },
  profiles: loadRemoteServerProfiles,
  publishProfiles: publishRemoteServerProfiles,
  workspaces: getWorkspaces,
  publishWorkspaces: publishWorkspaceRemoteServerUpdates,
  protectionEnabled: () => protectionEnabled(),
})
export const resolveRemoteProfile = service.resolveProfile
export const resolveRemoteWorkspace = service.resolveWorkspace
export const saveRemoteProfile = service.saveProfile
export const hasPendingRemoteCredentialMigration = service.hasPendingMigration
export const migrateRemoteCredentials = service.migrate
export const listManagedRemoteCredentialMetadata = service.listMetadata

export const prepareRemoteWorkspaceConfig = service.prepareWorkspace
