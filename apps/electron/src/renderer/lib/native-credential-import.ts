import {
  NATIVE_CREDENTIAL_FIELDS,
  NATIVE_CREDENTIAL_LIMITS,
  NATIVE_CREDENTIAL_TYPES,
  type NativeCredentialApplyRequest,
  type NativeCredentialChange,
  type NativeCredentialMetadata,
  type NativeCredentialScope,
} from '@craft-agent/shared/credentials/native-types'
import type { CredentialId } from '@craft-agent/shared/credentials/types'

export type CredentialDomain = 'global' | 'llm' | 'workspace' | 'sources' | 'messaging' | 'pages' | 'connections'

export function credentialDomain(type: string): CredentialDomain {
  if (type.startsWith('llm_')) return 'llm'
  if (type.startsWith('source_')) return 'sources'
  if (type.startsWith('remote_')) return 'connections'
  if (type === 'workspace_oauth') return 'workspace'
  if (type === 'messaging_bearer') return 'messaging'
  if (type === 'page_publish_token') return 'pages'
  return 'global'
}

/** IDs only: never call this with a stored credential or arbitrary error. */
export function nativeCredentialKey(id: CredentialId): string {
  return [id.type, id.connectionSlug, id.workspaceId, id.sourceId, id.name].filter(Boolean).join('::')
}

export function credentialIdentifierFields(type: string): Array<'connectionSlug' | 'workspaceId' | 'sourceId' | 'name'> {
  switch (credentialDomain(type)) {
    case 'llm': return ['connectionSlug']
    case 'sources': return ['workspaceId', 'sourceId']
    case 'workspace': return ['workspaceId']
    case 'messaging':
    case 'pages': return ['workspaceId', 'name']
    case 'connections': return ['name']
    default: return []
  }
}

export interface NativeCredentialPreview {
  key: string
  id: CredentialId
  op: 'upsert' | 'delete'
  existing: boolean
  fields: string[]
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key))
const bytes = (value: string) => new TextEncoder().encode(value).byteLength
function invalid(): never { throw new Error('Invalid credential import') }

/** Strict local validation. Errors deliberately never include supplied text. */
export function parseNativeCredentialImport(
  text: string,
  scope: NativeCredentialScope,
  inventory: NativeCredentialMetadata[],
): NativeCredentialApplyRequest {
  if (bytes(text) > NATIVE_CREDENTIAL_LIMITS.maxRequestBytes) invalid()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { invalid() }
  if (!record(parsed) || !onlyKeys(parsed, ['changes']) || !Array.isArray(parsed.changes)
    || !parsed.changes.length || parsed.changes.length > NATIVE_CREDENTIAL_LIMITS.maxChanges) invalid()
  const known = new Set(inventory.map(entry => nativeCredentialKey(entry.id)))
  const seen = new Set<string>()
  for (const change of parsed.changes) {
    if (!record(change) || !['upsert', 'delete'].includes(String(change.op))
      || !onlyKeys(change, change.op === 'delete' ? ['op', 'id'] : ['op', 'id', 'credential'])
      || !record(change.id) || !(NATIVE_CREDENTIAL_TYPES as readonly unknown[]).includes(change.id.type)) invalid()
    const fields = credentialIdentifierFields(change.id.type as string)
    if (!onlyKeys(change.id, ['type', ...fields])) invalid()
    for (const field of fields) {
      const value = change.id[field]
      if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > NATIVE_CREDENTIAL_LIMITS.maxIdLength
        || /[\u0000-\u001f\u007f]/.test(value) || value.includes('::')) invalid()
    }
    if (fields.includes('workspaceId')) {
      const expected = String(change.id.type).startsWith('source_') ? scope.sourceWorkspaceId : scope.workspaceId
      if (!expected || change.id.workspaceId !== expected) invalid()
    }
    const key = nativeCredentialKey(change.id as unknown as CredentialId)
    if (seen.has(key)) invalid()
    seen.add(key)
    if (change.op === 'delete') continue
    if (!record(change.credential) || !Object.keys(change.credential).length
      || !onlyKeys(change.credential, NATIVE_CREDENTIAL_FIELDS)) invalid()
    if (!known.has(key) && typeof change.credential.value !== 'string') invalid()
    for (const [field, value] of Object.entries(change.credential)) {
      if (value === null && field !== 'value') continue
      if (field === 'expiresAt') {
        if (!Number.isSafeInteger(value) || (value as number) < 0) invalid()
      } else if (field === 'source') {
        if (value !== 'native' && value !== 'cli') invalid()
      } else if (typeof value !== 'string' || bytes(value) > NATIVE_CREDENTIAL_LIMITS.maxFieldBytes
        || (field === 'value' && !value.trim())) invalid()
    }
  }
  return parsed as unknown as NativeCredentialApplyRequest
}

/** Only metadata is copied into the preview; secret payloads stay separate. */
export function previewNativeCredentialChanges(changes: NativeCredentialChange[], inventory: NativeCredentialMetadata[]): NativeCredentialPreview[] {
  const known = new Set(inventory.map(entry => nativeCredentialKey(entry.id)))
  return changes.map(change => ({
    key: nativeCredentialKey(change.id), id: { ...change.id }, op: change.op,
    existing: known.has(nativeCredentialKey(change.id)),
    fields: change.op === 'upsert' ? Object.keys(change.credential) : [],
  }))
}
