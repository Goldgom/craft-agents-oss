import type { SourceCredentialUpdate } from '@craft-agent/shared/sources'

/** Parse locally, without putting malformed secret text into error messages. */
export function parseSourceCredentialBatch(text: string): SourceCredentialUpdate[] {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('Invalid credential JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Use an object mapping source slugs to credentials')
  const entries = Object.entries(parsed)
  if (!entries.length || entries.length > 100) throw new Error('Provide between 1 and 100 credentials')
  return entries.map(([sourceSlug, value], index) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(sourceSlug)) throw new Error(`Invalid source identifier at entry ${index + 1}`)
    if (typeof value === 'string' && value.trim()) return { sourceSlug, credential: value }
    if (value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length && Object.values(value).every(item => typeof item === 'string')) {
      return { sourceSlug, credential: JSON.stringify(value) }
    }
    throw new Error(`Invalid credential at entry ${index + 1}`)
  })
}
