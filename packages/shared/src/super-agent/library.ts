import { z } from 'zod'

const id = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/)
const title = z.string().trim().min(1).max(120)
const path = z.string().trim().min(1).max(4096)
const revision = z.number().int().min(0)
const tags = z.array(z.string().trim().min(1).max(80)).max(16)

export const SuperAgentMemoryInputSchema = z.object({
  id: id.optional(), title, content: z.string().trim().min(1).max(32_000),
  category: z.enum(['preference', 'fact', 'decision', 'lesson', 'other']),
  tags: tags.default([]), evidence: z.string().max(4000).default(''),
}).strict()
export const SuperAgentMemorySchema = SuperAgentMemoryInputSchema.extend({
  id, revision: revision.min(1), createdAt: z.number().finite().min(0),
  updatedAt: z.number().finite().min(0), updatedBy: id,
})
export const SuperAgentArchiveInputSchema = z.object({
  title, sourcePath: path, description: z.string().max(4000).default(''),
  versionLabel: z.string().max(120).default(''), tags: tags.default([]),
}).strict()
export const SuperAgentArchiveSchema = SuperAgentArchiveInputSchema.extend({
  id, sourceKind: z.enum(['file', 'directory']), createdAt: z.number().finite().min(0),
  createdBy: id, taskId: id.optional(),
  directories: z.array(path).max(2000),
  files: z.array(z.object({
    path, size: z.number().int().min(0).max(64 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(2000),
})

/** Commands are also the session tool's actions; the host revalidates every input. */
export const SuperAgentLibraryCommandSchemas = [
  z.object({ type: z.literal('memory-upsert'), item: SuperAgentMemoryInputSchema, expectedRevision: revision }).strict(),
  z.object({ type: z.literal('memory-delete'), id, expectedRevision: revision.min(1) }).strict(),
  z.object({ type: z.literal('archive-create'), item: SuperAgentArchiveInputSchema }).strict(),
  z.object({ type: z.literal('archive-restore'), id, destination: path }).strict(),
] as const
export const SuperAgentLibraryRequestSchema = z.discriminatedUnion('type', [
  ...SuperAgentLibraryCommandSchemas,
  z.object({ type: z.literal('library-list'), library: z.enum(['memory', 'archive']), query: z.string().max(2000).default(''), limit: z.number().int().min(1).max(50).default(20), offset: z.number().int().min(0).default(0) }).strict(),
  z.object({ type: z.literal('library-get'), library: z.enum(['memory', 'archive']), id }).strict(),
])
export type SuperAgentMemory = z.infer<typeof SuperAgentMemorySchema>
export type SuperAgentArchive = z.infer<typeof SuperAgentArchiveSchema>
export type SuperAgentLibraryRequest = z.infer<typeof SuperAgentLibraryRequestSchema>
export type SuperAgentLibraryCommand = Exclude<SuperAgentLibraryRequest, { type: 'library-list' | 'library-get' }>

/** Deterministic keyword retrieval; do not imply semantic search or confidence scores. */
export function searchSuperAgentLibrary<T extends { id: string; title: string; tags: string[] }>(items: T[], query: string): T[] {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])]
  return items.map((item, index) => {
    const record = item as T & { content?: string; description?: string; evidence?: string; versionLabel?: string; sourcePath?: string }
    const heading = `${item.id} ${item.title} ${item.tags.join(' ')}`.toLowerCase()
    const body = `${record.content ?? ''} ${record.description ?? ''} ${record.evidence ?? ''} ${record.versionLabel ?? ''} ${record.sourcePath ?? ''}`.toLowerCase()
    const score = terms.reduce((sum, term) => sum + (heading.includes(term) ? 3 : body.includes(term) ? 1 : 0), 0)
    return { item, index, score }
  }).filter(result => !terms.length || result.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index).map(result => result.item)
}
