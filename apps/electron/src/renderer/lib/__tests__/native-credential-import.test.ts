import { describe, expect, it } from 'bun:test'
import { NATIVE_CREDENTIAL_FIELDS, NATIVE_CREDENTIAL_LIMITS, NATIVE_CREDENTIAL_TYPES, type NativeCredentialMetadata, type NativeCredentialChange } from '@craft-agent/shared/credentials/native-types'
import { credentialIdentifierFields, nativeCredentialKey, parseNativeCredentialImport, previewNativeCredentialChanges } from '../native-credential-import'

const scope = { workspaceId: 'local-workspace', sourceWorkspaceId: 'local-workspace', sourceScopeUnavailable: false, includesGlobal: true, includesLlm: true } as const
const existing: NativeCredentialMetadata[] = [{ id: { type: 'llm_api_key', connectionSlug: 'provider' }, hasValue: true, presentFields: ['value', 'refreshToken'] }]
const secret = 'dummy-secret-never-in-errors'
const upsert = { op: 'upsert' as const, id: existing[0]!.id, credential: { value: secret } }
const parse = (value: unknown, inventory = existing) => parseNativeCredentialImport(JSON.stringify(value), scope, inventory)

describe('native credential import boundary', () => {
  it('accepts mixed atomic changes and preserves omitted fields / explicit clears', () => {
    const changes: NativeCredentialChange[] = [{ ...upsert, credential: { refreshToken: null, expiresAt: 1234 } }, { op: 'delete', id: { type: 'source_bearer', workspaceId: scope.workspaceId, sourceId: 'source' } }]
    expect(parse({ changes }).changes).toEqual(changes)
    expect('value' in (parse({ changes }).changes[0] as any).credential).toBe(false)
  })

  it('accepts every supported app credential domain with only its required identifiers', () => {
    const changes = NATIVE_CREDENTIAL_TYPES.map(type => ({ op: 'upsert', id: Object.fromEntries([
      ['type', type], ...credentialIdentifierFields(type).map(field => [field, field === 'workspaceId' ? scope.workspaceId : `${type}-identity`]),
    ]), credential: { value: secret } }))
    expect(parse({ changes }, []).changes.length).toBe(NATIVE_CREDENTIAL_TYPES.length)
  })

  it('previews IDs, operations and changed field names without any secret values', () => {
    const request = parse({ changes: [{ ...upsert, credential: { value: secret, clientSecret: secret, idToken: secret, awsSessionToken: secret } }] })
    const preview = previewNativeCredentialChanges(request.changes, existing)
    expect(JSON.stringify(preview)).not.toContain(secret)
    expect(preview[0]).toMatchObject({ key: 'llm_api_key::provider', existing: true, fields: ['value', 'clientSecret', 'idToken', 'awsSessionToken'] })
    expect(nativeCredentialKey(existing[0]!.id)).toBe('llm_api_key::provider')
  })

  it('rejects cross-workspace, incomplete and extraneous identifiers', () => {
    for (const id of [
      { type: 'source_bearer', workspaceId: 'other', sourceId: 'source' },
      { type: 'llm_api_key' }, { type: 'llm_api_key', connectionSlug: 'bad::scope' },
      { type: 'llm_api_key', connectionSlug: 'bad\nname' },
      { type: 'llm_api_key', connectionSlug: ' padded ' },
      { type: 'anthropic_api_key', sourceId: 'extraneous' },
      { type: 'workspace_oauth', workspaceId: scope.workspaceId, name: 'extraneous' },
      { type: 'llm_api_key', connectionSlug: 'x'.repeat(NATIVE_CREDENTIAL_LIMITS.maxIdLength + 1) },
    ]) expect(() => parse({ changes: [{ ...upsert, id }] })).toThrow('Invalid credential import')
  })

  it('rejects unknown root/change/credential fields and duplicate IDs, including upsert+delete', () => {
    for (const input of [
      { changes: [upsert], extra: secret }, { changes: [{ ...upsert, extra: secret }] },
      { changes: [{ ...upsert, credential: { value: secret, unknown: secret } }] },
      { changes: [upsert, upsert] }, { changes: [upsert, { op: 'delete', id: upsert.id }] },
      { changes: [{ op: 'delete', id: upsert.id, credential: { value: secret } }] },
    ]) expect(() => parse(input)).toThrow('Invalid credential import')
  })

  it('requires a primary value for new records and never accepts clearing the primary value', () => {
    for (const credential of [{ refreshToken: secret }, { value: '' }, { value: '  ' }, { value: null }, {}]) {
      expect(() => parse({ changes: [{ ...upsert, credential }] }, [])).toThrow('Invalid credential import')
    }
    expect(parse({ changes: [{ ...upsert, credential: { refreshToken: secret } }] }).changes).toHaveLength(1)
  })

  it('validates expiry/source/secret field types and supports explicit optional-field clearing', () => {
    for (const credential of [{ expiresAt: -1 }, { expiresAt: 1.5 }, { expiresAt: 'tomorrow' }, { source: 'unknown' }, { refreshToken: {} }, { refreshToken: 42 }]) {
      expect(() => parse({ changes: [{ ...upsert, credential }] })).toThrow('Invalid credential import')
    }
    for (const field of NATIVE_CREDENTIAL_FIELDS.filter(field => field !== 'value')) {
      expect(parse({ changes: [{ ...upsert, credential: { [field]: null } }] }).changes).toHaveLength(1)
    }
  })

  it('enforces change count, individual field and overall UTF-8 byte bounds', () => {
    expect(() => parse({ changes: [] })).toThrow()
    expect(() => parse({ changes: Array.from({ length: NATIVE_CREDENTIAL_LIMITS.maxChanges + 1 }, () => upsert) })).toThrow()
    expect(() => parse({ changes: [{ ...upsert, credential: { value: 'é'.repeat(NATIVE_CREDENTIAL_LIMITS.maxFieldBytes / 2 + 1) } }] })).toThrow()
    expect(() => parseNativeCredentialImport(' '.repeat(NATIVE_CREDENTIAL_LIMITS.maxRequestBytes + 1), scope, existing)).toThrow()
    const maximum = Array.from({ length: NATIVE_CREDENTIAL_LIMITS.maxChanges }, (_, index) => ({ ...upsert, id: { type: 'llm_api_key', connectionSlug: `provider-${index}` } }))
    expect(parse({ changes: maximum }, []).changes).toHaveLength(NATIVE_CREDENTIAL_LIMITS.maxChanges)
  })

  it('never echoes malformed secret JSON into an error', () => {
    for (const text of [`{"changes":["${secret}"]`, JSON.stringify({ changes: [{ ...upsert, credential: { unknown: secret } }] })]) {
      try { parseNativeCredentialImport(text, scope, existing); throw new Error('Expected rejection') }
      catch (error) { expect(String(error)).toBe('Error: Invalid credential import'); expect(String(error)).not.toContain(secret) }
    }
  })
})


describe('native source namespace mapping', () => {
  const aliasScope = { ...scope, workspaceId: 'registered-uuid', sourceWorkspaceId: 'directory-slug' };
  const source = { op: 'upsert', id: { type: 'source_bearer', workspaceId: 'directory-slug', sourceId: 'source' }, credential: { value: secret } };
  it('uses the main-resolved source namespace rather than registered workspace UUID', () => {
    expect(parseNativeCredentialImport(JSON.stringify({ changes: [source] }), aliasScope, []).changes).toHaveLength(1);
    expect(() => parseNativeCredentialImport(JSON.stringify({ changes: [{ ...source, id: { ...source.id, workspaceId: 'registered-uuid' } }] }), aliasScope, [])).toThrow();
  });
  it('fails a mixed batch wholly when source scope is ambiguous, while global edits remain valid', () => {
    const unavailable = { ...aliasScope, sourceWorkspaceId: null, sourceScopeUnavailable: true };
    expect(() => parseNativeCredentialImport(JSON.stringify({ changes: [upsert, source] }), unavailable, existing)).toThrow();
    expect(parseNativeCredentialImport(JSON.stringify({ changes: [upsert] }), unavailable, existing).changes).toHaveLength(1);
  });
});
