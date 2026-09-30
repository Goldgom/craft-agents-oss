import type { McpImportEntry } from './mcp-import'

export interface McpImportActions {
  create(entry: McpImportEntry): Promise<{ slug: string }>
  save(slug: string, credential: string): Promise<void>
  remove(slug: string): Promise<void>
}

/** Count a source only after its credential is committed; compensate failed saves. */
export async function importMcpEntries(entries: McpImportEntry[], existingNames: string[], actions: McpImportActions) {
  const existing = new Set(existingNames.map(name => name.trim().toLowerCase()))
  const failures: Array<{ name: string; reason: 'create' | 'credential' | 'rollback' }> = []
  let imported = 0
  let skipped = 0
  for (const entry of entries) {
    const key = entry.name.trim().toLowerCase()
    if (existing.has(key)) { skipped++; continue }
    let created: { slug: string }
    try { created = await actions.create(entry) }
    catch { failures.push({ name: entry.name, reason: 'create' }); continue }
    try {
      if (entry.credential) await actions.save(created.slug, entry.credential)
    } catch {
      try { await actions.remove(created.slug); failures.push({ name: entry.name, reason: 'credential' }) }
      catch { existing.add(key); failures.push({ name: entry.name, reason: 'rollback' }) }
      continue
    }
    existing.add(key)
    imported++
  }
  return { imported, skipped, failures }
}
