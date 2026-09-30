import type { CredentialId, StoredCredential } from './types.ts';
import { credentialIdToAccount } from './types.ts';
import { NATIVE_CREDENTIAL_FIELDS, NATIVE_CREDENTIAL_LIMITS, NATIVE_CREDENTIAL_TYPES, type NativeCredentialChange } from './native-types.ts';
import { CredentialVaultError } from './backends/vault-protection.ts';

const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const invalid = (): never => { throw new CredentialVaultError('INVALID_REQUEST'); };
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** Canonical, type-specific identifiers prevent scope aliases and ignored fields. */
export function validateNativeCredentialId(value: unknown): CredentialId {
  if (!plainObject(value) || !NATIVE_CREDENTIAL_TYPES.includes(value.type as never)) return invalid();
  const type = value.type as CredentialId['type'];
  const keys = type.startsWith('llm_') ? ['type', 'connectionSlug']
    : type.startsWith('source_') ? ['type', 'workspaceId', 'sourceId']
    : type === 'workspace_oauth' ? ['type', 'workspaceId']
    : type === 'messaging_bearer' || type === 'page_publish_token' ? ['type', 'workspaceId', 'name']
    : ['type'];
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) return invalid();
  for (const key of keys) {
    const part = value[key];
    if (typeof part !== 'string' || !part || part !== part.trim() || part.length > NATIVE_CREDENTIAL_LIMITS.maxIdLength
      || part.includes('::') || /[\u0000-\u001f\u007f]/.test(part)) return invalid();
  }
  return { ...value } as unknown as CredentialId;
}

/** Validate and detach the complete batch before any storage operation. */
export function validateNativeCredentialChanges(value: unknown): NativeCredentialChange[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > NATIVE_CREDENTIAL_LIMITS.maxChanges) return invalid();
  try { if (bytes(JSON.stringify({ changes: value })) > NATIVE_CREDENTIAL_LIMITS.maxRequestBytes) return invalid(); }
  catch { return invalid(); }
  const seen = new Set<string>();
  return value.map(entry => {
    if (!plainObject(entry) || (entry.op !== 'upsert' && entry.op !== 'delete')) return invalid();
    const allowed = entry.op === 'upsert' ? ['op', 'id', 'credential'] : ['op', 'id'];
    if (Object.keys(entry).length !== allowed.length || Object.keys(entry).some(key => !allowed.includes(key))) return invalid();
    const id = validateNativeCredentialId(entry.id);
    const account = credentialIdToAccount(id);
    if (seen.has(account)) return invalid();
    seen.add(account);
    if (entry.op === 'delete') return { op: 'delete', id };
    if (!plainObject(entry.credential) || Object.keys(entry.credential).length === 0) return invalid();
    const patch: Record<string, unknown> = {};
    for (const [field, fieldValue] of Object.entries(entry.credential)) {
      if (!NATIVE_CREDENTIAL_FIELDS.includes(field as never)) return invalid();
      if (fieldValue === null && field !== 'value') { patch[field] = null; continue; }
      if (field === 'expiresAt') {
        if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue) || fieldValue < 0) return invalid();
      } else {
        if (typeof fieldValue !== 'string' || bytes(fieldValue) > NATIVE_CREDENTIAL_LIMITS.maxFieldBytes) return invalid();
        if (field === 'value' && !fieldValue.trim()) return invalid();
        if (field === 'source' && fieldValue !== 'native' && fieldValue !== 'cli') return invalid();
      }
      patch[field] = fieldValue;
    }
    return { op: 'upsert', id, credential: patch as Partial<StoredCredential> };
  });
}
