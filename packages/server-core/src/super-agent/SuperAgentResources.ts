import { z } from 'zod'
import { loadAllSkills } from '@tokenbird/shared/skills'
import { isSourceUsable, loadWorkspaceSources } from '@tokenbird/shared/sources'
import { isLocalMcpEnabled } from '@tokenbird/shared/workspaces'
import type { SuperAgentConfig } from '@tokenbird/shared/super-agent'

/** Discovery contains descriptions and availability only, never credentials or launch commands. */
export interface SuperAgentResourceCatalog {
  skills: Array<{ slug: string; name: string; description: string }>
  sources: Array<{ slug: string; name: string; description: string; type: string; available: boolean; status?: string }>
}

const slug = z.string().trim().min(1).max(200)
const skillSlug = slug.refine(value => !/[\\/:\0]/.test(value) && value !== '.' && value !== '..', 'Skill must be a directory slug')

/** Additive bindings preserve user selections and other agents' resource assignments. */
export const SuperAgentResourceActionSchema = z.object({
  nodeId: z.string().trim().min(1).max(64),
  skillSlugs: z.array(skillSlug).max(100).default([]),
  sourceSlugs: z.array(slug).max(100).default([]),
  reason: z.string().trim().min(1).max(2_000),
}).strict().refine(action => action.skillSlugs.length + action.sourceSlugs.length > 0, 'Select at least one skill or source')

export type SuperAgentResourceAction = z.infer<typeof SuperAgentResourceActionSchema>

export function describeSuperAgentResources(workspaceRoot: string, config: SuperAgentConfig, skillWorkspaceRoot = workspaceRoot): SuperAgentResourceCatalog {
  const localMcpEnabled = isLocalMcpEnabled(workspaceRoot)
  return {
    skills: loadAllSkills(skillWorkspaceRoot, config.environment.workingDirectory)
      .map(skill => ({ slug: skill.slug, name: skill.metadata.name, description: skill.metadata.description.slice(0, 2_000) })),
    sources: loadWorkspaceSources(workspaceRoot).filter(source => config.sourceSlugs.includes(source.config.slug))
      .map(source => ({ slug: source.config.slug, name: source.config.name, description: (source.config.tagline ?? source.config.provider).slice(0, 2_000),
        type: source.config.type, available: isSourceUsable(source) && (source.config.mcp?.transport !== 'stdio' || localMcpEnabled),
        status: source.config.mcp?.transport === 'stdio' && !localMcpEnabled ? 'local_mcp_disabled' : source.config.connectionStatus })),
  }
}
