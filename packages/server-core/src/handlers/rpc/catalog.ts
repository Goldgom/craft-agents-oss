import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type {
  FeatureGuideCatalogItem,
  WorkspaceToolCatalogItem,
  WorkspaceToolCatalogResult,
} from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { getDocPath, listDocs } from '@craft-agent/shared/docs'
import { getCachedMcpSourceTools, proxyToolName } from '@craft-agent/shared/mcp'
import { loadWorkspaceSources } from '@craft-agent/shared/sources'
import { getBuiltinToolCatalog } from '@craft-agent/shared/tools'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.catalog.LIST_TOOLS,
  RPC_CHANNELS.catalog.LIST_GUIDES,
] as const

const SYSTEM_GUIDE_TAGS: Record<string, string[]> = {
  'automations.md': ['automation', 'configuration'],
  'browser-tools.md': ['tools', 'browser'],
  'craft-cli.md': ['tools', 'cli'],
  'data-tables.md': ['content', 'preview'],
  'html-preview.md': ['content', 'preview'],
  'image-preview.md': ['content', 'preview'],
  'labels.md': ['workspace', 'configuration'],
  'llm-tool.md': ['tools', 'ai'],
  'markdown-preview.md': ['content', 'preview'],
  'mermaid.md': ['content', 'diagram'],
  'pdf-preview.md': ['content', 'preview'],
  'permissions.md': ['security', 'configuration'],
  'skills.md': ['skills', 'configuration'],
  'sources.md': ['sources', 'configuration'],
  'statuses.md': ['workspace', 'configuration'],
  'themes.md': ['appearance', 'configuration'],
  'tool-icons.md': ['tools', 'appearance'],
}

export function titleFromMarkdown(content: string, filename: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  if (heading) return heading.replace(/[*_`]/g, '')
  return filename.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function summaryFromMarkdown(content: string): string {
  const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
  const paragraph = withoutFrontmatter
    .split(/\r?\n\s*\r?\n/)
    .map(part => part.trim())
    .find(part => part && !part.startsWith('#') && !part.startsWith('```') && !part.startsWith('>'))
  if (!paragraph) return ''
  return paragraph
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 240)
}

export function registerCatalogHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.catalog.LIST_TOOLS, async (_ctx, workspaceId: string): Promise<WorkspaceToolCatalogResult> => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

    const tools: WorkspaceToolCatalogItem[] = getBuiltinToolCatalog().map(tool => ({
      id: `builtin:${tool.category}:${tool.name}`,
      name: tool.name,
      description: tool.description,
      origin: 'builtin',
      category: tool.category,
      status: 'available',
    }))
    const warnings: WorkspaceToolCatalogResult['warnings'] = []
    const sources = loadWorkspaceSources(workspace.rootPath)

    for (const source of sources) {
      const { config } = source
      if (config.type === 'api') {
        // SourceServerBuilder.buildApiConfig uses the source slug as ApiConfig.name.
        const apiToolName = `api_${config.slug}`
        tools.push({
          id: `api:${config.slug}`,
          name: proxyToolName(config.slug, apiToolName),
          description: `Make authenticated requests to ${config.name}${config.api?.baseUrl ? ` (${config.api.baseUrl})` : ''}.`,
          origin: 'added',
          category: 'api',
          status: config.enabled === false ? 'disabled' : 'available',
          sourceSlug: config.slug,
          sourceName: config.name,
        })
        continue
      }
      if (config.type !== 'mcp') continue

      const sourceTools = getCachedMcpSourceTools(workspace.rootPath, config.slug)
      if (!sourceTools) {
        warnings.push({
          sourceSlug: config.slug,
          sourceName: config.name,
          message: 'Tool list is not cached yet. It will appear after this source is connected by a session.',
        })
        continue
      }
      const seenProxyNames = new Map<string, string>()
      for (const tool of sourceTools) {
        const name = proxyToolName(config.slug, tool.name)
        const existingName = seenProxyNames.get(name)
        if (existingName) {
          warnings.push({
            sourceSlug: config.slug,
            sourceName: config.name,
            message: `Tool name collision: ${existingName} and ${tool.name} both map to ${name}; only the first is available.`,
          })
          continue
        }
        seenProxyNames.set(name, tool.name)
        tools.push({
          id: `mcp:${config.slug}:${tool.name}`,
          name,
          description: tool.description || '',
          origin: 'added',
          category: 'mcp',
          status: config.enabled === false ? 'disabled' : 'available',
          sourceSlug: config.slug,
          sourceName: config.name,
        })
      }
    }

    tools.sort((a, b) => a.origin.localeCompare(b.origin) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
    warnings.sort((a, b) => a.sourceName.localeCompare(b.sourceName))
    return { tools, warnings }
  })

  server.handle(RPC_CHANNELS.catalog.LIST_GUIDES, async (_ctx, workspaceId: string): Promise<FeatureGuideCatalogItem[]> => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)

    const guides: FeatureGuideCatalogItem[] = []
    for (const filename of listDocs().sort()) {
      const path = getDocPath(filename)
      try {
        const content = readFileSync(path, 'utf-8')
        guides.push({
          id: `system:${filename}`,
          title: titleFromMarkdown(content, filename),
          filename,
          path,
          summary: summaryFromMarkdown(content),
          tags: ['system', ...(SYSTEM_GUIDE_TAGS[filename] || ['feature'])],
          scope: 'system',
          content,
        })
      } catch (error) {
        deps.platform.logger.warn(`Catalog could not read system guide ${filename}: ${error instanceof Error ? error.message : error}`)
      }
    }

    for (const source of loadWorkspaceSources(workspace.rootPath)) {
      if (!source.guide?.raw) continue
      const filename = 'guide.md'
      guides.push({
        id: `source:${source.config.slug}`,
        title: titleFromMarkdown(source.guide.raw, source.config.name),
        filename,
        path: join(source.folderPath, filename),
        summary: summaryFromMarkdown(source.guide.raw),
        tags: ['source', source.config.type, source.config.provider, source.config.slug]
          .map(tag => tag.toLowerCase())
          .filter((tag, index, all) => Boolean(tag) && all.indexOf(tag) === index),
        scope: 'source',
        content: source.guide.raw,
        sourceSlug: source.config.slug,
        sourceName: source.config.name,
      })
    }

    return guides.sort((a, b) => a.scope.localeCompare(b.scope) || a.title.localeCompare(b.title))
  })
}
