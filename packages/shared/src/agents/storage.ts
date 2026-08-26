import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { COMPACT_AGENT, type AgentsConfig, type CustomAgentDefinition } from './types.ts'

export const AGENTS_CONFIG_FILE = 'agents.json'

const AgentSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, numbers, and hyphens').max(64),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1000),
  prompt: z.string().trim().min(1).max(20_000),
  tools: z.array(z.string().trim().min(1)).max(100).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  builtin: z.boolean().optional(),
}).strict()
const ConfigSchema = z.object({ version: z.literal(1), agents: z.array(AgentSchema).max(100) }).strict()

export function resolveAgentsConfigPath(workspaceRoot: string): string { return join(workspaceRoot, AGENTS_CONFIG_FILE) }

function validateAgents(config: AgentsConfig): AgentsConfig {
  const parsed = ConfigSchema.parse(config)
  const ids = new Set<string>()
  for (const agent of parsed.agents) {
    if (agent.id === COMPACT_AGENT.id && agent.builtin !== true) throw new Error('"compact" is reserved for the built-in agent')
    if (agent.id !== COMPACT_AGENT.id && agent.builtin === true) throw new Error('Only the built-in "compact" agent may use the builtin marker')
    if (ids.has(agent.id)) throw new Error(`Duplicate agent id: ${agent.id}`)
    ids.add(agent.id)
  }
  return parsed
}

export async function loadAgentsConfig(workspaceRoot: string): Promise<AgentsConfig> {
  try { return validateAgents(JSON.parse(await readFile(resolveAgentsConfigPath(workspaceRoot), 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, agents: [] }; throw error }
}

export async function saveAgentsConfig(workspaceRoot: string, config: AgentsConfig): Promise<AgentsConfig> {
  const parsed = validateAgents(config)
  const path = resolveAgentsConfigPath(workspaceRoot)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return parsed
}

export async function listAgents(workspaceRoot: string): Promise<CustomAgentDefinition[]> {
  const configured = await loadAgentsConfig(workspaceRoot)
  const compactOverride = configured.agents.find(agent => agent.id === COMPACT_AGENT.id)
  const customAgents = configured.agents.filter(agent => agent.id !== COMPACT_AGENT.id)
  return [{ ...COMPACT_AGENT, ...compactOverride, builtin: true }, ...customAgents]
}

export async function loadClaudeSubagents(workspaceRoot: string): Promise<Record<string, { description: string; prompt: string; tools?: string[]; model?: string }>> {
  const config = await loadAgentsConfig(workspaceRoot)
  return Object.fromEntries(config.agents.filter(agent => agent.id !== COMPACT_AGENT.id).map(agent => [agent.id, {
    description: agent.description,
    prompt: agent.prompt,
    ...(agent.tools?.length ? { tools: agent.tools } : {}),
    ...(agent.model ? { model: agent.model } : {}),
  }]))
}
