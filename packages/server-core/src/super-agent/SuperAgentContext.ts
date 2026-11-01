import { createHash } from 'node:crypto'

export interface SuperAgentReadQuery {
  offset?: number
  limit?: number
  id?: string
  search?: string
  view?: 'summary' | 'detail'
  contentOffset?: number
  maxChars?: number
  expectedHash?: string
}

export function recordId(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value)
  const record = value as Record<string, unknown>
  const id = record.id ?? record.slug ?? record.name ?? record.sequence
  return typeof id === 'string' || typeof id === 'number' ? String(id) : JSON.stringify(id ?? value)
}

/** Previews are explicitly incomplete. Exact fields remain in the detail API. */
export function contextPreview<T>(value: T, maxText = 500): T & { truncated?: boolean } {
  let truncated = false
  const visit = (item: unknown, depth: number): unknown => {
    if (typeof item === 'string') {
      if (item.length <= maxText) return item
      truncated = true
      return item.slice(0, maxText) + ' […]'
    }
    if (!item || typeof item !== 'object') return item
    if (depth >= 3) { truncated = true; return { detailRequired: true } }
    if (Array.isArray(item)) {
      if (item.length > 6) truncated = true
      return item.slice(0, 6).map(entry => visit(entry, depth + 1))
    }
    return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry, depth + 1)]))
  }
  const result = visit(value, 0) as T
  return (typeof result === 'object' && result !== null ? { ...result, ...(truncated ? { truncated: true } : {}) } : result) as T & { truncated?: boolean }
}

/** Bound both item count and serialized size, with lossless, versioned detail paging. */
export function readContextPage<T>(items: T[], query: SuperAgentReadQuery = {}, identity: (item: T) => string = recordId) {
  const selected = items.filter(item => (!query.id || identity(item) === query.id)
    && (!query.search || JSON.stringify(item).toLowerCase().includes(query.search.toLowerCase())))
  const offset = Math.max(0, query.offset ?? 0)
  const limit = Math.min(100, Math.max(1, query.limit ?? 20))
  const maxChars = Math.min(16_000, Math.max(256, query.maxChars ?? 8_000))
  if (query.view === 'detail') {
    if (!query.id) throw new Error('Detail queries require an exact id from the summary')
    const item = selected[0]
    if (item === undefined) return { items: [] as T[], total: 0, offset: 0, nextOffset: null }
    const content = JSON.stringify(item)
    const hash = createHash('sha256').update(content).digest('hex')
    if (query.expectedHash && query.expectedHash !== hash) throw new Error('Detail changed while paging; restart from contentOffset=0 with the current hash')
    const start = Math.min(content.length, Math.max(0, query.contentOffset ?? 0))
    if (!start && content.length <= maxChars) return { items: [item], total: 1, offset: 0, nextOffset: null, complete: true, hash }
    const end = Math.min(content.length, start + maxChars)
    return { items: [] as T[], total: 1, offset: 0, nextOffset: null, complete: end === content.length,
      detail: { id: query.id, encoding: 'json' as const, content: content.slice(start, end), contentOffset: start,
        nextContentOffset: end < content.length ? end : null, totalCharacters: content.length, hash } }
  }
  const page: Array<T & { detailRef: { id: string; view: 'detail' }; complete: boolean }> = []
  let size = 0
  for (const item of selected.slice(offset, offset + limit)) {
    const preview = contextPreview(item)
    const entry = { ...preview, detailRef: { id: identity(item), view: 'detail' as const }, complete: !preview.truncated }
    const length = JSON.stringify(entry).length
    if (page.length && size + length > maxChars) break
    page.push(length <= maxChars ? entry : { id: identity(item), truncated: true,
      detailRef: entry.detailRef, complete: false } as unknown as typeof entry)
    size += Math.min(length, maxChars)
  }
  return { items: page, total: selected.length, offset, nextOffset: offset + page.length < selected.length ? offset + page.length : null }
}
