import { createHash } from 'node:crypto'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}

/** Pi translates native path fields and removes presentation metadata before emitting events. */
export function operationInputHash(toolName: string, input: Record<string, unknown>, version?: number): string {
  if (version !== 2) return hash(JSON.stringify(input))
  const { _intent, _displayName, ...payload } = input
  if (['read', 'write', 'edit', 'glob', 'grep'].includes(toolName.toLowerCase()) && 'path' in payload) {
    payload.file_path ??= payload.path
    delete payload.path
  }
  if (toolName.toLowerCase() === 'edit') {
    const first = Array.isArray(payload.edits) ? payload.edits[0] as Record<string, unknown> | undefined : undefined
    for (const [source, target] of [['oldText', 'old_string'], ['newText', 'new_string']]) {
      if (first?.[source] != null) payload[target!] ??= first[source!]
      if (source! in payload && !(target! in payload)) { payload[target!] = payload[source!]; delete payload[source!] }
    }
  }
  return hash(canonical(payload))
}

export const operationResultHash = (toolName: string, result: string) => hash(`${toolName}\n${result}`)
